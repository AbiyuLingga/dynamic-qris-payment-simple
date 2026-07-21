/**
 * Auth Wrapper Middleware
 *
 * Generic authentication wrapper that delegates auth logic to callback.
 * Does not enforce any specific auth mechanism.
 */

const { unauthorized, forbidden } = require('../utils/response');

/**
 * Create auth middleware
 *
 * @param {Object} options - Configuration options
 * @param {Function} options.authenticate - Auth function (req) => Promise<user|null>
 * @param {Function} [options.authorize] - Optional extra auth check (user) => boolean
 * @param {string[]} [options.methods=['bearer', 'session']] - Auth methods to try
 * @returns {Object} Middleware with authenticate and optionalAdmin wrapper
 */
function createAuthMiddleware(options = {}) {
  const {
    authenticate,
    authorize = () => true,
    methods = ['bearer', 'session']
  } = options;

  if (typeof authenticate !== 'function') {
    throw new Error('Auth middleware requires authenticate function');
  }

  /**
   * Authenticate user middleware
   */
  async function authenticateUser(req, res, next) {
    try {
      const user = await authenticate(req);

      if (!user) {
        return unauthorized(res, 'Authentication required');
      }

      // Attach user to request
      req.user = user;
      req.isAuthenticated = true;

      next();
    } catch (error) {
      console.error('Auth error:', error);
      return unauthorized(res, 'Authentication failed');
    }
  }

  /**
   * Require specific role(s)
   */
  function requireRole(...roles) {
    return (req, res, next) => {
      if (!req.user) {
        return unauthorized(res, 'Authentication required');
      }

      if (!roles.includes(req.user.role)) {
        return forbidden(res, 'Insufficient permissions');
      }

      next();
    };
  }

  /**
   * Require admin access
   *
   * @param {Function} [customAdminCheck] - Custom admin check (req) => boolean
   */
  function requireAdmin(customAdminCheck) {
    const adminCheck = customAdminCheck || ((req) => {
      return req.user && req.user.role === 'admin';
    });

    return (req, res, next) => {
      if (!req.user) {
        return unauthorized(res, 'Authentication required');
      }

      if (!adminCheck(req)) {
        return forbidden(res, 'Admin access required');
      }

      next();
    };
  }

  /**
   * Optional auth - continue even if not authenticated
   */
  async function optionalAuth(req, res, next) {
    try {
      const user = await authenticate(req);
      if (user) {
        req.user = user;
        req.isAuthenticated = true;
      }
      next();
    } catch (error) {
      // Continue without user on auth error
      next();
    }
  }

  return {
    authenticate: authenticateUser,
    requireRole,
    requireAdmin,
    optionalAuth
  };
}

/**
 * Simple session-based auth helper
 *
 * @param {Object} options - Session options
 * @returns {Function} Authenticate function
 */
function sessionAuth(options = {}) {
  const { userKey = 'user' } = options;

  return function sessionAuthenticate(req) {
    if (req.session && req.session[userKey]) {
      return Promise.resolve(req.session[userKey]);
    }
    return Promise.resolve(null);
  };
}

/**
 * Simple bearer token auth helper
 *
 * @param {Function} validateToken - Token validation function (token) => Promise<user|null>
 * @returns {Function} Authenticate function
 */
function bearerAuth(validateToken) {
  return function bearerAuthenticate(req) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return Promise.resolve(null);
    }

    const token = authHeader.substring(7);
    return validateToken(token);
  };
}

module.exports = {
  createAuthMiddleware,
  sessionAuth,
  bearerAuth
};
