/**
 * QRIS Suffix Allocator
 *
 * Thread-safe suffix allocation for QRIS amounts.
 * Each unique amount gets a random suffix (1-999) to enable auto-verification.
 */

const { generateRandomSuffix } = require('../utils/crypto');

/**
 * Create suffix allocator
 *
 * @param {Object} options - Configuration options
 * @param {Object} options.db - Database instance
 * @param {number} [options.min=1] - Minimum suffix value
 * @param {number} [options.max=999] - Maximum suffix value
 * @param {number} [options.expiryMinutes=30] - Lock expiry time
 * @returns {Object} Allocator functions
 */
function createSuffixAllocator(options = {}) {
  const {
    db,
    min = 1,
    max = 999,
    expiryMinutes = 30
  } = options;

  if (!db) {
    throw new Error('Suffix allocator requires database instance');
  }

  // Prepared statements
  const findAvailableStmt = db.prepare(`
    SELECT suffix FROM qris_suffix_locks
    WHERE base_amount = ? AND released_at IS NULL
    AND expires_at > datetime('now')
    ORDER BY suffix ASC
  `);

  const isAllocatedStmt = db.prepare(`
    SELECT 1 FROM qris_suffix_locks
    WHERE base_amount = ? AND suffix = ?
    AND released_at IS NULL
    AND expires_at > datetime('now')
    LIMIT 1
  `);

  const allocateStmt = db.prepare(`
    INSERT INTO qris_suffix_locks (base_amount, suffix, merchant_order_id, expires_at)
    VALUES (?, ?, ?, datetime('now', '+' || ? || ' minutes'))
  `);

  const releaseStmt = db.prepare(`
    UPDATE qris_suffix_locks
    SET released_at = datetime('now')
    WHERE base_amount = ? AND suffix = ? AND merchant_order_id = ?
  `);

  const releaseByOrderStmt = db.prepare(`
    UPDATE qris_suffix_locks
    SET released_at = datetime('now')
    WHERE merchant_order_id = ? AND released_at IS NULL
  `);

  const cleanupStmt = db.prepare(`
    UPDATE qris_suffix_locks
    SET released_at = datetime('now')
    WHERE expires_at < datetime('now') AND released_at IS NULL
  `);

  /**
   * Find available suffix for given amount
   *
   * @param {number} baseAmount - Base payment amount
   * @param {string} merchantOrderId - Order ID to lock
   * @returns {{ success: boolean, suffix?: number, error?: string }}
   */
  function allocate(baseAmount, merchantOrderId) {
    // Cleanup expired locks first
    cleanupStmt.run();

    // Get already allocated suffixes for this amount
    const allocated = new Set(
      findAvailableStmt.all(baseAmount).map(row => row.suffix)
    );

    // Find available suffix
    for (let i = 0; i < max - min + 1; i++) {
      const suffix = generateRandomSuffix(min, max);

      if (!allocated.has(suffix)) {
        // Try to allocate
        try {
          allocateStmt.run(baseAmount, suffix, merchantOrderId, expiryMinutes);

          return {
            success: true,
            suffix,
            fullAmount: baseAmount + suffix
          };
        } catch (error) {
          // Race condition - suffix was just taken, try again
          if (error.code === 'SQLITE_CONSTRAINT') {
            allocated.add(suffix);
            continue;
          }
          throw error;
        }
      }
    }

    return {
      success: false,
      error: 'No available suffixes for this amount'
    };
  }

  /**
   * Release allocated suffix
   *
   * @param {number} baseAmount - Base payment amount
   * @param {number} suffix - Suffix to release
   * @param {string} merchantOrderId - Order ID
   * @returns {{ success: boolean }}
   */
  function release(baseAmount, suffix, merchantOrderId) {
    const result = releaseStmt.run(baseAmount, suffix, merchantOrderId);
    return { success: result.changes > 0 };
  }

  /**
   * Release all suffixes for an order
   *
   * @param {string} merchantOrderId - Order ID
   * @returns {{ success: boolean, released: number }}
   */
  function releaseAll(merchantOrderId) {
    const result = releaseByOrderStmt.run(merchantOrderId);
    return { success: true, released: result.changes };
  }

  /**
   * Check if suffix is allocated
   *
   * @param {number} baseAmount - Base payment amount
   * @param {number} suffix - Suffix to check
   * @returns {boolean}
   */
  function isAllocated(baseAmount, suffix) {
    const result = isAllocatedStmt.get(baseAmount, suffix);
    return !!result;
  }

  /**
   * Get allocation info for an order
   *
   * @param {string} merchantOrderId - Order ID
   * @returns {Object|null}
   */
  function getAllocation(merchantOrderId) {
    const stmt = db.prepare(`
      SELECT base_amount, suffix, expires_at, locked_at
      FROM qris_suffix_locks
      WHERE merchant_order_id = ? AND released_at IS NULL
    `);

    return stmt.get(merchantOrderId);
  }

  /**
   * Cleanup expired allocations
   *
   * @returns {number} Number of expired allocations cleaned
   */
  function cleanupExpired() {
    const result = cleanupStmt.run();
    return result.changes;
  }

  /**
   * Get allocation statistics
   *
   * @param {number} [baseAmount] - Optional amount to filter
   * @returns {Object} Statistics
   */
  function getStats(baseAmount) {
    const stats = {};

    if (baseAmount) {
      // Stats for specific amount
      const active = db.prepare(`
        SELECT COUNT(*) as count FROM qris_suffix_locks
        WHERE base_amount = ? AND released_at IS NULL
        AND expires_at > datetime('now')
      `).get(baseAmount);

      stats.active = active.count;
      stats.available = max - min + 1 - active.count;
    } else {
      // Overall stats
      const total = db.prepare(`
        SELECT COUNT(*) as count FROM qris_suffix_locks
        WHERE released_at IS NULL AND expires_at > datetime('now')
      `).get();

      stats.totalActive = total.count;
    }

    stats.min = min;
    stats.max = max;
    stats.range = max - min + 1;

    return stats;
  }

  return {
    allocate,
    release,
    releaseAll,
    isAllocated,
    getAllocation,
    cleanupExpired,
    getStats
  };
}

module.exports = {
  createSuffixAllocator
};
