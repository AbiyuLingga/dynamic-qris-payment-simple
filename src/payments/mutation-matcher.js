/**
 * Mutation Matcher
 *
 * Matches incoming payment mutations with pending payments.
 * Uses confidence scoring for ambiguous matches.
 */

const { sha256, hashIdentifier } = require('../utils/crypto');
const { maskName } = require('../utils/validation');

/**
 * Match confidence levels
 */
const ConfidenceLevel = {
  EXACT: 'EXACT',           // 100% - Amount + suffix match
  HIGH: 'HIGH',             // 80-99% - Amount match
  MEDIUM: 'MEDIUM',         // 50-79% - Partial match
  LOW: 'LOW',               // 20-49% - Possible match
  NONE: 'NONE'              // <20% - No match
};

/**
 * Create mutation matcher
 *
 * @param {Object} options - Configuration options
 * @param {Object} options.db - Database instance
 * @param {Object} [options.config] - Config getter
 * @param {Object} [options.hooks] - Callback hooks
 * @returns {Object} Matcher functions
 */
function createMutationMatcher(options = {}) {
  const { db, config, hooks = {} } = options;

  if (!db) {
    throw new Error('Mutation matcher requires database instance');
  }

  // Prepared statements
  const findPendingByAmountStmt = db.prepare(`
    SELECT merchant_order_id, qris_base_amount, qris_suffix, qris_full_amount,
           email, name, expires_at, created_at
    FROM payments
    WHERE status = 'PENDING'
      AND qris_full_amount = ?
      AND datetime(expires_at) > datetime('now')
    ORDER BY created_at ASC
  `);

  const findPendingByBaseAmountStmt = db.prepare(`
    SELECT merchant_order_id, qris_base_amount, qris_suffix, qris_full_amount,
           email, name, expires_at, created_at
    FROM payments
    WHERE status = 'PENDING'
      AND qris_base_amount = ?
      AND datetime(expires_at) > datetime('now')
    ORDER BY created_at ASC
  `);

  const updateMutationMatchStmt = db.prepare(`
    UPDATE incoming_mutations
    SET matched_order_id = ?, matched_at = datetime('now')
    WHERE id = ?
  `);

  const queueAmbiguousStmt = db.prepare(`
    INSERT INTO payment_ambiguous_queue (
      mutation_id, merchant_order_id, confidence_score,
      transacted_at, amount, payer_name_masked
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  /**
   * Calculate match confidence
   *
   * @param {Object} mutation - Mutation data
   * @param {Object} payment - Payment data
   * @returns {number} Confidence score 0-100
   */
  function calculateConfidence(mutation, payment) {
    let score = 0;
    const details = [];

    // Exact full amount match (including suffix) - 50 points
    if (mutation.amount === payment.qris_full_amount) {
      score += 50;
      details.push('exact_amount');
    }
    // Base amount match - 30 points
    else if (mutation.amount === payment.qris_base_amount) {
      score += 30;
      details.push('base_amount');
    }
    // Amount within range of base +/- suffix - 20 points
    else if (mutation.amount >= payment.qris_base_amount &&
             mutation.amount <= payment.qris_base_amount + 999) {
      score += 20;
      details.push('within_suffix_range');
    }

    // Timing: Recent mutation for recent payment - 20 points
    const mutationTime = new Date(mutation.transactedAt).getTime();
    const paymentExpiry = new Date(payment.expires_at).getTime();
    const paymentCreated = new Date(payment.created_at).getTime();

    if (mutationTime >= paymentCreated && mutationTime <= paymentExpiry) {
      score += 20;
      details.push('valid_time_window');

      // Within 5 minutes of payment creation - 10 bonus
      if (mutationTime - paymentCreated < 5 * 60 * 1000) {
        score += 10;
        details.push('quick_match');
      }
    }

    // Email domain match - 10 points
    if (payment.email) {
      const emailDomain = payment.email.split('@')[1];
      if (emailDomain) {
        score += 10;
        details.push('has_email');
      }
    }

    // Cap at 100
    return Math.min(score, 100);
  }

  /**
   * Determine confidence level from score
   *
   * @param {number} score - Confidence score
   * @returns {string} Confidence level
   */
  function getConfidenceLevel(score) {
    if (score >= 100) return ConfidenceLevel.EXACT;
    if (score >= 80) return ConfidenceLevel.HIGH;
    if (score >= 50) return ConfidenceLevel.MEDIUM;
    if (score >= 20) return ConfidenceLevel.LOW;
    return ConfidenceLevel.NONE;
  }

  /**
   * Match a single mutation against pending payments
   *
   * @param {Object} mutation - Mutation data
   * @returns {{ matched: boolean, candidates?: Object[], bestMatch?: Object }}
   */
  function matchMutation(mutation) {
    // First try exact full amount match
    const exactMatches = findPendingByAmountStmt.all(mutation.amount);

    if (exactMatches.length === 1) {
      const bestMatch = exactMatches[0];
      const confidence = calculateConfidence(mutation, bestMatch);

      return {
        matched: confidence >= 80,
        confidence,
        confidenceLevel: getConfidenceLevel(confidence),
        candidates: [{ ...bestMatch, confidence }],
        bestMatch: confidence >= 80 ? bestMatch : null
      };
    }

    // Try base amount match
    const baseMatches = findPendingByBaseAmountStmt.all(mutation.amount);

    if (baseMatches.length === 1) {
      const bestMatch = baseMatches[0];
      const confidence = calculateConfidence(mutation, bestMatch);

      return {
        matched: confidence >= 80,
        confidence,
        confidenceLevel: getConfidenceLevel(confidence),
        candidates: [{ ...bestMatch, confidence }],
        bestMatch: confidence >= 80 ? bestMatch : null
      };
    }

    // Multiple candidates - need confidence scoring
    if (exactMatches.length > 1 || baseMatches.length > 1) {
      const candidates = (exactMatches.length > 0 ? exactMatches : baseMatches)
        .map(payment => ({
          ...payment,
          confidence: calculateConfidence(mutation, payment)
        }))
        .sort((a, b) => b.confidence - a.confidence);

      const bestMatch = candidates[0];
      const bestLevel = getConfidenceLevel(bestMatch.confidence);

      // If best match is high confidence, use it
      if (bestLevel === ConfidenceLevel.EXACT || bestLevel === ConfidenceLevel.HIGH) {
        return {
          matched: true,
          confidence: bestMatch.confidence,
          confidenceLevel: bestLevel,
          candidates,
          bestMatch
        };
      }

      // Medium or low - queue for review
      return {
        matched: false,
        confidence: bestMatch.confidence,
        confidenceLevel: bestLevel,
        candidates,
        bestMatch: null
      };
    }

    // No candidates found
    return {
      matched: false,
      candidates: [],
      bestMatch: null,
      confidence: 0,
      confidenceLevel: ConfidenceLevel.NONE
    };
  }

  /**
   * Process and match a mutation
   *
   * @param {Object} mutation - Mutation with id
   * @returns {{ success: boolean, result: Object }}
   */
  function processMatch(mutation) {
    const matchResult = matchMutation(mutation);

    if (matchResult.matched && matchResult.bestMatch) {
      // Update mutation with match
      updateMutationMatchStmt.run(
        matchResult.bestMatch.merchant_order_id,
        mutation.id
      );

      return {
        success: true,
        matched: true,
        merchantOrderId: matchResult.bestMatch.merchant_order_id,
        confidence: matchResult.confidence,
        level: matchResult.confidenceLevel
      };
    }

    // Queue for ambiguous review
    if (matchResult.candidates.length > 0 && matchResult.confidence > 0) {
      const bestCandidate = matchResult.candidates[0];

      queueAmbiguousStmt.run(
        mutation.id,
        bestCandidate.merchant_order_id,
        bestCandidate.confidence,
        mutation.transactedAt || new Date().toISOString(),
        mutation.amount,
        mutation.payerName ? maskName(mutation.payerName) : null
      );

      // Trigger ambiguous match hook
      if (hooks.onAmbiguousMatch) {
        setImmediate(async () => {
          try {
            await hooks.onAmbiguousMatch(db, mutation, matchResult.candidates);
          } catch (error) {
            console.error('onAmbiguousMatch hook error:', error);
          }
        });
      }

      return {
        success: true,
        matched: false,
        queued: true,
        candidates: matchResult.candidates.length,
        confidence: matchResult.confidence,
        level: matchResult.confidenceLevel
      };
    }

    return {
      success: true,
      matched: false,
      noCandidates: true
    };
  }

  /**
   * Batch match mutations
   *
   * @param {Object[]} mutations - Mutations to match
   * @returns {Object} Batch results
   */
  function batchMatch(mutations) {
    const results = {
      total: mutations.length,
      matched: 0,
      queued: 0,
      unmatched: 0,
      details: []
    };

    for (const mutation of mutations) {
      const result = processMatch(mutation);

      if (result.matched) {
        results.matched++;
      } else if (result.queued) {
        results.queued++;
      } else {
        results.unmatched++;
      }

      results.details.push({
        mutationId: mutation.id,
        ...result
      });
    }

    return results;
  }

  /**
   * Get unresolved ambiguous matches
   *
   * @param {number} [limit=50] - Max results
   * @returns {Object[]}
   */
  function getAmbiguousQueue(limit = 50) {
    const stmt = db.prepare(`
      SELECT aq.*, im.provider, im.direction, im.status as mutation_status,
             im.provider_mutation_id, im.content_hash,
             p.email, p.description as payment_description
      FROM payment_ambiguous_queue aq
      JOIN incoming_mutations im ON aq.mutation_id = im.id
      JOIN payments p ON aq.merchant_order_id = p.merchant_order_id
      WHERE aq.resolved_at IS NULL
      ORDER BY aq.confidence_score DESC, aq.created_at ASC
      LIMIT ?
    `);

    return stmt.all(limit);
  }

  /**
   * Resolve an ambiguous match manually
   *
   * @param {Object} params - Resolution parameters
   * @returns {{ success: boolean }}
   */
  function resolveAmbiguous(params) {
    const { mutationId, merchantOrderId, actorId, resolution, resolutionDetails } = params;

    // Update ambiguous queue
    const updateStmt = db.prepare(`
      UPDATE payment_ambiguous_queue
      SET resolved_at = datetime('now'),
          resolved_by = ?,
          resolution = ?,
          resolution_details = ?
      WHERE mutation_id = ? AND resolved_at IS NULL
    `);

    const result = updateStmt.run(
      actorId || 'admin',
      resolution,
      JSON.stringify(resolutionDetails || {}),
      mutationId
    );

    if (result.changes > 0) {
      // If resolved as matched, update mutation
      if (resolution === 'matched' && merchantOrderId) {
        updateMutationMatchStmt.run(merchantOrderId, mutationId);
      }
    }

    return { success: result.changes > 0 };
  }

  return {
    // Constants
    ConfidenceLevel,

    // Functions
    calculateConfidence,
    getConfidenceLevel,
    matchMutation,
    processMatch,
    batchMatch,
    getAmbiguousQueue,
    resolveAmbiguous
  };
}

module.exports = {
  createMutationMatcher,
  ConfidenceLevel
};
