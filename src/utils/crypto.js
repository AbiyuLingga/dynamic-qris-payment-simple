/**
 * Cryptographic Utilities
 *
 * Provides secure crypto functions for HMAC, hashing, and comparisons.
 */

const crypto = require('crypto');

/**
 * Generate HMAC-SHA256 signature
 *
 * @param {string} secret - HMAC secret key
 * @param {string} payload - Data to sign
 * @returns {string} Hex-encoded signature
 */
function generateHmac(secret, payload) {
  return crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
}

/**
 * Timing-safe comparison of two strings
 *
 * @param {string} expected - Expected value
 * @param {string} received - Received value
 * @returns {boolean} True if equal
 */
function safeCompare(expected, received) {
  if (typeof expected !== 'string' || typeof received !== 'string') {
    return false;
  }

  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);

  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

/**
 * Verify HMAC signature with timing-safe comparison
 *
 * @param {string} secret - HMAC secret key
 * @param {string} payload - Original payload
 * @param {string} signature - Signature to verify
 * @returns {boolean} True if valid
 */
function verifyHmac(secret, payload, signature) {
  const expected = generateHmac(secret, payload);
  return safeCompare(expected, signature);
}

/**
 * Generate SHA256 hash
 *
 * @param {string} input - Data to hash
 * @returns {string} Hex-encoded hash
 */
function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Generate content hash for deduplication
 *
 * Combines multiple fields to create unique hash for mutation deduplication.
 *
 * @param {Object} data - Data object to hash
 * @returns {string} Hex-encoded hash
 */
function contentHash(data) {
  const normalized = JSON.stringify({
    id: data.providerMutationId || '',
    amount: data.amount,
    direction: data.direction || 'IN',
    timestamp: data.transactedAt instanceof Date
      ? data.transactedAt.toISOString()
      : data.transactedAt,
    note: data.note || ''
  });
  return sha256(normalized);
}

/**
 * Hash identifier for rate limiting
 *
 * @param {string} type - Identifier type (ip, email, etc)
 * @param {string} value - Identifier value
 * @param {string} [pepper] - Additional pepper for security
 * @returns {string} Hex-encoded hash
 */
function hashIdentifier(type, value, pepper = '') {
  return sha256(`${type}:${value}:${pepper}`);
}

/**
 * Generate a random suffix for QRIS amount
 *
 * @param {number} min - Minimum suffix value
 * @param {number} max - Maximum suffix value
 * @returns {number} Random suffix between min and max (inclusive)
 */
function generateRandomSuffix(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Generate unique ID for idempotency
 *
 * @param {string} prefix - Prefix for the ID
 * @returns {string} Unique ID with timestamp
 */
function generateUniqueId(prefix = 'PAY') {
  const timestamp = Date.now();
  const random = crypto.randomBytes(4).toString('hex');
  return `${prefix}-${timestamp}-${random}`;
}

/**
 * Generate merchant order ID
 *
 * @param {string} [referenceId] - Optional external reference
 * @returns {string} Unique merchant order ID
 */
function generateMerchantOrderId(referenceId) {
  const timestamp = Date.now();
  const random = crypto.randomBytes(3).toString('hex').toUpperCase();
  const ref = referenceId ? `-${referenceId.substring(0, 8)}` : '';
  return `PAY-${timestamp}${ref}-${random}`;
}

module.exports = {
  generateHmac,
  safeCompare,
  verifyHmac,
  sha256,
  contentHash,
  hashIdentifier,
  generateRandomSuffix,
  generateUniqueId,
  generateMerchantOrderId
};
