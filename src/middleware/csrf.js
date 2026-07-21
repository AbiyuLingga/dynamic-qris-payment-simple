/**
 * CSRF Protection Middleware
 *
 * Implements double-submit cookie pattern for CSRF protection.
 * Does not require server-side session storage.
 */

const crypto = require('crypto');
const { forbidden } = require('../utils/response');

/**
 * Create CSRF protection middleware
 *
 * @param {Object} options - Configuration options
 * @param {string} [options.cookieName='csrf-token'] - Cookie name
 * @param {string} [options.headerName='x-csrf-token'] - Header name
 * @param {string} [options.secret] - Optional secret for signing tokens
 * @returns {Object} Middleware object with generate and validate functions
 */
function createCsrfMiddleware(options = {}) {
  const {
    cookieName = 'csrf-token',
    headerName = 'x-csrf-token',
    secret = crypto.randomBytes(32).toString('hex'),
    cookieOptions = {}
  } = options;

  // Safe cookie defaults
  const defaultCookieOptions = {
    httpOnly: false, // Must be readable by JS for AJAX
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  };

  const finalCookieOptions = { ...defaultCookieOptions, ...cookieOptions };

  /**
   * Generate CSRF token and set cookie
   */
  function generateToken(req, res) {
    const token = crypto.randomBytes(32).toString('hex');

    // Set cookie
    res.cookie(cookieName, token, finalCookieOptions);

    // Also attach to response locals for template rendering
    res.locals.csrfToken = token;

    return token;
  }

  /**
   * Validate CSRF token middleware
   */
  function validateToken(req, res, next) {
    // Skip validation for safe methods
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return next();
    }

    // Also skip for browser-like requests without body
    if (!req.body && !req.headers['content-type']) {
      return next();
    }

    const cookieToken = req.cookies?.[cookieName];
    const headerToken = req.headers[headerName];

    // If using fetch API, check header
    if (headerToken) {
      if (!cookieToken || !crypto.timingSafeEqual(
        Buffer.from(headerToken),
        Buffer.from(cookieToken)
      )) {
        return forbidden(res, 'CSRF token invalid');
      }
      return next();
    }

    // For form submissions, check body
    if (req.body && req.body[cookieName]) {
      if (!cookieToken || !crypto.timingSafeEqual(
        Buffer.from(req.body[cookieName]),
        Buffer.from(cookieToken)
      )) {
        return forbidden(res, 'CSRF token invalid');
      }
      return next();
    }

    // No token provided
    return forbidden(res, 'CSRF token required');
  }

  /**
   * Get token generator middleware (for GET requests)
   */
  function csrfMiddleware(req, res, next) {
    // Generate token for all responses
    generateToken(req, res);
    next();
  }

  return {
    generateToken,
    validateToken,
    csrfMiddleware,
    cookieName,
    headerName
  };
}

/**
 * Create a simple CSRF middleware pair
 *
 * @param {Object} [options] - Configuration options
 * @returns {Function} Combined middleware
 */
function createCsrfProtection(options = {}) {
  const csrf = createCsrfMiddleware(options);

  // Return combined middleware that can be used with app.use()
  return function csrfProtection(req, res, next) {
    csrf.csrfMiddleware(req, res, () => {
      csrf.validateToken(req, res, next);
    });
  };
}

module.exports = {
  createCsrfMiddleware,
  createCsrfProtection
};
