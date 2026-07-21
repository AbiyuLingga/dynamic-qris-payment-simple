/**
 * HMAC Signature Validator Middleware
 *
 * Validates HMAC-SHA256 signatures on webhook requests.
 * Includes timestamp validation to prevent replay attacks.
 */

const crypto = require('crypto');
const { safeCompare } = require('../utils/crypto');
const { unauthorized } = require('../utils/response');

/**
 * Create HMAC validator middleware
 *
 * @param {Object} options - Configuration options
 * @param {string} options.secret - HMAC secret key
 * @param {number} [options.maxAgeMs=300000] - Max age of request (5 min default)
 * @param {number} [options.clockSkewMs=60000] - Allowed clock skew (1 min)
 * @param {string} [options.timestampHeader='x-timestamp'] - Timestamp header name
 * @param {string} [options.signatureHeader='x-signature'] - Signature header name
 * @returns {Function} Express middleware
 */
function createHmacValidator(options = {}) {
  const {
    secret,
    maxAgeMs = 5 * 60 * 1000, // 5 minutes
    clockSkewMs = 60 * 1000,  // 1 minute
    timestampHeader = 'x-timestamp',
    signatureHeader = 'x-signature'
  } = options;

  if (!secret) {
    throw new Error('HMAC validator requires a secret');
  }

  return function hmacValidator(req, res, next) {
    const timestamp = req.headers[timestampHeader];
    const signature = req.headers[signatureHeader];

    // Check headers presence
    if (!timestamp) {
      return unauthorized(res, `Missing ${timestampHeader} header`);
    }

    if (!signature) {
      return unauthorized(res, `Missing ${signatureHeader} header`);
    }

    // Parse and validate timestamp
    const requestTime = parseInt(timestamp, 10);
    if (isNaN(requestTime)) {
      return unauthorized(res, 'Invalid timestamp format');
    }

    const now = Date.now();
    const age = now - requestTime;

    // Check timestamp freshness (with clock skew tolerance)
    if (age > maxAgeMs + clockSkewMs) {
      return unauthorized(res, 'Request has expired');
    }

    // Prevent future timestamps (with clock skew tolerance)
    if (requestTime > now + clockSkewMs) {
      return unauthorized(res, 'Timestamp is in the future');
    }

    // Build payload for signature verification
    // Format: timestamp.json(body)
    const body = req.body && Object.keys(req.body).length > 0
      ? JSON.stringify(req.body)
      : '';
    const payload = `${timestamp}.${body}`;

    // Compute expected signature
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');

    // Timing-safe comparison
    if (!safeCompare(expectedSignature, signature)) {
      return unauthorized(res, 'Invalid signature');
    }

    // Attach validated data to request
    req.hmacValidated = {
      timestamp: requestTime,
      bodyHash: crypto.createHash('sha256').update(body).digest('hex')
    };

    next();
  };
}

/**
 * Verify webhook signature for manual use
 *
 * @param {string} secret - HMAC secret
 * @param {Object} payload - Request payload
 * @param {string} signature - Signature to verify
 * @param {number} [maxAgeMs=300000] - Max age
 * @returns {{ valid: boolean, error?: string }}
 */
function verifyWebhookSignature(secret, payload, signature, maxAgeMs = 300000) {
  if (!secret || !payload || !signature) {
    return { valid: false, error: 'Missing required parameters' };
  }

  const { timestamp, body } = payload;

  if (!timestamp) {
    return { valid: false, error: 'Missing timestamp' };
  }

  // Check timestamp
  const requestTime = parseInt(timestamp, 10);
  if (isNaN(requestTime)) {
    return { valid: false, error: 'Invalid timestamp' };
  }

  const age = Date.now() - requestTime;
  if (age > maxAgeMs) {
    return { valid: false, error: 'Request expired' };
  }

  // Verify signature
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body || {});
  const payloadStr = `${timestamp}.${bodyStr}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payloadStr)
    .digest('hex');

  if (!safeCompare(expected, signature)) {
    return { valid: false, error: 'Invalid signature' };
  }

  return { valid: true };
}

module.exports = {
  createHmacValidator,
  verifyWebhookSignature
};
