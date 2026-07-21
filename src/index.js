/**
 * qris-payment-simple
 *
 * Standalone, pluggable QRIS payment gateway for Node.js/Express.
 *
 * @example
 * // As standalone server
 * const { createPaymentApp } = require('qris-payment-simple');
 * const app = createPaymentApp({ ... });
 * app.listen(3000);
 *
 * @example
 * // As Express router
 * const { createPaymentRouter } = require('qris-payment-simple');
 * app.use('/payments', createPaymentRouter({ ... }));
 */

const express = require('express');
const path = require('path');

// Load environment variables
require('fs').existsSync('.env') && require('fs')
  .readFileSync('.env', 'utf8')
  .split('\n')
  .forEach(line => {
    const [key, ...vals] = line.split('=');
    if (key && !key.startsWith('#')) {
      process.env[key.trim()] = vals.join('=').trim();
    }
  });

const { loadConfig, createConfigGetter } = require('./config');
const { initDatabase, closeDatabase } = require('./database');
const { createQrisGenerator } = require('./payments/qris-generator');
const { createSuffixAllocator } = require('./payments/suffix-allocator');
const { createPaymentState } = require('./payments/payment-state');
const { createMutationMatcher } = require('./payments/mutation-matcher');
const { createMutationIngester } = require('./payments/mutation-ingester');
const { createBroadcaster } = require('./payments/payment-broadcaster');
const { createExpirySweeper } = require('./payments/expiry-sweeper');
const { createSelfHealingCollector } = require('./payments/self-healing-collector');
const { createMockMutationProvider } = require('./providers/mock-provider');
const { createQrisInteractiveProvider } = require('./providers/qris-interactive-provider');
const { createPaymentRouter } = require('./routes/payment');
const { createAdminRouter } = require('./routes/admin');
const { createWebhookRouter } = require('./routes/webhook');
const { createCsrfMiddleware } = require('./middleware/csrf');

/**
 * Create payment router (for Express integration)
 *
 * @param {Object} options - Configuration options
 * @param {string} [options.dbPath] - Database file path
 * @param {Object} options.db - Existing database instance (alternative to dbPath)
 * @param {Object} options.qris - QRIS configuration
 * @param {Object} [options.security] - Security configuration
 * @param {Object} [options.hooks] - Callback hooks
 * @param {Object} [options.collector] - Collector configuration
 * @returns {Router} Express router
 */
function createPaymentRouter(options = {}) {
  // Load config
  const config = createConfigGetter(loadConfig(options.config));

  // Initialize database
  const db = options.db || initDatabase(
    options.dbPath || config.get('dbPath') || './payments.db'
  );

  // QRIS generator
  const qrisGenerator = createQrisGenerator({
    staticString: options.qris?.staticString || config.get('qrisStaticString'),
    merchantName: options.qris?.merchantName || config.get('qrisMerchantName')
  });

  // Suffix allocator
  const suffixAllocator = createSuffixAllocator({
    db,
    min: config.get('suffixMin'),
    max: config.get('suffixMax'),
    expiryMinutes: config.get('qrisExpiryMinutes')
  });

  // Payment state machine
  const paymentState = createPaymentState({
    db,
    config,
    hooks: options.hooks
  });

  // Mutation matcher
  const mutationMatcher = createMutationMatcher({
    db,
    config,
    hooks: options.hooks
  });

  // Mutation ingester
  const mutationIngester = createMutationIngester({
    db,
    config
  });

  // SSE broadcaster
  const broadcaster = createBroadcaster({
    db,
    maxConnectionsPerUser: config.get('sseMaxConnectionsPerUser')
  });

  // Create CSRF middleware
  const csrf = createCsrfMiddleware({
    cookieOptions: {
      secure: config.isProduction()
    }
  });

  // Create routers
  const paymentRouter = createPaymentRouter({
    db,
    config,
    qrisGenerator,
    suffixAllocator,
    paymentState,
    broadcaster
  });

  const adminRouter = createAdminRouter({
    db,
    config,
    paymentState,
    mutationMatcher,
    hooks: options.hooks
  });

  const webhookRouter = createWebhookRouter({
    db,
    config,
    paymentState,
    mutationIngester,
    mutationMatcher,
    broadcaster,
    hooks: options.hooks
  });

  // Combine into single router
  const router = express.Router();

  // Apply CSRF to all routes
  router.use(csrf.csrfMiddleware);

  // Mount sub-routers
  router.use('/payment', paymentRouter);
  router.use('/payment/admin', adminRouter);
  router.use('/payment/webhook', webhookRouter);

  // Health check
  router.get('/health', (req, res) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString()
    });
  });

  // Attach cleanup function
  router.close = () => {
    closeDatabase(db);
  };

  return router;
}

/**
 * Create standalone payment app
 *
 * @param {Object} options - Configuration options
 * @returns {Object} Express app
 */
function createPaymentApp(options = {}) {
  const app = express();

  // Load config
  const config = createConfigGetter(loadConfig(options));

  // Initialize database
  const db = initDatabase(config.get('dbPath'));

  // QRIS generator
  const qrisGenerator = createQrisGenerator({
    staticString: options.qris?.staticString || config.get('qrisStaticString'),
    merchantName: options.qris?.merchantName || config.get('qrisMerchantName')
  });

  // Suffix allocator
  const suffixAllocator = createSuffixAllocator({
    db,
    min: config.get('suffixMin'),
    max: config.get('suffixMax'),
    expiryMinutes: config.get('qrisExpiryMinutes')
  });

  // Payment state machine
  const paymentState = createPaymentState({
    db,
    config,
    hooks: options.hooks
  });

  // Mutation matcher
  const mutationMatcher = createMutationMatcher({
    db,
    config,
    hooks: options.hooks
  });

  // Mutation ingester
  const mutationIngester = createMutationIngester({
    db,
    config
  });

  // SSE broadcaster
  const broadcaster = createBroadcaster({
    db,
    maxConnectionsPerUser: config.get('sseMaxConnectionsPerUser')
  });

  // Expiry sweeper
  const expirySweeper = createExpirySweeper({
    db,
    paymentState,
    broadcaster,
    intervalMs: 60000
  });

  // Start collector if enabled
  let collector = null;
  if (options.collector?.enabled) {
    let provider;

    // Use custom provider if provided
    if (options.customProvider) {
      provider = options.customProvider;
    } else {
      // Default to QRIS Interactive provider
      provider = createQrisInteractiveProvider({
        email: options.collector.email || process.env.QRIS_INTERACTIVE_EMAIL,
        password: options.collector.password || process.env.QRIS_INTERACTIVE_PASSWORD,
        lookbackDays: options.collector.lookbackDays || 1,
        debug: process.env.DEBUG === 'true'
      });
    }

    collector = createSelfHealingCollector({
      db,
      mutationIngester,
      mutationMatcher,
      paymentState,
      broadcaster,
      provider,
      config
    });

    collector.start();
  }

  // Create CSRF middleware
  const csrf = createCsrfMiddleware({
    cookieOptions: {
      secure: config.isProduction()
    }
  });

  // Middleware
  app.use(express.json());
  app.use(csrf.csrfMiddleware);

  // Routes
  const paymentRouter = createPaymentRouter({
    db,
    config,
    qrisGenerator,
    suffixAllocator,
    paymentState,
    broadcaster
  });

  const adminRouter = createAdminRouter({
    db,
    config,
    paymentState,
    mutationMatcher,
    hooks: options.hooks
  });

  const webhookRouter = createWebhookRouter({
    db,
    config,
    paymentState,
    mutationIngester,
    mutationMatcher,
    broadcaster,
    hooks: options.hooks
  });

  // Mount routes
  app.use('/api/payment', paymentRouter);
  app.use('/api/payment/admin', adminRouter);
  app.use('/api/payment/webhook', webhookRouter);

  // Health check
  app.get('/health', (req, res) => {
    res.json({
      status: 'healthy',
      version: require('../package.json').version,
      timestamp: new Date().toISOString(),
      config: {
        qrisConfigured: !!config.get('qrisStaticString'),
        collectorEnabled: !!collector,
        database: config.get('dbPath')
      }
    });
  });

  // Start expiry sweeper
  expirySweeper.start();

  // Cleanup on shutdown
  const shutdown = () => {
    console.log('Shutting down...');
    expirySweeper.stop();
    if (collector) collector.stop();
    closeDatabase(db);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Store references for cleanup
  app.db = db;
  app.config = config;
  app.expirySweeper = expirySweeper;
  app.collector = collector;

  return app;
}

module.exports = {
  createPaymentApp,
  createPaymentRouter,
  // Export for advanced usage
  createQrisGenerator,
  createSuffixAllocator,
  createPaymentState,
  createMutationMatcher,
  createMutationIngester,
  createBroadcaster,
  createExpirySweeper,
  createSelfHealingCollector,
  createMockMutationProvider,
  createQrisInteractiveProvider,
  loadConfig,
  initDatabase,
  closeDatabase
};
