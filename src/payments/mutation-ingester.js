/**
 * Mutation Ingester
 *
 * Ingests and normalizes mutations from various providers.
 * Handles deduplication and data normalization.
 */

const { sha256, hashIdentifier } = require('../utils/crypto');
const { maskName, parseDate } = require('../utils/validation');

/**
 * Create mutation ingester
 *
 * @param {Object} options - Configuration options
 * @param {Object} options.db - Database instance
 * @param {Object} options.config - Config getter
 * @returns {Object} Ingester functions
 */
function createMutationIngester(options = {}) {
  const { db, config } = options;

  if (!db) {
    throw new Error('Mutation ingester requires database instance');
  }

  const hashPepper = config?.get?.('hashPepper') || config?.hashPepper || '';

  // Prepared statements
  const findByHashStmt = db.prepare(`
    SELECT id FROM incoming_mutations WHERE content_hash = ?
  `);

  const findByProviderIdStmt = db.prepare(`
    SELECT id FROM incoming_mutations
    WHERE provider = ? AND provider_mutation_id = ?
  `);

  const insertMutationStmt = db.prepare(`
    INSERT INTO incoming_mutations (
      provider, provider_mutation_id, content_hash,
      direction, amount, status, transacted_at,
      payer_name_masked, payer_id_hash, note_masked
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateMutationStmt = db.prepare(`
    UPDATE incoming_mutations
    SET status = ?, matched_order_id = ?, matched_at = datetime('now')
    WHERE id = ?
  `);

  /**
   * Normalize mutation data from various formats
   *
   * @param {Object} raw - Raw mutation data
   * @param {string} provider - Provider name
   * @returns {Object} Normalized mutation
   */
  function normalizeMutation(raw, provider) {
    // Determine direction
    let direction = 'IN';
    if (raw.direction) {
      direction = raw.direction.toUpperCase();
    } else if (raw.type === 'DEBIT' || raw.type === 'OUT') {
      direction = 'OUT';
    }

    // Determine status
    let status = 'SUCCESS';
    if (raw.status) {
      const s = raw.status.toUpperCase();
      if (s === 'PENDING' || s === 'ON_HOLD') {
        status = 'PENDING';
      } else if (s === 'FAILED' || s === 'REJECTED' || s === 'CANCELLED') {
        status = 'FAILED';
      }
    } else if (raw.isPending) {
      status = 'PENDING';
    }

    // Parse amount
    const amount = Math.round(parseFloat(raw.amount || raw.nominal || 0));

    // Parse date
    const transactedAt = parseDate(
      raw.transactedAt ||
      raw.transacted_at ||
      raw.transactionDate ||
      raw.date ||
      raw.timestamp
    );

    // Hash payer ID for matching
    const payerIdHash = raw.payerId || raw.senderId || raw.accountNumber
      ? hashIdentifier('payer', raw.payerId || raw.senderId || raw.accountNumber, hashPepper)
      : null;

    // Mask sensitive data
    const payerNameMasked = raw.payerName || raw.senderName
      ? maskName(raw.payerName || raw.senderName)
      : null;

    const noteMasked = raw.note || raw.description || raw.keterangan
      ? String(raw.note || raw.description || raw.keterangan).substring(0, 100)
      : null;

    return {
      provider: provider || raw.provider || 'default',
      providerMutationId: raw.providerMutationId || raw.id || raw.transactionId || null,
      direction,
      amount,
      status,
      transactedAt: transactedAt ? transactedAt.toISOString() : new Date().toISOString(),
      payerName: raw.payerName || raw.senderName || null,
      payerIdHash,
      note: noteMasked,
      raw: raw // Keep raw for debugging
    };
  }

  /**
   * Generate content hash for deduplication
   *
   * @param {Object} mutation - Normalized mutation
   * @returns {string} Content hash
   */
  function generateContentHash(mutation) {
    const data = {
      provider: mutation.provider,
      providerMutationId: mutation.providerMutationId || '',
      amount: mutation.amount,
      direction: mutation.direction,
      transactedAt: mutation.transactedAt,
      note: mutation.note || ''
    };
    return sha256(JSON.stringify(data));
  }

  /**
   * Check if mutation is duplicate
   *
   * @param {Object} mutation - Normalized mutation
   * @returns {{ duplicate: boolean, existingId?: number }}
   */
  function isDuplicate(mutation) {
    // Check by content hash
    if (mutation.contentHash) {
      const byHash = findByHashStmt.get(mutation.contentHash);
      if (byHash) {
        return { duplicate: true, existingId: byHash.id };
      }
    }

    // Check by provider + providerMutationId
    if (mutation.providerMutationId) {
      const byProvider = findByProviderIdStmt.get(
        mutation.provider,
        mutation.providerMutationId
      );
      if (byProvider) {
        return { duplicate: true, existingId: byProvider.id };
      }
    }

    return { duplicate: false };
  }

  /**
   * Ingest a single mutation
   *
   * @param {Object} raw - Raw mutation data
   * @param {string} [provider] - Provider name
   * @returns {{ success: boolean, mutation?: Object, duplicate?: boolean, error?: string }}
   */
  function ingestMutation(raw, provider = 'default') {
    // Normalize
    const mutation = normalizeMutation(raw, provider);

    // Generate content hash
    mutation.contentHash = generateContentHash(mutation);

    // Check for duplicate
    const duplicateCheck = isDuplicate(mutation);
    if (duplicateCheck.duplicate) {
      return {
        success: true,
        duplicate: true,
        existingId: duplicateCheck.existingId
      };
    }

    // Insert
    try {
      const result = insertMutationStmt.run(
        mutation.provider,
        mutation.providerMutationId,
        mutation.contentHash,
        mutation.direction,
        mutation.amount,
        mutation.status,
        mutation.transactedAt,
        mutation.payerNameMasked,
        mutation.payerIdHash,
        mutation.noteMasked
      );

      return {
        success: true,
        duplicate: false,
        mutation: {
          id: result.lastInsertRowid,
          ...mutation
        }
      };
    } catch (error) {
      // Race condition on duplicate
      if (error.code === 'SQLITE_CONSTRAINT') {
        return {
          success: true,
          duplicate: true
        };
      }
      console.error('Failed to ingest mutation:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Ingest batch of mutations
   *
   * @param {Object[]} raws - Raw mutations
   * @param {string} [provider] - Provider name
   * @returns {Object} Batch results
   */
  function ingestBatch(raws, provider = 'default') {
    const results = {
      total: raws.length,
      inserted: 0,
      duplicates: 0,
      failed: 0,
      mutations: []
    };

    // Use transaction for batch
    const transaction = db.transaction(() => {
      for (const raw of raws) {
        const result = ingestMutation(raw, provider);

        if (result.success) {
          if (result.duplicate) {
            results.duplicates++;
          } else {
            results.inserted++;
            if (result.mutation) {
              results.mutations.push(result.mutation);
            }
          }
        } else {
          results.failed++;
        }
      }
    });

    try {
      transaction();
    } catch (error) {
      console.error('Batch ingest failed:', error);
      results.error = error.message;
    }

    return results;
  }

  /**
   * Get unmatched mutations for processing
   *
   * @param {Object} options - Query options
   * @returns {Object[]}
   */
  function getUnmatchedMutations(options = {}) {
    const { limit = 100, minAmount = 0, maxAgeHours = 24 } = options;

    const minDate = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString();

    const stmt = db.prepare(`
      SELECT * FROM incoming_mutations
      WHERE matched_order_id IS NULL
        AND direction = 'IN'
        AND status = 'SUCCESS'
        AND amount >= ?
        AND transacted_at >= ?
      ORDER BY transacted_at DESC
      LIMIT ?
    `);

    return stmt.all(minAmount, minDate, limit);
  }

  /**
   * Mark mutation as matched
   *
   * @param {number} mutationId - Mutation ID
   * @param {string} merchantOrderId - Matched order ID
   * @returns {{ success: boolean }}
   */
  function markAsMatched(mutationId, merchantOrderId) {
    const result = updateMutationStmt.run('SUCCESS', merchantOrderId, mutationId);
    return { success: result.changes > 0 };
  }

  /**
   * Get mutation statistics
   *
   * @param {number} [hours=24] - Time window
   * @returns {Object}
   */
  function getStats(hours = 24) {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

    const stats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN matched_order_id IS NOT NULL THEN 1 ELSE 0 END) as matched,
        SUM(CASE WHEN direction = 'IN' AND matched_order_id IS NULL THEN 1 ELSE 0 END) as unmatched,
        SUM(amount) as total_amount,
        AVG(amount) as avg_amount
      FROM incoming_mutations
      WHERE received_at >= ? AND direction = 'IN'
    `).get(since);

    return {
      ...stats,
      avgAmount: Math.round(stats.avg_amount || 0),
      hours
    };
  }

  return {
    normalizeMutation,
    generateContentHash,
    isDuplicate,
    ingestMutation,
    ingestBatch,
    getUnmatchedMutations,
    markAsMatched,
    getStats
  };
}

module.exports = {
  createMutationIngester
};
