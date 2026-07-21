/**
 * Configuration Loader
 *
 * Loads and validates configuration from environment variables.
 * SECURITY: No hardcoded fallback secrets in production.
 */

const path = require('path');

// Required environment variables in production
const REQUIRED_IN_PRODUCTION = [
  'QRIS_STATIC_STRING',
  'PAYMENT_WEBHOOK_SECRET',
  'HASH_PEPPER'
];

// Optional with safe defaults
const OPTIONAL_DEFAULTS = {
  QRIS_MERCHANT_NAME: 'Payment Gateway',
  QRIS_EXPIRY_MINUTES: '20',
  QRIS_SUFFIX_MIN: '1',
  QRIS_SUFFIX_MAX: '999',
  RATE_LIMIT_WINDOW_MS: '60000',
  RATE_LIMIT_MAX_REQUESTS: '5',
  SSE_MAX_CONNECTIONS_PER_USER: '3',
  DATABASE_PATH: './payments.db',
  LOG_LEVEL: 'info',
  NODE_ENV: 'development',
  MUTATION_COLLECTOR_ENABLED: 'false'
};

/**
 * Parse integer from string env var with fallback
 */
function parseIntOrDefault(value, defaultValue) {
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Validate configuration
 */
function validateConfig(config) {
  const errors = [];

  // Validate QRIS static string format (basic check)
  if (config.qrisStaticString && !config.qrisStaticString.startsWith('000201')) {
    errors.push('QRIS_STATIC_STRING must start with 000201');
  }

  // Validate suffix range
  if (config.suffixMin >= config.suffixMax) {
    errors.push('QRIS_SUFFIX_MIN must be less than QRIS_SUFFIX_MAX');
  }

  // Validate expiry
  if (config.qrisExpiryMinutes < 1 || config.qrisExpiryMinutes > 1440) {
    errors.push('QRIS_EXPIRY_MINUTES must be between 1 and 1440');
  }

  return errors;
}

/**
 * Load configuration from environment
 *
 * @param {Object} overrides - Runtime overrides (useful for testing)
 * @returns {Object} Validated configuration
 * @throws {Error} If required config is missing in production
 */
function loadConfig(overrides = {}) {
  const isProduction = process.env.NODE_ENV === 'production';

  // Start with defaults
  const config = {
    // QRIS Settings
    qrisStaticString: process.env.QRIS_STATIC_STRING || overrides.qrisStaticString,
    qrisMerchantName: process.env.QRIS_MERCHANT_NAME || OPTIONAL_DEFAULTS.QRIS_MERCHANT_NAME,
    qrisExpiryMinutes: parseIntOrDefault(
      process.env.QRIS_EXPIRY_MINUTES,
      parseInt(OPTIONAL_DEFAULTS.QRIS_EXPIRY_MINUTES)
    ),
    suffixMin: parseIntOrDefault(
      process.env.QRIS_SUFFIX_MIN,
      parseInt(OPTIONAL_DEFAULTS.QRIS_SUFFIX_MIN)
    ),
    suffixMax: parseIntOrDefault(
      process.env.QRIS_SUFFIX_MAX,
      parseInt(OPTIONAL_DEFAULTS.QRIS_SUFFIX_MAX)
    ),

    // Security
    webhookSecret: process.env.PAYMENT_WEBHOOK_SECRET || overrides.webhookSecret,
    hashPepper: process.env.HASH_PEPPER || overrides.hashPepper,

    // Rate Limiting
    rateLimitWindowMs: parseIntOrDefault(
      process.env.RATE_LIMIT_WINDOW_MS,
      parseInt(OPTIONAL_DEFAULTS.RATE_LIMIT_WINDOW_MS)
    ),
    rateLimitMaxRequests: parseIntOrDefault(
      process.env.RATE_LIMIT_MAX_REQUESTS,
      parseInt(OPTIONAL_DEFAULTS.RATE_LIMIT_MAX_REQUESTS)
    ),

    // SSE
    sseMaxConnectionsPerUser: parseIntOrDefault(
      process.env.SSE_MAX_CONNECTIONS_PER_USER,
      parseInt(OPTIONAL_DEFAULTS.SSE_MAX_CONNECTIONS_PER_USER)
    ),

    // Database
    dbPath: process.env.DATABASE_PATH || OPTIONAL_DEFAULTS.DATABASE_PATH,

    // Logging
    logLevel: process.env.LOG_LEVEL || OPTIONAL_DEFAULTS.LOG_LEVEL,

    // Collector
    collectorEnabled: process.env.MUTATION_COLLECTOR_ENABLED === 'true' || overrides.collectorEnabled,

    // Environment
    nodeEnv: process.env.NODE_ENV || OPTIONAL_DEFAULTS.NODE_ENV,

    // Apply overrides
    ...overrides
  };

  // In production, enforce required config
  if (isProduction) {
    const missing = REQUIRED_IN_PRODUCTION.filter(key => {
      const configKey = key.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      return !config[configKey];
    });

    if (missing.length > 0) {
      throw new Error(
        `Missing required configuration in production: ${missing.join(', ')}\n` +
        'These must be set via environment variables.'
      );
    }
  }

  // Validate config
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new Error(`Configuration errors: ${errors.join('; ')}`);
  }

  return config;
}

/**
 * Create a scoped config getter for dependency injection
 */
function createConfigGetter(config) {
  return {
    get: (key) => config[key],
    getAll: () => ({ ...config }),
    isProduction: () => config.nodeEnv === 'production',
    isDevelopment: () => config.nodeEnv === 'development'
  };
}

module.exports = {
  loadConfig,
  createConfigGetter,
  REQUIRED_IN_PRODUCTION,
  OPTIONAL_DEFAULTS
};
