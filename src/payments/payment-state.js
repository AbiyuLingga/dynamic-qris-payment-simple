/**
 * Payment State Machine
 *
 * Handles payment status transitions and reconciliation.
 * Implements idempotent operations for safe retries.
 */

const { isValidStatusTransition } = require('../utils/validation');
const { generateMerchantOrderId } = require('../utils/crypto');

/**
 * Payment statuses
 */
const PaymentStatus = {
  PENDING: 'PENDING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED'
};

/**
 * Reconciliation sources
 */
const ReconciliationSource = {
  WEBHOOK: 'webhook',
  AUTO_VERIFY: 'auto_verify',
  ADMIN: 'admin',
  MANUAL: 'manual'
};

/**
 * Create payment state machine
 *
 * @param {Object} options - Configuration options
 * @param {Object} options.db - Database instance
 * @param {Object} options.config - Config getter
 * @param {Object} [options.hooks] - Callback hooks
 * @returns {Object} State machine functions
 */
function createPaymentState(options = {}) {
  const { db, config, hooks = {} } = options;

  if (!db) {
    throw new Error('Payment state requires database instance');
  }

  // Prepared statements
  const findByOrderIdStmt = db.prepare(`
    SELECT * FROM payments WHERE merchant_order_id = ?
  `);

  const findByIdempotencyStmt = db.prepare(`
    SELECT * FROM payments WHERE idempotency_key_hash = ?
  `);

  const insertPaymentStmt = db.prepare(`
    INSERT INTO payments (
      merchant_order_id, reference_id, description, email, name, metadata,
      qris_base_amount, qris_suffix, qris_full_amount, qris_dynamic_string,
      qris_image_data_url, status, expires_at, idempotency_key_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateStatusStmt = db.prepare(`
    UPDATE payments
    SET status = ?, paid_at = CASE WHEN ? = 'SUCCESS' THEN datetime('now') ELSE paid_at END,
        reconciled_via = ?, reconciled_by = ?, updated_at = CURRENT_TIMESTAMP
    WHERE merchant_order_id = ? AND status = ?
  `);

  const logReconciliationStmt = db.prepare(`
    INSERT INTO payment_reconciliation_log (merchant_order_id, action, actor_id, source, details)
    VALUES (?, ?, ?, ?, ?)
  `);

  /**
   * Create a new payment
   *
   * @param {Object} paymentData - Payment data
   * @returns {{ success: boolean, payment?: Object, error?: string, idempotent?: boolean }}
   */
  function createPayment(paymentData) {
    const {
      amount,
      suffix,
      description,
      email,
      name,
      referenceId,
      metadata,
      idempotencyKey,
      idempotencyKeyHash,
      qrData,
      expiresAt
    } = paymentData;

    const merchantOrderId = generateMerchantOrderId(referenceId);
    const fullAmount = amount + suffix;

    // Check idempotency
    if (idempotencyKeyHash) {
      const existing = findByIdempotencyStmt.get(idempotencyKeyHash);
      if (existing) {
        return {
          success: true,
          payment: existing,
          idempotent: true
        };
      }
    }

    // Insert payment
    try {
      insertPaymentStmt.run(
        merchantOrderId,
        referenceId || '',
        description,
        email,
        name || '',
        JSON.stringify(metadata || {}),
        amount,
        suffix,
        fullAmount,
        qrData.qrString || '',
        qrData.qrImageDataUrl || '',
        PaymentStatus.PENDING,
        expiresAt,
        idempotencyKeyHash || null
      );

      // Get created payment
      const payment = findByOrderIdStmt.get(merchantOrderId);

      return {
        success: true,
        payment
      };
    } catch (error) {
      console.error('Failed to create payment:', error);
      return {
        success: false,
        error: 'Failed to create payment'
      };
    }
  }

  /**
   * Mark payment as successful
   *
   * @param {Object} params - Parameters
   * @param {string} params.merchantOrderId - Order ID
   * @param {string} [params.source='auto_verify'] - Reconciliation source
   * @param {string} [params.actorId] - Actor who triggered
   * @param {Object} [params.details] - Additional details
   * @returns {{ success: boolean, alreadyProcessed?: boolean, error?: string }}
   */
  function markPaymentSuccess(params) {
    const {
      merchantOrderId,
      source = ReconciliationSource.AUTO_VERIFY,
      actorId = null,
      details = null
    } = params;

    const payment = findByOrderIdStmt.get(merchantOrderId);

    if (!payment) {
      return { success: false, error: 'Payment not found' };
    }

    // Already processed
    if (payment.status === PaymentStatus.SUCCESS) {
      return { success: true, alreadyProcessed: true };
    }

    // Check valid transition
    if (!isValidStatusTransition(payment.status, PaymentStatus.SUCCESS)) {
      return {
        success: false,
        error: `Cannot transition from ${payment.status} to SUCCESS`
      };
    }

    // Update status (idempotent - only updates if current status is PENDING)
    const result = updateStatusStmt.run(
      PaymentStatus.SUCCESS,
      PaymentStatus.SUCCESS,
      source,
      actorId,
      merchantOrderId,
      PaymentStatus.PENDING
    );

    if (result.changes === 0) {
      // Status already changed by another process
      return { success: true, alreadyProcessed: true };
    }

    // Log reconciliation
    logReconciliationStmt.run(
      merchantOrderId,
      'mark_success',
      actorId,
      source,
      JSON.stringify(details || {})
    );

    // Trigger hook
    if (hooks.onPaymentSuccess) {
      setImmediate(async () => {
        try {
          await hooks.onPaymentSuccess(db, payment);
        } catch (error) {
          console.error('onPaymentSuccess hook error:', error);
        }
      });
    }

    return { success: true };
  }

  /**
   * Mark payment as failed
   *
   * @param {Object} params - Parameters
   * @returns {{ success: boolean, alreadyProcessed?: boolean, error?: string }}
   */
  function markPaymentFailed(params) {
    const {
      merchantOrderId,
      source = ReconciliationSource.AUTO_VERIFY,
      actorId = null,
      reason = 'Payment failed'
    } = params;

    const payment = findByOrderIdStmt.get(merchantOrderId);

    if (!payment) {
      return { success: false, error: 'Payment not found' };
    }

    if (payment.status !== PaymentStatus.PENDING) {
      return { success: true, alreadyProcessed: true };
    }

    // Update status
    const result = updateStatusStmt.run(
      PaymentStatus.FAILED,
      PaymentStatus.FAILED,
      source,
      actorId,
      merchantOrderId,
      PaymentStatus.PENDING
    );

    if (result.changes === 0) {
      return { success: true, alreadyProcessed: true };
    }

    // Log reconciliation
    logReconciliationStmt.run(
      merchantOrderId,
      'mark_failed',
      actorId,
      source,
      JSON.stringify({ reason })
    );

    // Trigger hook
    if (hooks.onPaymentFailed) {
      setImmediate(async () => {
        try {
          await hooks.onPaymentFailed(db, payment, reason);
        } catch (error) {
          console.error('onPaymentFailed hook error:', error);
        }
      });
    }

    return { success: true };
  }

  /**
   * Mark payment as expired
   *
   * @param {string} merchantOrderId - Order ID
   * @returns {{ success: boolean }}
   */
  function markPaymentExpired(merchantOrderId) {
    const payment = findByOrderIdStmt.get(merchantOrderId);

    if (!payment || payment.status !== PaymentStatus.PENDING) {
      return { success: false };
    }

    const result = updateStatusStmt.run(
      PaymentStatus.EXPIRED,
      PaymentStatus.EXPIRED,
      ReconciliationSource.MANUAL,
      'system',
      merchantOrderId,
      PaymentStatus.PENDING
    );

    if (result.changes > 0) {
      logReconciliationStmt.run(
        merchantOrderId,
        'mark_expired',
        'system',
        ReconciliationSource.MANUAL,
        JSON.stringify({})
      );

      if (hooks.onPaymentExpired) {
        setImmediate(async () => {
          try {
            await hooks.onPaymentExpired(db, payment);
          } catch (error) {
            console.error('onPaymentExpired hook error:', error);
          }
        });
      }
    }

    return { success: result.changes > 0 };
  }

  /**
   * Get payment by order ID
   *
   * @param {string} merchantOrderId - Order ID
   * @returns {Object|null}
   */
  function getPayment(merchantOrderId) {
    return findByOrderIdStmt.get(merchantOrderId);
  }

  /**
   * Get payments with filters
   *
   * @param {Object} filters - Filter options
   * @returns {Object[]} Payments
   */
  function getPayments(filters = {}) {
    const { status, email, limit = 50, offset = 0 } = filters;

    let query = 'SELECT * FROM payments WHERE 1=1';
    const params = [];

    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }

    if (email) {
      query += ' AND email = ?';
      params.push(email);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const stmt = db.prepare(query);
    return stmt.all(...params);
  }

  /**
   * Get reconciliation log for payment
   *
   * @param {string} merchantOrderId - Order ID
   * @returns {Object[]} Log entries
   */
  function getReconciliationLog(merchantOrderId) {
    const stmt = db.prepare(`
      SELECT * FROM payment_reconciliation_log
      WHERE merchant_order_id = ?
      ORDER BY created_at DESC
    `);
    return stmt.all(merchantOrderId);
  }

  /**
   * Get dashboard statistics
   *
   * @param {number} [hours=24] - Time window in hours
   * @returns {Object} Statistics
   */
  function getStats(hours = 24) {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

    const stats = {
      total: 0,
      pending: 0,
      success: 0,
      failed: 0,
      expired: 0,
      totalAmount: 0,
      successAmount: 0
    };

    // Total counts
    const counts = db.prepare(`
      SELECT status, COUNT(*) as count, SUM(qris_full_amount) as amount
      FROM payments
      WHERE created_at >= ?
      GROUP BY status
    `).all(since);

    for (const row of counts) {
      stats[row.status.toLowerCase()] = row.count;
      stats.total += row.count;
      if (row.status === 'SUCCESS') {
        stats.successAmount = row.amount || 0;
      }
    }

    return stats;
  }

  return {
    // Status constants
    PaymentStatus,
    ReconciliationSource,

    // Operations
    createPayment,
    markPaymentSuccess,
    markPaymentFailed,
    markPaymentExpired,
    getPayment,
    getPayments,
    getReconciliationLog,
    getStats
  };
}

module.exports = {
  createPaymentState,
  PaymentStatus,
  ReconciliationSource
};
