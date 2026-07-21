/**
 * Type Definitions
 *
 * JSDoc type definitions for qris-payment-simple.
 * These help with IDE autocompletion and documentation.
 */

/**
 * @typedef {Object} PaymentConfig
 * @property {string} qrisStaticString - Static QRIS string from provider
 * @property {string} [qrisMerchantName] - Merchant display name
 * @property {number} [qrisExpiryMinutes=20] - Payment expiry time
 * @property {number} [suffixMin=1] - Minimum suffix value
 * @property {number} [suffixMax=999] - Maximum suffix value
 */

/**
 * @typedef {Object} SecurityConfig
 * @property {string} webhookSecret - HMAC secret for webhooks
 * @property {string} hashPepper - Pepper for hashing
 * @property {boolean} [csrfEnabled=true] - Enable CSRF protection
 * @property {boolean} [trustProxy=false] - Trust X-Forwarded-For header
 */

/**
 * @typedef {Object} RateLimitConfig
 * @property {number} [windowMs=60000] - Rate limit window
 * @property {number} [maxRequests=5] - Max requests per window
 */

/**
 * @typedef {Object} CollectorConfig
 * @property {boolean} [enabled=false] - Enable auto-collector
 * @property {string} [provider='mock'] - Provider type
 * @property {Object} [providerConfig] - Provider-specific config
 */

/**
 * @typedef {Object} PaymentHooks
 * @property {Function} [onPaymentSuccess] - Called when payment succeeds
 * @property {Function} [onPaymentFailed] - Called when payment fails
 * @property {Function} [onPaymentExpired] - Called when payment expires
 * @property {Function} [onAmbiguousMatch] - Called when match is ambiguous
 * @property {Function} [authorizeAdmin] - Admin authorization callback
 */

/**
 * @typedef {Object} PaymentRequest
 * @property {number} amount - Payment amount (before suffix)
 * @property {string} description - Payment description
 * @property {string} email - Customer email
 * @property {string} [name] - Customer name
 * @property {string} [referenceId] - External reference ID
 * @property {Object} [metadata] - Custom metadata
 * @property {string} [idempotencyKey] - Request idempotency key
 */

/**
 * @typedef {Object} Payment
 * @property {number} id - Database ID
 * @property {string} merchantOrderId - Unique order ID
 * @property {string} referenceId - External reference
 * @property {number} amount - Base amount
 * @property {number} qrisSuffix - QRIS suffix
 * @property {number} qrisFullAmount - Total amount (amount + suffix)
 * @property {string} qrString - Dynamic QRIS string
 * @property {string} qrImageDataUrl - QR code image
 * @property {string} status - Payment status
 * @property {string} expiresAt - Expiry timestamp
 * @property {string} createdAt - Creation timestamp
 */

/**
 * @typedef {Object} Mutation
 * @property {number} [id] - Database ID
 * @property {string} provider - Provider name
 * @property {string} [providerMutationId] - External mutation ID
 * @property {number} amount - Mutation amount
 * @property {string} direction - 'IN' or 'OUT'
 * @property {string} status - 'SUCCESS', 'PENDING', 'FAILED'
 * @property {string} transactedAt - Transaction timestamp
 * @property {string} [payerName] - Masked payer name
 * @property {string} [note] - Transaction note
 */

/**
 * @typedef {Object} MatchResult
 * @property {boolean} matched - Whether mutation was matched
 * @property {string} [merchantOrderId] - Matched order ID
 * @property {number} confidence - Confidence score (0-100)
 * @property {string} level - Confidence level
 * @property {Object[]} [candidates] - Potential matches
 */

/**
 * Payment statuses
 * @enum {string}
 */
const PaymentStatus = {
  PENDING: 'PENDING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED'
};

/**
 * Reconciliation sources
 * @enum {string}
 */
const ReconciliationSource = {
  WEBHOOK: 'webhook',
  AUTO_VERIFY: 'auto_verify',
  ADMIN: 'admin',
  MANUAL: 'manual'
};

/**
 * Confidence levels for mutation matching
 * @enum {string}
 */
const ConfidenceLevel = {
  EXACT: 'EXACT',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
  NONE: 'NONE'
};

/**
 * Collector states (temperature)
 * @enum {string}
 */
const CollectorState = {
  HOT: 'HOT',
  WARM: 'WARM',
  COLD: 'COLD'
};

/**
 * Circuit breaker states
 * @enum {string}
 */
const CircuitState = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN'
};

module.exports = {
  PaymentStatus,
  ReconciliationSource,
  ConfidenceLevel,
  CollectorState,
  CircuitState
};
