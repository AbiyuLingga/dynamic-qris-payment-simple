/**
 * Standardized Response Utilities
 *
 * Provides consistent response format across all API endpoints.
 */

/**
 * Success response
 *
 * @param {Object} res - Express response object
 * @param {Object} data - Response data
 * @param {number} [statusCode=200] - HTTP status code
 */
function success(res, data, statusCode = 200) {
  return res.status(statusCode).json({
    success: true,
    data,
    timestamp: new Date().toISOString()
  });
}

/**
 * Created response (201)
 *
 * @param {Object} res - Express response object
 * @param {Object} data - Created resource data
 */
function created(res, data) {
  return success(res, data, 201);
}

/**
 * Error response
 *
 * @param {Object} res - Express response object
 * @param {string} code - Error code (e.g., 'VALIDATION_ERROR')
 * @param {string} message - Human-readable message
 * @param {number} [statusCode=400] - HTTP status code
 * @param {Object} [details] - Additional error details
 */
function error(res, code, message, statusCode = 400, details = null) {
  const response = {
    success: false,
    error: {
      code,
      message
    },
    timestamp: new Date().toISOString()
  };

  if (details) {
    response.error.details = details;
  }

  return res.status(statusCode).json(response);
}

/**
 * Validation error response (400)
 *
 * @param {Object} res - Express response object
 * @param {string[]} errors - Validation error messages
 */
function validationError(res, errors) {
  return error(res, 'VALIDATION_ERROR', 'Invalid request data', 400, { errors });
}

/**
 * Unauthorized response (401)
 *
 * @param {Object} res - Express response object
 * @param {string} [message] - Error message
 */
function unauthorized(res, message = 'Authentication required') {
  return error(res, 'UNAUTHORIZED', message, 401);
}

/**
 * Forbidden response (403)
 *
 * @param {Object} res - Express response object
 * @param {string} [message] - Error message
 */
function forbidden(res, message = 'Access denied') {
  return error(res, 'FORBIDDEN', message, 403);
}

/**
 * Not found response (404)
 *
 * @param {Object} res - Express response object
 * @param {string} [message] - Error message
 */
function notFound(res, message = 'Resource not found') {
  return error(res, 'NOT_FOUND', message, 404);
}

/**
 * Conflict response (409)
 *
 * @param {Object} res - Express response object
 * @param {string} message - Error message
 */
function conflict(res, message) {
  return error(res, 'CONFLICT', message, 409);
}

/**
 * Rate limited response (429)
 *
 * @param {Object} res - Express response object
 * @param {string} [message] - Error message
 */
function rateLimited(res, message = 'Too many requests') {
  return error(res, 'RATE_LIMITED', message, 429, {
    retryAfter: 'Please try again later'
  });
}

/**
 * Server error response (500)
 *
 * @param {Object} res - Express response object
 * @param {string} [message] - Error message
 */
function serverError(res, message = 'Internal server error') {
  return error(res, 'SERVER_ERROR', message, 500);
}

/**
 * Payment-specific error responses
 */
const paymentErrors = {
  paymentNotFound: (res) => notFound(res, 'Payment not found'),

  paymentExpired: (res) => error(res, 'PAYMENT_EXPIRED', 'Payment has expired', 410),

  paymentAlreadyPaid: (res) => conflict(res, 'Payment has already been completed'),

  invalidWebhookSignature: (res) => unauthorized(res, 'Invalid webhook signature'),

  idempotencyConflict: (res, existingOrderId) => conflict(res, 'Request with this idempotency key already exists'),

  insufficientAmount: (res) => error(res, 'INSUFFICIENT_AMOUNT', 'Amount is below minimum', 400),

  rateLimitExceeded: (res) => rateLimited(res)
};

module.exports = {
  success,
  created,
  error,
  validationError,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  rateLimited,
  serverError,
  paymentErrors
};
