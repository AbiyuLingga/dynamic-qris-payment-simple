/**
 * Payment Routes
 *
 * Main payment API endpoints:
 * - POST /create - Create new payment
 * - GET /status/:id - Check payment status
 * - GET /stream/:id - SSE stream for real-time updates
 * - GET /config - Gateway configuration
 * - GET /invoices - Payment history
 */

const express = require('express');
const rateLimit = require('express-rate-limit');

const { sha256, hashIdentifier } = require('../utils/crypto');
const { validatePaymentCreateRequest, normalizeAmount } = require('../utils/validation');
const { success, created, validationError, notFound, conflict, serverError } = require('../utils/response');

/**
 * Create payment router
 *
 * @param {Object} options - Configuration options
 * @param {Object} options.db - Database instance
 * @param {Object} options.config - Config getter
 * @param {Object} options.qrisGenerator - QRIS generator
 * @param {Object} options.suffixAllocator - Suffix allocator
 * @param {Object} options.paymentState - Payment state machine
 * @param {Object} options.broadcaster - SSE broadcaster
 * @returns {Router} Express router
 */
function createPaymentRouter(options = {}) {
  const {
    db,
    config,
    qrisGenerator,
    suffixAllocator,
    paymentState,
    broadcaster
  } = options;

  if (!db) throw new Error('Payment router requires db');
  if (!config) throw new Error('Payment router requires config');
  if (!qrisGenerator) throw new Error('Payment router requires qrisGenerator');
  if (!suffixAllocator) throw new Error('Payment router requires suffixAllocator');
  if (!paymentState) throw new Error('Payment router requires paymentState');
  if (!broadcaster) throw new Error('Payment router requires broadcaster');

  const router = express.Router();

  // Rate limiter for create endpoint
  const createLimiter = rateLimit({
    windowMs: config.get('rateLimitWindowMs') || 60000,
    max: config.get('rateLimitMaxRequests') || 5,
    message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
    standardHeaders: true,
    legacyHeaders: false
  });

  // Prepared statements
  const findPaymentByOrderId = db.prepare(`
    SELECT * FROM payments WHERE merchant_order_id = ?
  `);

  const findPaymentByIdempotency = db.prepare(`
    SELECT * FROM payments WHERE idempotency_key_hash = ?
  `);

  const checkIdempotencyExpiry = db.prepare(`
    DELETE FROM payment_idempotency_keys WHERE expires_at < datetime('now')
  `);

  const insertIdempotencyKey = db.prepare(`
    INSERT INTO payment_idempotency_keys (key_hash, merchant_order_id, expires_at)
    VALUES (?, ?, datetime('now', '+24 hours'))
  `);

  /**
   * POST /api/payment/create
   * Create a new payment
   */
  router.post('/create', createLimiter, async (req, res) => {
    try {
      // Validate request
      const validation = validatePaymentCreateRequest(req.body);
      if (!validation.valid) {
        return validationError(res, validation.errors);
      }

      const { amount, description, email, name, referenceId, metadata, idempotencyKey } = req.body;
      const normalizedAmount = normalizeAmount(amount);

      // Check idempotency
      let idempotencyKeyHash = null;
      if (idempotencyKey) {
        idempotencyKeyHash = sha256(idempotencyKey);

        // Clean expired keys
        checkIdempotencyExpiry.run();

        // Check for existing
        const existing = findPaymentByIdempotency.get(idempotencyKeyHash);
        if (existing) {
          // Return existing payment
          return success(res, {
            payment: formatPaymentResponse(existing),
            idempotent: true
          });
        }
      }

      // Allocate suffix
      const allocation = suffixAllocator.allocate(normalizedAmount, `TEMP-${Date.now()}`);

      if (!allocation.success) {
        return serverError(res, 'Failed to allocate payment ID. Please try again.');
      }

      const { suffix, fullAmount } = allocation;
      const expiresAt = new Date(Date.now() + (config.get('qrisExpiryMinutes') || 20) * 60 * 1000);

      // Generate QRIS
      const qrData = await qrisGenerator.generatePaymentQr(fullAmount);

      // Create payment
      const createResult = paymentState.createPayment({
        amount: normalizedAmount,
        suffix,
        description,
        email,
        name,
        referenceId,
        metadata,
        idempotencyKeyHash,
        qrData,
        expiresAt: expiresAt.toISOString()
      });

      if (!createResult.success) {
        // Release suffix on failure
        suffixAllocator.release(normalizedAmount, suffix, createResult.payment?.merchant_order_id);
        return serverError(res, 'Failed to create payment');
      }

      const payment = createResult.payment;

      // Store idempotency key
      if (idempotencyKey) {
        try {
          insertIdempotencyKey.run(idempotencyKeyHash, payment.merchant_order_id);
        } catch (error) {
          // Non-fatal - payment was created
          console.error('Failed to store idempotency key:', error);
        }
      }

      return created(res, {
        payment: formatPaymentResponse(payment)
      });

    } catch (error) {
      console.error('Create payment error:', error);
      return serverError(res, 'Failed to create payment');
    }
  });

  /**
   * GET /api/payment/status/:merchantOrderId
   * Get payment status
   */
  router.get('/status/:merchantOrderId', async (req, res) => {
    try {
      const { merchantOrderId } = req.params;

      const payment = paymentState.getPayment(merchantOrderId);

      if (!payment) {
        return notFound(res, 'Payment not found');
      }

      return success(res, {
        payment: formatPaymentResponse(payment)
      });

    } catch (error) {
      console.error('Get status error:', error);
      return serverError(res);
    }
  });

  /**
   * GET /api/payment/stream/:merchantOrderId
   * SSE stream for real-time updates
   */
  router.get('/stream/:merchantOrderId', (req, res) => {
    const { merchantOrderId } = req.params;

    // Verify payment exists
    const payment = paymentState.getPayment(merchantOrderId);
    if (!payment) {
      return notFound(res, 'Payment not found');
    }

    // Create SSE stream
    const stream = broadcaster.createSseStream(merchantOrderId, req, res);

    if (stream.error) {
      return conflict(res, stream.error === 'max_connections_per_order'
        ? 'Maximum connections reached for this payment'
        : 'Maximum connections per user reached'
      );
    }

    // Connection will be cleaned up when client disconnects
    req.on('close', () => {
      stream.unsubscribe();
    });

    // If payment already completed, send immediate update
    if (payment.status !== 'PENDING') {
      broadcaster.broadcast(merchantOrderId, {
        event: 'payment_already_' + payment.status.toLowerCase(),
        merchantOrderId,
        status: payment.status,
        timestamp: new Date().toISOString()
      });
    }

    // Don't send response headers - SSE handles this
  });

  /**
   * GET /api/payment/config
   * Get gateway configuration (public info only)
   */
  router.get('/config', (req, res) => {
    return success(res, {
      expiryMinutes: config.get('qrisExpiryMinutes') || 20,
      minAmount: 100,
      currency: 'IDR',
      supportedMethods: ['QRIS']
    });
  });

  /**
   * GET /api/payment/invoices
   * Get payment history for an email
   */
  router.get('/invoices', async (req, res) => {
    try {
      const { email, limit = 20, offset = 0 } = req.query;

      if (!email) {
        return validationError(res, ['Email is required']);
      }

      const payments = paymentState.getPayments({
        email,
        limit: Math.min(parseInt(limit) || 20, 100),
        offset: parseInt(offset) || 0
      });

      return success(res, {
        payments: payments.map(formatPaymentResponse),
        pagination: {
          limit: parseInt(limit),
          offset: parseInt(offset),
          count: payments.length
        }
      });

    } catch (error) {
      console.error('Get invoices error:', error);
      return serverError(res);
    }
  });

  /**
   * Format payment for API response
   */
  function formatPaymentResponse(payment) {
    return {
      merchantOrderId: payment.merchant_order_id,
      referenceId: payment.reference_id,
      description: payment.description,
      email: payment.email,
      name: payment.name,
      amount: payment.qris_base_amount,
      suffix: payment.qris_suffix,
      fullAmount: payment.qris_full_amount,
      qrString: payment.qris_dynamic_string,
      qrImageDataUrl: payment.qris_image_data_url,
      status: payment.status,
      expiresAt: payment.expires_at,
      paidAt: payment.paid_at,
      createdAt: payment.created_at,
      metadata: payment.metadata ? JSON.parse(payment.metadata) : {}
    };
  }

  return router;
}

module.exports = {
  createPaymentRouter
};
