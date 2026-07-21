/**
 * Rate Limiter Middleware
 *
 * Database-backed sliding window rate limiting.
 * Alternative to express-rate-limit for more control.
 */

const { hashIdentifier } = require('../utils/crypto');
const { rateLimited } = require('../utils/response');

/**
 * Create rate limiter middleware
 *
 * @param {Object} options - Configuration options
 * @param {Object} options.db - Database instance
 * @param {number} [options.windowMs=60000] - Window size in milliseconds
 * @param {number} [options.maxRequests=5] - Max requests per window
 * @param {string} [options.keyPrefix='rl'] - Prefix for rate limit keys
 * @param {Function} [options.keyGenerator] - Custom key generator (req) => string
 * @returns {Function} Express middleware
 */
function createRateLimiter(options = {}) {
  const {
    db,
    windowMs = 60 * 1000,
    maxRequests = 5,
    keyPrefix = 'rl',
    keyGenerator = defaultKeyGenerator
  } = options;

  if (!db) {
    throw new Error('Rate limiter requires database instance');
  }

  // Prepared statements
  const checkStmt = db.prepare(`
    SELECT COUNT(*) as count FROM payment_rate_limits
    WHERE rate_hash = ? AND window_start > ?
  `);

  const insertStmt = db.prepare(`
    INSERT INTO payment_rate_limits (rate_hash, window_start)
    VALUES (?, ?)
  `);

  const cleanupStmt = db.prepare(`
    DELETE FROM payment_rate_limits
    WHERE window_start < ?
  `);

  // Periodic cleanup (every 100 requests)
  let cleanupCounter = 0;
  const cleanupThreshold = 100;

  /**
   * Default key generator
   */
  function defaultKeyGenerator(req) {
    // Try various identifiers in order of preference
    const identifier = req.user?.id
      || req.user?.email
      || req.clientIp
      || req.ip
      || req.connection?.remoteAddress
      || 'unknown';

    return `${keyPrefix}:${identifier}`;
  }

  /**
   * Get window start timestamp
   */
  function getWindowStart() {
    return Date.now() - windowMs;
  }

  return function rateLimiter(req, res, next) {
    const key = keyGenerator(req);
    const keyHash = hashIdentifier(keyPrefix, key);
    const windowStart = getWindowStart();
    const now = Date.now();

    try {
      // Check current count
      const result = checkStmt.get(keyHash, windowStart);

      if (result.count >= maxRequests) {
        // Get oldest request in window for retry-after
        const oldestStmt = db.prepare(`
          SELECT window_start FROM payment_rate_limits
          WHERE rate_hash = ?
          ORDER BY window_start ASC
          LIMIT 1
        `);
        const oldest = oldestStmt.get(keyHash);

        const retryAfter = oldest
          ? Math.ceil((oldest.window_start + windowMs - now) / 1000)
          : Math.ceil(windowMs / 1000);

        res.set('Retry-After', retryAfter.toString());
        res.set('X-RateLimit-Limit', maxRequests.toString());
        res.set('X-RateLimit-Remaining', '0');
        res.set('X-RateLimit-Reset', oldest
          ? Math.ceil((oldest.window_start + windowMs) / 1000).toString()
          : Math.ceil((now + windowMs) / 1000).toString()
        );

        return rateLimited(res, 'Too many requests');
      }

      // Insert new request
      insertStmt.run(keyHash, now);

      // Set rate limit headers
      res.set('X-RateLimit-Limit', maxRequests.toString());
      res.set('X-RateLimit-Remaining', String(maxRequests - result.count - 1));
      res.set('X-RateLimit-Reset', Math.ceil((now + windowMs) / 1000).toString());

      // Periodic cleanup
      cleanupCounter++;
      if (cleanupCounter >= cleanupThreshold) {
        cleanupCounter = 0;
        cleanupStmt.run(windowStart);
      }

      next();
    } catch (error) {
      console.error('Rate limiter error:', error);
      // Fail open - allow request if rate limiter fails
      next();
    }
  };
}

/**
 * Create stricter rate limiter for sensitive operations
 *
 * @param {Object} options - Configuration options
 * @returns {Function} Express middleware
 */
function createStrictRateLimiter(options = {}) {
  return createRateLimiter({
    maxRequests: 1,
    windowMs: 5000, // 5 seconds
    keyPrefix: 'strict',
    ...options
  });
}

/**
 * Create bulk operation rate limiter
 *
 * @param {Object} options - Configuration options
 * @returns {Function} Express middleware
 */
function createBulkRateLimiter(options = {}) {
  return createRateLimiter({
    maxRequests: 10,
    windowMs: 60 * 1000,
    keyPrefix: 'bulk',
    ...options
  });
}

module.exports = {
  createRateLimiter,
  createStrictRateLimiter,
  createBulkRateLimiter
};
