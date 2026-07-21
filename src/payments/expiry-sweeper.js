/**
 * Payment Expiry Sweeper
 *
 * Background job to expire pending payments that have passed their expiry time.
 */

const { PaymentStatus } = require('./payment-state');

/**
 * Create expiry sweeper
 *
 * @param {Object} options - Configuration options
 * @param {Object} options.db - Database instance
 * @param {Object} options.paymentState - Payment state machine
 * @param {Object} options.broadcaster - SSE broadcaster (optional)
 * @param {number} [options.intervalMs=60000] - Sweep interval (1 min default)
 * @param {number} [options.batchSize=100] - Max payments to expire per sweep
 * @returns {Object} Sweeper functions
 */
function createExpirySweeper(options = {}) {
  const {
    db,
    paymentState,
    broadcaster,
    intervalMs = 60000,
    batchSize = 100
  } = options;

  if (!db) {
    throw new Error('Expiry sweeper requires database instance');
  }

  if (!paymentState) {
    throw new Error('Expiry sweeper requires payment state');
  }

  let intervalHandle = null;
  let isRunning = false;
  let stats = {
    totalExpired: 0,
    lastRun: null,
    lastRunDuration: 0,
    errors: 0
  };

  // Prepared statements
  const findExpiredPaymentsStmt = db.prepare(`
    SELECT merchant_order_id FROM payments
    WHERE status = 'PENDING'
      AND datetime(expires_at) <= datetime('now')
    ORDER BY expires_at ASC
    LIMIT ?
  `);

  const releaseSuffixStmt = db.prepare(`
    UPDATE qris_suffix_locks
    SET released_at = datetime('now')
    WHERE merchant_order_id = ? AND released_at IS NULL
  `);

  /**
   * Run expiry sweep
   *
   * @returns {{ expired: number, errors: number }}
   */
  function sweep() {
    if (isRunning) {
      return { expired: 0, errors: 0, skipped: 'already_running' };
    }

    isRunning = true;
    const startTime = Date.now();
    let expired = 0;
    let errors = 0;

    try {
      // Find expired payments
      const expiredPayments = findExpiredPaymentsStmt.all(batchSize);

      for (const { merchant_order_id } of expiredPayments) {
        try {
          // Mark as expired
          const result = paymentState.markPaymentExpired(merchant_order_id);

          if (result.success) {
            expired++;

            // Release suffix lock
            releaseSuffixStmt.run(merchant_order_id);

            // Broadcast update
            if (broadcaster) {
              broadcaster.broadcast(merchant_order_id, {
                event: 'payment_expired',
                merchantOrderId: merchant_order_id,
                timestamp: new Date().toISOString()
              });
            }
          }
        } catch (error) {
          console.error(`Failed to expire payment ${merchant_order_id}:`, error);
          errors++;
        }
      }
    } catch (error) {
      console.error('Expiry sweep error:', error);
      errors++;
    } finally {
      isRunning = false;
      stats.lastRun = new Date().toISOString();
      stats.lastRunDuration = Date.now() - startTime;
      stats.totalExpired += expired;
      stats.errors += errors;
    }

    return { expired, errors };
  }

  /**
   * Start the sweeper
   */
  function start() {
    if (intervalHandle) {
      return; // Already running
    }

    console.log(`[ExpirySweeper] Starting with ${intervalMs}ms interval`);

    // Run immediately
    sweep();

    // Schedule periodic runs
    intervalHandle = setInterval(sweep, intervalMs);

    return {
      started: true,
      intervalMs,
      batchSize
    };
  }

  /**
   * Stop the sweeper
   */
  function stop() {
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
      console.log('[ExpirySweeper] Stopped');
    }
  }

  /**
   * Force a sweep (bypass interval)
   */
  function forceSweep() {
    return sweep();
  }

  /**
   * Get sweeper status
   */
  function getStatus() {
    return {
      running: intervalHandle !== null,
      isProcessing: isRunning,
      intervalMs,
      batchSize,
      ...stats
    };
  }

  /**
   * Set new interval
   *
   * @param {number} newIntervalMs - New interval in ms
   */
  function setInterval(newIntervalMs) {
    if (intervalHandle) {
      stop();
      intervalMs = newIntervalMs;
      start();
    } else {
      intervalMs = newIntervalMs;
    }
  }

  return {
    start,
    stop,
    sweep: forceSweep,
    getStatus,
    setInterval
  };
}

module.exports = {
  createExpirySweeper
};
