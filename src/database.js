/**
 * Database Initialization
 *
 * Sets up SQLite database with schema and WAL mode.
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

/**
 * Initialize database
 *
 * @param {string} dbPath - Path to database file
 * @param {Object} options - Options
 * @param {boolean} [options.walMode=true] - Enable WAL mode
 * @param {boolean} [options.foreignKeys=true] - Enable foreign keys
 * @param {string} [options.schemaPath] - Path to schema.sql
 * @returns {Object} Database instance
 */
function initDatabase(dbPath, options = {}) {
  const {
    walMode = true,
    foreignKeys = true,
    schemaPath = null
  } = options;

  // Ensure directory exists
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // Create database
  const db = new Database(dbPath);

  // Performance settings
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('temp_store = MEMORY');
  db.pragma('mmap_size = 268435456'); // 256MB

  // Load and execute schema
  if (schemaPath && fs.existsSync(schemaPath)) {
    const schema = fs.readFileSync(schemaPath, 'utf8');
    db.exec(schema);
  } else {
    // Try default path
    const defaultSchemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
    if (fs.existsSync(defaultSchemaPath)) {
      const schema = fs.readFileSync(defaultSchemaPath, 'utf8');
      db.exec(schema);
    }
  }

  // Enable WAL checkpointing for better concurrency
  if (walMode) {
    db.pragma('wal_autocheckpoint = 1000');
  }

  return db;
}

/**
 * Get database statistics
 *
 * @param {Object} db - Database instance
 * @returns {Object} Statistics
 */
function getDbStats(db) {
  const stats = {};

  // Table sizes
  const tables = [
    'payments',
    'incoming_mutations',
    'qris_suffix_locks',
    'payment_reconciliation_log',
    'payment_webhook_events',
    'payment_idempotency_keys',
    'payment_ambiguous_queue',
    'payment_rate_limits',
    'sse_connections'
  ];

  for (const table of tables) {
    try {
      const result = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get();
      stats[table] = result.count;
    } catch {
      stats[table] = 0;
    }
  }

  // Database file size
  try {
    const dbPath = db.name;
    if (fs.existsSync(dbPath)) {
      const size = fs.statSync(dbPath).size;
      stats.dbSizeBytes = size;
      stats.dbSizeMB = (size / (1024 * 1024)).toFixed(2);
    }
  } catch {
    // Ignore
  }

  return stats;
}

/**
 * Cleanup old data
 *
 * @param {Object} db - Database instance
 * @param {Object} options - Cleanup options
 */
function cleanupOldData(db, options = {}) {
  const {
    paymentRetentionDays = 30,
    mutationRetentionDays = 7,
    rateLimitRetentionHours = 24,
    ambiguousRetentionDays = 14
  } = options;

  const results = {};

  // Clean up expired payments
  const expiredRetention = new Date();
  expiredRetention.setDate(expiredRetention.getDate() - paymentRetentionDays);

  const expiredPayments = db.prepare(`
    UPDATE payments SET status = 'EXPIRED'
    WHERE status = 'PENDING' AND expires_at < ?
  `).run(expiredRetention.toISOString());
  results.expiredPayments = expiredPayments.changes;

  // Clean up old reconciliation logs
  const logRetention = new Date();
  logRetention.setDate(logRetention.getDate() - paymentRetentionDays);

  const oldLogs = db.prepare(`
    DELETE FROM payment_reconciliation_log
    WHERE created_at < ?
  `).run(logRetention.toISOString());
  results.deletedLogs = oldLogs.changes;

  // Clean up old rate limits
  const rateLimitRetention = Date.now() - (rateLimitRetentionHours * 60 * 60 * 1000);

  const oldRateLimits = db.prepare(`
    DELETE FROM payment_rate_limits
    WHERE window_start < ?
  `).run(rateLimitRetention);
  results.deletedRateLimits = oldRateLimits.changes;

  // Clean up old SSE connections (inactive for 1 hour)
  const sseTimeout = new Date();
  sseTimeout.setHours(sseTimeout.getHours() - 1);

  const oldConnections = db.prepare(`
    DELETE FROM sse_connections
    WHERE last_heartbeat < ?
  `).run(sseTimeout.toISOString());
  results.deletedSseConnections = oldConnections.changes;

  // Vacuum if needed
  if (results.deletedLogs + results.deletedRateLimits > 1000) {
    db.exec('VACUUM');
  }

  return results;
}

/**
 * Close database gracefully
 *
 * @param {Object} db - Database instance
 */
function closeDatabase(db) {
  try {
    // Checkpoint WAL before closing
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  } catch (error) {
    console.error('Error closing database:', error);
  }
}

/**
 * Create test database (in-memory)
 *
 * @param {string} [schemaPath] - Optional schema path
 * @returns {Object} In-memory database
 */
function createTestDatabase(schemaPath = null) {
  const db = new Database(':memory:');
  db.pragma('journal_mode = MEMORY');
  db.pragma('foreign_keys = ON');

  if (schemaPath && fs.existsSync(schemaPath)) {
    const schema = fs.readFileSync(schemaPath, 'utf8');
    db.exec(schema);
  }

  return db;
}

module.exports = {
  initDatabase,
  getDbStats,
  cleanupOldData,
  closeDatabase,
  createTestDatabase
};
