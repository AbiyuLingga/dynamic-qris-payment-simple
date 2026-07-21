/**
 * Admin Payment Routes
 *
 * Admin management endpoints:
 * - GET /admin/list - List payments
 * - GET /admin/pending - List pending payments
 * - POST /admin/:id/mark-paid - Mark as paid
 * - POST /admin/:id/mark-failed - Mark as failed
 * - GET /admin/:id/audit - Audit log
 * - GET /admin/dashboard - Dashboard stats
 * - GET /admin/ambiguous - Ambiguous matches
 */

const express = require('express');
const rateLimit = require('express-rate-limit');

const { success, notFound, serverError, forbidden } = require('../utils/response');

/**
 * Create admin router
 *
 * @param {Object} options - Configuration options
 * @param {Object} options.db - Database instance
 * @param {Object} options.config - Config getter
 * @param {Object} options.paymentState - Payment state machine
 * @param {Object} options.mutationMatcher - Mutation matcher
 * @param {Object} options.hooks - Callback hooks
 * @returns {Router} Express router
 */
function createAdminRouter(options = {}) {
  const {
    db,
    config,
    paymentState,
    mutationMatcher,
    hooks = {}
  } = options;

  if (!db) throw new Error('Admin router requires db');
  if (!config) throw new Error('Admin router requires config');
  if (!paymentState) throw new Error('Admin router requires paymentState');
  if (!mutationMatcher) throw new Error('Admin router requires mutationMatcher');

  const router = express.Router();

  // Rate limiters for sensitive operations
  const markPaidLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 10,
    message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } }
  });

  const bulkLimitLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 5,
    message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } }
  });

  /**
   * Check admin authorization
   */
  function checkAdmin(req, res, next) {
    // Use custom hook or default to session check
    if (hooks.authorizeAdmin) {
      const isAuthorized = hooks.authorizeAdmin(req);
      if (!isAuthorized) {
        return forbidden(res, 'Admin access required');
      }
    } else if (req.session?.user?.role !== 'admin') {
      return forbidden(res, 'Admin access required');
    }
    next();
  }

  // Apply admin check to all routes
  router.use(checkAdmin);

  /**
   * GET /admin/list
   * List all payments with filters
   */
  router.get('/list', (req, res) => {
    try {
      const { status, email, limit = 50, offset = 0 } = req.query;

      const payments = paymentState.getPayments({
        status,
        email,
        limit: Math.min(parseInt(limit) || 50, 200),
        offset: parseInt(offset) || 0
      });

      return success(res, {
        payments: payments.map(formatPayment),
        pagination: {
          limit: parseInt(limit),
          offset: parseInt(offset),
          count: payments.length
        }
      });

    } catch (error) {
      console.error('Admin list error:', error);
      return serverError(res);
    }
  });

  /**
   * GET /admin/pending
   * List pending payments
   */
  router.get('/pending', (req, res) => {
    try {
      const { limit = 100, offset = 0 } = req.query;

      const payments = paymentState.getPayments({
        status: 'PENDING',
        limit: Math.min(parseInt(limit) || 100, 500),
        offset: parseInt(offset) || 0
      });

      return success(res, {
        payments: payments.map(formatPayment),
        count: payments.length
      });

    } catch (error) {
      console.error('Admin pending error:', error);
      return serverError(res);
    }
  });

  /**
   * POST /admin/:merchantOrderId/mark-paid
   * Mark payment as paid manually
   */
  router.post('/:merchantOrderId/mark-paid', markPaidLimiter, (req, res) => {
    try {
      const { merchantOrderId } = req.params;
      const { reason } = req.body;

      const result = paymentState.markPaymentSuccess({
        merchantOrderId,
        source: 'admin',
        actorId: req.session?.user?.id || 'admin',
        details: { reason }
      });

      if (!result.success) {
        return notFound(res, result.error || 'Payment not found');
      }

      if (result.alreadyProcessed) {
        return success(res, {
          message: 'Payment was already processed',
          alreadyProcessed: true
        });
      }

      return success(res, {
        message: 'Payment marked as paid',
        merchantOrderId
      });

    } catch (error) {
      console.error('Admin mark-paid error:', error);
      return serverError(res);
    }
  });

  /**
   * POST /admin/:merchantOrderId/mark-failed
   * Mark payment as failed
   */
  router.post('/:merchantOrderId/mark-failed', markPaidLimiter, (req, res) => {
    try {
      const { merchantOrderId } = req.params;
      const { reason } = req.body;

      const result = paymentState.markPaymentFailed({
        merchantOrderId,
        source: 'admin',
        actorId: req.session?.user?.id || 'admin',
        reason: reason || 'Manually marked as failed'
      });

      if (!result.success) {
        return notFound(res, result.error || 'Payment not found');
      }

      return success(res, {
        message: 'Payment marked as failed',
        merchantOrderId
      });

    } catch (error) {
      console.error('Admin mark-failed error:', error);
      return serverError(res);
    }
  });

  /**
   * POST /admin/:merchantOrderId/expire
   * Expire a pending payment
   */
  router.post('/:merchantOrderId/expire', markPaidLimiter, (req, res) => {
    try {
      const { merchantOrderId } = req.params;

      const result = paymentState.markPaymentExpired(merchantOrderId);

      if (!result.success) {
        return notFound(res, 'Payment not found or not pending');
      }

      return success(res, {
        message: 'Payment expired',
        merchantOrderId
      });

    } catch (error) {
      console.error('Admin expire error:', error);
      return serverError(res);
    }
  });

  /**
   * GET /admin/:merchantOrderId/audit
   * Get reconciliation audit log
   */
  router.get('/:merchantOrderId/audit', (req, res) => {
    try {
      const { merchantOrderId } = req.params;

      const payment = paymentState.getPayment(merchantOrderId);
      if (!payment) {
        return notFound(res, 'Payment not found');
      }

      const log = paymentState.getReconciliationLog(merchantOrderId);

      return success(res, {
        payment: formatPayment(payment),
        auditLog: log
      });

    } catch (error) {
      console.error('Admin audit error:', error);
      return serverError(res);
    }
  });

  /**
   * GET /admin/dashboard
   * Dashboard statistics
   */
  router.get('/dashboard', (req, res) => {
    try {
      const { hours = 24 } = req.query;

      const stats = paymentState.getStats(parseInt(hours) || 24);

      // Get additional stats
      const dbStats = db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM payments WHERE status = 'PENDING') as pendingCount,
          (SELECT COUNT(*) FROM incoming_mutations WHERE matched_order_id IS NULL) as unmatchedMutations,
          (SELECT COUNT(*) FROM payment_ambiguous_queue WHERE resolved_at IS NULL) as ambiguousCount
      `).get();

      return success(res, {
        period: `${hours} hours`,
        payments: stats,
        additional: dbStats
      });

    } catch (error) {
      console.error('Admin dashboard error:', error);
      return serverError(res);
    }
  });

  /**
   * GET /admin/ambiguous
   * List unresolved ambiguous matches
   */
  router.get('/ambiguous', (req, res) => {
    try {
      const { limit = 50 } = req.query;

      const queue = mutationMatcher.getAmbiguousQueue(parseInt(limit) || 50);

      return success(res, {
        queue,
        count: queue.length
      });

    } catch (error) {
      console.error('Admin ambiguous error:', error);
      return serverError(res);
    }
  });

  /**
   * POST /admin/ambiguous/:mutationId/resolve
   * Resolve an ambiguous match
   */
  router.post('/ambiguous/:mutationId/resolve', (req, res) => {
    try {
      const { mutationId } = req.params;
      const { merchantOrderId, resolution, details } = req.body;

      if (!resolution || !['matched', 'expired', 'manual_skip'].includes(resolution)) {
        return success(res, {
          error: 'Invalid resolution. Must be: matched, expired, or manual_skip'
        }, 400);
      }

      const result = mutationMatcher.resolveAmbiguous({
        mutationId: parseInt(mutationId),
        merchantOrderId,
        actorId: req.session?.user?.id || 'admin',
        resolution,
        resolutionDetails: details
      });

      if (!result.success) {
        return notFound(res, 'Ambiguous record not found');
      }

      return success(res, {
        message: 'Ambiguous match resolved',
        resolution
      });

    } catch (error) {
      console.error('Admin resolve ambiguous error:', error);
      return serverError(res);
    }
  });

  /**
   * POST /admin/bulk-mark-paid
   * Bulk mark payments as paid
   */
  router.post('/bulk-mark-paid', bulkLimitLimiter, (req, res) => {
    try {
      const { merchantOrderIds, reason } = req.body;

      if (!Array.isArray(merchantOrderIds) || merchantOrderIds.length === 0) {
        return success(res, {
          error: 'merchantOrderIds must be a non-empty array'
        }, 400);
      }

      if (merchantOrderIds.length > 50) {
        return success(res, {
          error: 'Maximum 50 payments per bulk operation'
        }, 400);
      }

      const results = {
        success: [],
        failed: [],
        alreadyProcessed: []
      };

      for (const merchantOrderId of merchantOrderIds) {
        const result = paymentState.markPaymentSuccess({
          merchantOrderId,
          source: 'admin',
          actorId: req.session?.user?.id || 'admin',
          details: { bulk: true, reason }
        });

        if (result.success) {
          if (result.alreadyProcessed) {
            results.alreadyProcessed.push(merchantOrderId);
          } else {
            results.success.push(merchantOrderId);
          }
        } else {
          results.failed.push({ id: merchantOrderId, error: result.error });
        }
      }

      return success(res, {
        message: `Processed ${merchantOrderIds.length} payments`,
        ...results
      });

    } catch (error) {
      console.error('Admin bulk-mark-paid error:', error);
      return serverError(res);
    }
  });

  /**
   * Format payment for response
   */
  function formatPayment(payment) {
    return {
      merchantOrderId: payment.merchant_order_id,
      referenceId: payment.reference_id,
      description: payment.description,
      email: payment.email,
      name: payment.name,
      amount: payment.qris_base_amount,
      suffix: payment.qris_suffix,
      fullAmount: payment.qris_full_amount,
      status: payment.status,
      expiresAt: payment.expires_at,
      paidAt: payment.paid_at,
      reconciledVia: payment.reconciled_via,
      createdAt: payment.created_at,
      updatedAt: payment.updated_at
    };
  }

  return router;
}

module.exports = {
  createAdminRouter
};
