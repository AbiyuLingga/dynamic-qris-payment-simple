/**
 * IP Allowlist Middleware
 *
 * Validates client IP addresses with optional proxy support.
 * SECURITY: Requires explicit trustProxy configuration to prevent spoofing.
 */

const { forbidden, badRequest } = require('../utils/response');

/**
 * Create IP allowlist middleware
 *
 * @param {Object} options - Configuration options
 * @param {string[]} [options.allowlist=[]] - List of allowed IPs
 * @param {boolean} [options.trustProxy=false] - Trust X-Forwarded-For header
 * @param {boolean} [options.rejectOnProxyHeader=false] - Reject if proxy header present but trustProxy is false
 * @returns {Function} Express middleware
 */
function createIpAllowlist(options = {}) {
  const {
    allowlist = [],
    trustProxy = false,
    rejectOnProxyHeader = true
  } = options;

  /**
   * Extract clean IP from request
   */
  function extractIp(req) {
    let ip = req.ip || req.connection?.remoteAddress || '';

    // Clean IPv6 prefix
    ip = ip.replace(/^::ffff:/, '');

    return ip;
  }

  /**
   * Check if IP is in allowlist
   */
  function isAllowed(ip) {
    if (allowlist.length === 0) return true;
    return allowlist.includes(ip);
  }

  return function ipAllowlistMiddleware(req, res, next) {
    const clientIp = extractIp(req);

    // Security check: If behind proxy but trustProxy is not set,
    // and X-Forwarded-For header is present, reject to prevent spoofing
    if (!trustProxy && rejectOnProxyHeader && req.headers['x-forwarded-for']) {
      return badRequest(res,
        'X-Forwarded-For header not allowed. ' +
        'Set trustProxy: true if behind a reverse proxy.'
      );
    }

    // Check allowlist
    if (!isAllowed(clientIp)) {
      return forbidden(res, 'Your IP address is not allowed');
    }

    // Attach cleaned IP to request
    req.clientIp = clientIp;

    next();
  };
}

/**
 * Create middleware that only allows specific IPs
 *
 * @param {string[]} ips - Allowed IP list
 * @param {Object} [options] - Additional options
 * @returns {Function} Express middleware
 */
function allowOnly(ips, options = {}) {
  return createIpAllowlist({
    allowlist: ips,
    trustProxy: options.trustProxy || false,
    ...options
  });
}

/**
 * Create middleware that blocks specific IPs
 *
 * @param {string[]} ips - Blocked IP list
 * @param {Object} [options] - Additional options
 * @returns {Function} Express middleware
 */
function blockIps(ips, options = {}) {
  const blockedSet = new Set(ips);

  return function blockMiddleware(req, res, next) {
    const ip = req.ip?.replace(/^::ffff:/, '') || '';

    if (blockedSet.has(ip)) {
      return forbidden(res, 'Access denied');
    }

    next();
  };
}

/**
 * Validate proxy configuration
 *
 * Call this in app setup to ensure trust proxy is properly configured.
 *
 * @param {Object} app - Express app
 * @param {boolean} shouldTrust - Whether app should trust proxy
 */
function validateProxyConfig(app, shouldTrust) {
  if (shouldTrust && !app.get('trust proxy')) {
    console.warn(
      '[Security] App is behind proxy but "trust proxy" is not enabled. ' +
      'Add "app.set(\'trust proxy\', true)" to enable proper IP detection.'
    );
  }
}

module.exports = {
  createIpAllowlist,
  allowOnly,
  blockIps,
  validateProxyConfig
};
