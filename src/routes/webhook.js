/**
 * Webhook Routes
 *
 * Webhook endpoints for external integrations:
 * - POST /webhook/verify - QRIS payment verification webhook
 * - POST /webhook/mutation - Manual mutation push
 * - POST /webhook/batch - Batch mutation push
 */

const express = require('express');
const { createHmacValidator, verifyWebhookSignature } = require('../middleware/hmac-validator');
const { success, unauthorized, validationError, serverError } = require('../utils/response');

/**
 * Create webhook router
 *
 * @param {Object} options - Configuration options
 * @param {Object} options.db - Database instance
 * @param {Object} options.config - Config getter
 * @param {Object} options.paymentState - Payment state machine
 * @param {Object} options.mutationIngester - Mutation ingester
 * @param {Object} options.mutationMatcher - Mutation matcher
 * @param {Object} options.broadcaster - SSE broadcaster
 * @param {Object} [options.hooks] - Callback hooks
 * @returns {Router} Express router
 */
function createWebhookRouter(options = {}) {
  const {
    db,
    config,
    paymentState,
    mutationIngester,
    mutationMatcher,
    broadcaster,
    hooks = {}
  } = options;

  if (!db) throw new Error('Webhook router requires db');
  if (!config) throw new Error('Webhook router requires config');
  if (!paymentState) throw new Error('Webhook router requires paymentState');
  if (!mutationIngester) throw new Error('Webhook router requires mutationIngester');
  if (!mutationMatcher) throw new Error('Webhook router requires mutationMatcher');
  if (!broadcaster) throw new Error('Webhook router requires broadcaster');

  const router = express.Router();

  const webhookSecret = config.get('webhookSecret');
  const hashPepper = config.get('hashPepper');

  // HMAC validator for webhooks
  const validateWebhook = createHmacValidator({
    secret: webhookSecret,
    maxAgeMs: 5 * 60 * 1000 // 5 minutes
  });

  // Prepared statements
  const checkWebhookEvent = db.prepare(`
    SELECT id FROM payment_webhook_events WHERE event_hash = ?
  `);

  const insertWebhookEvent = db.prepare(`
    INSERT INTO payment_webhook_events (provider, event_id, event_hash, merchant_order_id, processed_status)
    VALUES (?, ?, ?, ?, ?)
  `);

  /**
   * Generate webhook event hash
   */
  function generateEventHash(eventId, body) {
    const crypto = require('crypto');
    const data = `${eventId || 'unknown'}.${JSON.stringify(body)}`;
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Check and record webhook event (idempotency)
   */
  function checkWebhookIdempotency(eventId, body, provider, merchantOrderId) {
    const eventHash = generateEventHash(eventId, body);

    const existing = checkWebhookEvent.get(eventHash);
    if (existing) {
      return { duplicate: true, eventHash };
    }

    try {
      insertWebhookEvent.run(provider, eventId, eventHash, merchantOrderId || '', 'PROCESSED');
    } catch (error) {
      // Race condition - already processed
      if (error.code === 'SQLITE_CONSTRAINT') {
        return { duplicate: true, eventHash };
      }
      throw error;
    }

    return { duplicate: false, eventHash };
  }

  /**
   * POST /webhook/verify
   * QRIS payment verification webhook
   *
   * This endpoint receives notifications from QRIS provider
   * when a payment has been completed.
   */
  router.post('/verify', validateWebhook, async (req, res) => {
    try {
      const { event_id, merchant_order_id, amount, status, timestamp } = req.body;

      // Check idempotency
      const idempotency = checkWebhookIdempotency(event_id, req.body, 'qris_provider', merchant_order_id);
      if (idempotency.duplicate) {
        return success(res, { message: 'Event already processed', duplicate: true });
      }

      // Validate required fields
      if (!merchant_order_id) {
        return validationError(res, ['merchant_order_id is required']);
      }

      // Get payment
      const payment = paymentState.getPayment(merchant_order_id);

      if (!payment) {
        // Payment not found - might be for different system
        return success(res, { message: 'Payment not found', ignored: true });
      }

      // Process based on status
      if (status === 'SUCCESS' || status === 'PAID') {
        const result = paymentState.markPaymentSuccess({
          merchantOrderId: merchant_order_id,
          source: 'webhook',
          details: {
            eventId: event_id,
            providerStatus: status,
            webhookTimestamp: timestamp
          }
        });

        if (result.success && !result.alreadyProcessed) {
          // Broadcast update
          broadcaster.broadcast(merchant_order_id, {
            event: 'payment_success',
            source: 'webhook',
            merchantOrderId: merchant_order_id,
            timestamp: new Date().toISOString()
          });
        }

        return success(res, {
          message: 'Payment processed',
          status: 'SUCCESS'
        });

      } else if (status === 'FAILED' || status === 'EXPIRED') {
        paymentState.markPaymentFailed({
          merchantOrderId: merchant_order_id,
          source: 'webhook',
          reason: `Webhook: ${status}`
        });

        return success(res, {
          message: 'Payment marked as failed',
          status: 'FAILED'
        });
      }

      return success(res, {
        message: 'Event received',
        status: status
      });

    } catch (error) {
      console.error('Webhook verify error:', error);
      return serverError(res);
    }
  });

  /**
   * POST /webhook/mutation
   * Receive a single mutation notification
   *
   * This can be used by external systems to push mutation data
   * directly instead of relying on the collector.
   */
  router.post('/mutation', validateWebhook, async (req, res) => {
    try {
      const mutation = req.body;

      // Validate required fields
      if (!mutation.amount || !mutation.transactedAt) {
        return validationError(res, ['amount and transactedAt are required']);
      }

      // Ingest mutation
      const ingestResult = mutationIngester.ingestMutation(mutation, 'webhook');

      if (!ingestResult.success) {
        return serverError(res, 'Failed to process mutation');
      }

      if (ingestResult.duplicate) {
        return success(res, { message: 'Mutation already processed', duplicate: true });
      }

      // Try to match
      if (ingestResult.mutation) {
        const matchResult = mutationMatcher.processMatch(ingestResult.mutation);

        if (matchResult.matched) {
          // Mark payment as success
          paymentState.markPaymentSuccess({
            merchantOrderId: matchResult.merchantOrderId,
            source: 'webhook',
            details: {
              mutationId: ingestResult.mutation.id,
              confidence: matchResult.confidence
            }
          });

          // Broadcast
          broadcaster.broadcast(matchResult.merchantOrderId, {
            event: 'payment_success',
            source: 'webhook',
            merchantOrderId: matchResult.merchantOrderId,
            timestamp: new Date().toISOString()
          });

          return success(res, {
            message: 'Mutation matched and payment processed',
            merchantOrderId: matchResult.merchantOrderId,
            confidence: matchResult.confidence
          });
        }

        return success(res, {
          message: 'Mutation ingested',
          matched: false,
          mutationId: ingestResult.mutation.id
        });
      }

      return success(res, { message: 'Mutation received' });

    } catch (error) {
      console.error('Webhook mutation error:', error);
      return serverError(res);
    }
  });

  /**
   * POST /webhook/batch
   * Receive batch of mutations
   *
   * More efficient for bulk mutation updates.
   */
  router.post('/batch', validateWebhook, async (req, res) => {
    try {
      const { mutations } = req.body;

      if (!Array.isArray(mutations) || mutations.length === 0) {
        return validationError(res, ['mutations array is required']);
      }

      if (mutations.length > 1000) {
        return validationError(res, ['Maximum 1000 mutations per batch']);
      }

      // Ingest batch
      const ingestResult = mutationIngester.ingestBatch(mutations, 'webhook');

      const results = {
        ingested: ingestResult.inserted,
        duplicates: ingestResult.duplicates,
        failed: ingestResult.failed,
        matched: 0
      };

      // Match ingested mutations
      if (ingestResult.mutations.length > 0) {
        for (const mutation of ingestResult.mutations) {
          const matchResult = mutationMatcher.processMatch(mutation);

          if (matchResult.matched) {
            results.matched++;

            paymentState.markPaymentSuccess({
              merchantOrderId: matchResult.merchantOrderId,
              source: 'webhook',
              details: { mutationId: mutation.id }
            });

            broadcaster.broadcast(matchResult.merchantOrderId, {
              event: 'payment_success',
              source: 'webhook',
              merchantOrderId: matchResult.merchantOrderId,
              timestamp: new Date().toISOString()
            });
          }
        }
      }

      return success(res, results);

    } catch (error) {
      console.error('Webhook batch error:', error);
      return serverError(res);
    }
  });

  /**
   * GET /webhook/health
   * Webhook endpoint health check
   */
  router.get('/health', (req, res) => {
    return success(res, {
      status: 'healthy',
      webhookSecretConfigured: !!webhookSecret,
      timestamp: new Date().toISOString()
    });
  });

  return router;
}

module.exports = {
  createWebhookRouter
};
