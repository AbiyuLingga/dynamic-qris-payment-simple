#!/usr/bin/env node

/**
 * QRIS Payment Simple - Standalone Server
 *
 * Run as: node standalone.js
 *
 * Environment variables (or .env file):
 *   QRIS_STATIC_STRING - Your QRIS static string
 *   QRIS_MERCHANT_NAME - Merchant display name
 *   QRIS_EXPIRY_MINUTES - Payment expiry time (default: 20)
 *   PAYMENT_WEBHOOK_SECRET - HMAC secret for webhooks
 *   HASH_PEPPER - Pepper for hashing
 *   DATABASE_PATH - SQLite database path
 *   PORT - Server port (default: 3000)
 *   NODE_ENV - development or production
 *   MUTATION_COLLECTOR_ENABLED - Enable auto-collector (true/false)
 *
 * QRIS Interactive Provider (merchant.qris.interactive.co.id):
 *   QRIS_INTERACTIVE_EMAIL - Merchant email
 *   QRIS_INTERACTIVE_PASSWORD - Merchant password
 *   QRIS_LOOKBACK_DAYS - Days to look back (default: 1)
 */

const { createPaymentApp } = require('./src');

// Load .env file if exists
try {
  require('fs').readFileSync('.env', 'utf8')
    .split('\n')
    .forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex > 0) {
          const key = trimmed.substring(0, eqIndex).trim();
          const value = trimmed.substring(eqIndex + 1).trim();
          if (!process.env[key]) {
            process.env[key] = value;
          }
        }
      }
    });
} catch (error) {
  // .env file not found, continue with env vars
}

// Configuration
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Example hooks (customize these for your application)
const hooks = {
  /**
   * Called when a payment succeeds
   */
  onPaymentSuccess: async (db, payment) => {
    console.log(`[HOOK] Payment succeeded: ${payment.merchant_order_id}`);
    console.log(`  Amount: ${payment.qris_full_amount}`);
    console.log(`  Email: ${payment.email}`);
    console.log(`  Metadata: ${payment.metadata}`);

    // TODO: Grant access to your product here
    // Example: await grantProductAccess(payment.reference_id, payment.email);

    // TODO: Send confirmation email
    // Example: await sendPaymentConfirmation(payment.email, payment);
  },

  /**
   * Called when a payment fails
   */
  onPaymentFailed: async (db, payment, reason) => {
    console.log(`[HOOK] Payment failed: ${payment.merchant_order_id}`);
    console.log(`  Reason: ${reason}`);

    // TODO: Handle failed payment
  },

  /**
   * Called when a payment expires
   */
  onPaymentExpired: async (db, payment) => {
    console.log(`[HOOK] Payment expired: ${payment.merchant_order_id}`);

    // TODO: Clean up pending order
  },

  /**
   * Called when a mutation match is ambiguous
   */
  onAmbiguousMatch: async (db, mutation, candidates) => {
    console.log(`[HOOK] Ambiguous match for mutation: ${mutation.id}`);
    console.log(`  Candidates: ${candidates.length}`);
    for (const c of candidates) {
      console.log(`    - ${c.merchant_order_id} (confidence: ${c.confidence}%)`);
    }

    // TODO: Queue for manual review or apply business rules
  },

  /**
   * Admin authorization callback
   */
  authorizeAdmin: (req) => {
    // Check session
    if (req.session?.user?.role === 'admin') {
      return true;
    }

    // Check API key for programmatic access
    const apiKey = req.headers['x-admin-api-key'];
    if (apiKey === process.env.ADMIN_API_KEY) {
      return true;
    }

    return false;
  }
};

// Create app
const app = createPaymentApp({
  // QRIS Configuration
  qris: {
    staticString: process.env.QRIS_STATIC_STRING,
    merchantName: process.env.QRIS_MERCHANT_NAME || 'Demo Merchant'
  },

  // Security
  security: {
    webhookSecret: process.env.PAYMENT_WEBHOOK_SECRET,
    hashPepper: process.env.HASH_PEPPER
  },

  // Collector (uses QRIS Interactive by default)
  collector: {
    enabled: process.env.MUTATION_COLLECTOR_ENABLED === 'true',
    email: process.env.QRIS_INTERACTIVE_EMAIL,
    password: process.env.QRIS_INTERACTIVE_PASSWORD,
    lookbackDays: parseInt(process.env.QRIS_LOOKBACK_DAYS) || 1
  },

  // Hooks
  hooks,

  // Custom provider (optional)
  // Uncomment to use mock provider
  // customProvider: require('./src/providers/mock-provider')({
  //   frequencyMs: 5000,
  //   amounts: [99001, 99099, 199001, 199099]
  // })
});

// Start server
app.listen(PORT, HOST, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║                                                              ║');
  console.log('║   QRIS Payment Simple Server                                 ║');
  console.log('║   Standalone Payment Gateway                                  ║');
  console.log('║                                                              ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║                                                              ║');
  console.log(`║   Server running at http://${HOST}:${PORT}                       ║`);
  console.log('║                                                              ║');
  console.log('║   Endpoints:                                                 ║');
  console.log('║   - POST   /api/payment/create     Create payment             ║');
  console.log('║   - GET    /api/payment/status/:id Check status               ║');
  console.log('║   - GET    /api/payment/stream/:id SSE stream                 ║');
  console.log('║   - GET    /api/payment/invoices   Payment history            ║');
  console.log('║   - POST   /api/payment/webhook/*  Webhook endpoints          ║');
  console.log('║   - GET    /api/payment/admin/*    Admin endpoints             ║');
  console.log('║   - GET    /health                Health check                ║');
  console.log('║                                                              ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║                                                              ║');

  if (process.env.QRIS_STATIC_STRING) {
    console.log('║   ✅ QRIS Static String configured                            ║');
  } else {
    console.log('║   ⚠️  QRIS_STATIC_STRING not set (set in .env or env var)    ║');
  }

  if (process.env.NODE_ENV === 'production') {
    console.log('║   🔒 Production mode                                          ║');
  } else {
    console.log('║   🔓 Development mode                                          ║');
  }

  console.log('║                                                              ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
});

// Handle errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
});
