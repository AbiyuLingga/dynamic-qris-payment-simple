/**
 * Validation Utilities
 *
 * Input validation and sanitization helpers.
 */

// Email regex (RFC 5322 simplified)
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Phone pattern (Indonesian format)
const PHONE_PATTERN = /^(\+62|62|0)[0-9]{8,14}$/;

// Amount constraints
const MIN_AMOUNT = 100; // Rp 100 minimum
const MAX_AMOUNT = 999999999; // ~1 billion

/**
 * Validate email address
 *
 * @param {string} email - Email to validate
 * @returns {boolean} True if valid
 */
function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  return EMAIL_PATTERN.test(email.trim());
}

/**
 * Validate phone number (Indonesian format)
 *
 * @param {string} phone - Phone number to validate
 * @returns {boolean} True if valid
 */
function isValidPhone(phone) {
  if (typeof phone !== 'string') return false;
  return PHONE_PATTERN.test(phone.replace(/\s/g, ''));
}

/**
 * Normalize phone number to Indonesian format
 *
 * @param {string} phone - Phone number
 * @returns {string} Normalized phone (e.g., "08123456789")
 */
function normalizePhone(phone) {
  if (typeof phone !== 'string') return '';

  let normalized = phone.replace(/\s/g, '');

  // Convert +62 to 0
  if (normalized.startsWith('+62')) {
    normalized = '0' + normalized.substring(3);
  } else if (normalized.startsWith('62')) {
    normalized = '0' + normalized.substring(2);
  }

  return normalized;
}

/**
 * Validate payment amount
 *
 * @param {number} amount - Amount to validate
 * @returns {boolean} True if valid
 */
function isValidAmount(amount) {
  if (typeof amount !== 'number' || isNaN(amount)) return false;
  if (!Number.isInteger(amount)) return false;
  return amount >= MIN_AMOUNT && amount <= MAX_AMOUNT;
}

/**
 * Normalize amount to positive integer
 *
 * @param {*} value - Value to normalize
 * @param {number} [defaultValue] - Default if invalid
 * @returns {number} Normalized amount
 */
function normalizeAmount(value, defaultValue = 0) {
  const num = parseInt(value, 10);
  if (isNaN(num) || num < 0) return defaultValue;
  return num;
}

/**
 * Validate merchant order ID format
 *
 * @param {string} orderId - Order ID to validate
 * @returns {boolean} True if valid format
 */
function isValidOrderId(orderId) {
  if (typeof orderId !== 'string') return false;
  // Format: PAY-timestamp-ref-xxx or PAY-timestamp-xxx
  return /^PAY-\d+(-\w+)?-[A-F0-9]+$/i.test(orderId);
}

/**
 * Validate idempotency key
 *
 * @param {string} key - Key to validate
 * @returns {boolean} True if valid
 */
function isValidIdempotencyKey(key) {
  if (typeof key !== 'string') return false;
  // Min 8 chars, max 128 chars, alphanumeric with dashes/underscores
  return /^[a-zA-Z0-9_-]{8,128}$/.test(key);
}

/**
 * Sanitize string for safe display
 *
 * @param {string} value - Value to sanitize
 * @returns {string} Sanitized string
 */
function sanitizeString(value) {
  if (value == null) return '';
  return String(value)
    .replace(/[<>\"']/g, '')
    .trim()
    .substring(0, 500);
}

/**
 * Mask name for privacy (show first and last character)
 *
 * @param {string} name - Name to mask
 * @returns {string} Masked name
 */
function maskName(name) {
  if (typeof name !== 'string' || name.length < 2) return '***';
  if (name.length === 2) return name[0] + '*';

  const first = name[0];
  const last = name[name.length - 1];
  const middle = '*'.repeat(Math.min(name.length - 2, 4));
  return `${first}${middle}${last}`;
}

/**
 * Validate status transition
 *
 * @param {string} currentStatus - Current payment status
 * @param {string} newStatus - New payment status
 * @returns {boolean} True if transition is valid
 */
function isValidStatusTransition(currentStatus, newStatus) {
  const validTransitions = {
    'PENDING': ['SUCCESS', 'FAILED', 'EXPIRED'],
    'SUCCESS': [], // Terminal state
    'FAILED': [],  // Terminal state
    'EXPIRED': []  // Terminal state
  };

  return validTransitions[currentStatus]?.includes(newStatus) ?? false;
}

/**
 * Parse date from various formats
 *
 * @param {string|Date} date - Date to parse
 * @returns {Date|null} Parsed date or null if invalid
 */
function parseDate(date) {
  if (date instanceof Date) {
    return isNaN(date.getTime()) ? null : date;
  }

  if (typeof date === 'string') {
    const parsed = new Date(date);
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

/**
 * Validate payment create request
 *
 * @param {Object} body - Request body
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validatePaymentCreateRequest(body) {
  const errors = [];

  if (!body || typeof body !== 'object') {
    return { valid: false, errors: ['Request body must be an object'] };
  }

  // Amount (required)
  const amount = normalizeAmount(body.amount);
  if (!isValidAmount(amount)) {
    errors.push(`Amount must be between ${MIN_AMOUNT} and ${MAX_AMOUNT}`);
  }

  // Description (required)
  if (!body.description || typeof body.description !== 'string') {
    errors.push('Description is required');
  } else if (body.description.length > 200) {
    errors.push('Description must be 200 characters or less');
  }

  // Email (required)
  if (!body.email) {
    errors.push('Email is required');
  } else if (!isValidEmail(body.email)) {
    errors.push('Invalid email format');
  }

  // Name (optional)
  if (body.name && (typeof body.name !== 'string' || body.name.length > 100)) {
    errors.push('Name must be 100 characters or less');
  }

  // Reference ID (optional)
  if (body.referenceId && (typeof body.referenceId !== 'string' || body.referenceId.length > 100)) {
    errors.push('Reference ID must be 100 characters or less');
  }

  // Idempotency key (optional)
  if (body.idempotencyKey && !isValidIdempotencyKey(body.idempotencyKey)) {
    errors.push('Idempotency key must be 8-128 alphanumeric characters');
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  // Patterns
  EMAIL_PATTERN,
  PHONE_PATTERN,
  MIN_AMOUNT,
  MAX_AMOUNT,

  // Validators
  isValidEmail,
  isValidPhone,
  isValidAmount,
  isValidOrderId,
  isValidIdempotencyKey,
  isValidStatusTransition,

  // Normalizers
  normalizePhone,
  normalizeAmount,
  sanitizeString,

  // Masking
  maskName,

  // Parsing
  parseDate,

  // Validation helpers
  validatePaymentCreateRequest
};
