-- QRIS Payment Simple - Database Schema
-- SQLite with WAL mode enabled

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- ============================================
-- Core Payments Table
-- ============================================
CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    merchant_order_id TEXT UNIQUE NOT NULL,

    -- External reference
    reference_id TEXT DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL,
    name TEXT DEFAULT '',

    -- Metadata (JSON)
    metadata TEXT DEFAULT '{}',

    -- QRIS specific
    qris_base_amount INTEGER,
    qris_suffix INTEGER,
    qris_full_amount INTEGER,
    qris_dynamic_string TEXT,
    qris_image_data_url TEXT,

    -- Payment status: PENDING, SUCCESS, FAILED, EXPIRED
    status TEXT NOT NULL DEFAULT 'PENDING',

    -- Reconciliation
    reference TEXT DEFAULT '',
    qr_string TEXT DEFAULT '',
    expires_at DATETIME,
    paid_at DATETIME,
    reconciled_via TEXT,  -- 'webhook', 'auto_verify', 'admin', 'manual'
    reconciled_by TEXT,

    -- Idempotency
    idempotency_key_hash TEXT,

    -- Timestamps
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for payments
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_reference_id ON payments(reference_id);
CREATE INDEX IF NOT EXISTS idx_payments_email ON payments(email);
CREATE INDEX IF NOT EXISTS idx_payments_idempotency ON payments(idempotency_key_hash)
    WHERE idempotency_key_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_expires ON payments(expires_at)
    WHERE status = 'PENDING';

-- ============================================
-- QRIS Suffix Allocation Pool
-- ============================================
CREATE TABLE IF NOT EXISTS qris_suffix_locks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    base_amount INTEGER NOT NULL,
    suffix INTEGER NOT NULL,
    merchant_order_id TEXT UNIQUE NOT NULL,
    locked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    released_at DATETIME
);

-- Ensure unique active suffix for each base amount
CREATE UNIQUE INDEX IF NOT EXISTS idx_qris_suffix_active
    ON qris_suffix_locks(base_amount, suffix)
    WHERE released_at IS NULL;

-- Index for cleanup
CREATE INDEX IF NOT EXISTS idx_suffix_expires ON qris_suffix_locks(expires_at)
    WHERE released_at IS NULL;

-- ============================================
-- Incoming Mutations
-- ============================================
CREATE TABLE IF NOT EXISTS incoming_mutations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL DEFAULT 'default',

    -- External reference
    provider_mutation_id TEXT,

    -- Deduplication hash
    content_hash TEXT UNIQUE NOT NULL,

    -- Mutation details
    direction TEXT NOT NULL DEFAULT 'IN',  -- IN or OUT
    amount INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'SUCCESS',  -- SUCCESS, PENDING, FAILED

    -- Timing
    transacted_at DATETIME NOT NULL,
    received_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    -- Masked PII
    payer_name_masked TEXT,
    payer_id_hash TEXT,
    note_masked TEXT,

    -- Matching
    matched_order_id TEXT,
    matched_at DATETIME
);

-- Index for auto-matching queries
CREATE INDEX IF NOT EXISTS idx_mutations_unmatched
    ON incoming_mutations(amount, status, transacted_at)
    WHERE matched_order_id IS NULL
      AND direction = 'IN'
      AND status = 'SUCCESS';

-- Index for provider deduplication
CREATE UNIQUE INDEX IF NOT EXISTS idx_mutations_provider_id
    ON incoming_mutations(provider, provider_mutation_id)
    WHERE provider_mutation_id IS NOT NULL;

-- ============================================
-- Reconciliation Audit Log
-- ============================================
CREATE TABLE IF NOT EXISTS payment_reconciliation_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    merchant_order_id TEXT NOT NULL,
    action TEXT NOT NULL,
    actor_id TEXT,
    source TEXT NOT NULL,  -- 'webhook', 'auto_verify', 'admin', 'manual'
    details TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_order
    ON payment_reconciliation_log(merchant_order_id, created_at DESC);

-- ============================================
-- Webhook Event Deduplication
-- ============================================
CREATE TABLE IF NOT EXISTS payment_webhook_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    event_id TEXT,
    event_hash TEXT UNIQUE NOT NULL,
    merchant_order_id TEXT,
    received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    processed_status TEXT NOT NULL DEFAULT 'PROCESSED'
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_lookup
    ON payment_webhook_events(provider, event_id);

-- ============================================
-- Idempotency Keys
-- ============================================
CREATE TABLE IF NOT EXISTS payment_idempotency_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_hash TEXT UNIQUE NOT NULL,
    merchant_order_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires
    ON payment_idempotency_keys(expires_at);

-- ============================================
-- Ambiguous Match Queue
-- ============================================
CREATE TABLE IF NOT EXISTS payment_ambiguous_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mutation_id INTEGER NOT NULL,
    merchant_order_id TEXT NOT NULL,
    confidence_score INTEGER NOT NULL,
    transacted_at DATETIME NOT NULL,
    amount INTEGER NOT NULL,
    payer_name_masked TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME,
    resolved_by TEXT,
    resolution TEXT,  -- 'matched', 'expired', 'manual_skip'
    resolution_details TEXT,

    FOREIGN KEY (mutation_id) REFERENCES incoming_mutations(id)
);

CREATE INDEX IF NOT EXISTS idx_ambiguous_unresolved
    ON payment_ambiguous_queue(created_at)
    WHERE resolved_at IS NULL;

-- ============================================
-- Rate Limiting
-- ============================================
CREATE TABLE IF NOT EXISTS payment_rate_limits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rate_hash TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_lookup
    ON payment_rate_limits(rate_hash, window_start);

-- ============================================
-- SSE Connection Tracking
-- ============================================
CREATE TABLE IF NOT EXISTS sse_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    merchant_order_id TEXT NOT NULL,
    connection_id TEXT UNIQUE NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_heartbeat DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sse_order
    ON sse_connections(merchant_order_id);

CREATE INDEX IF NOT EXISTS idx_sse_heartbeat
    ON sse_connections(last_heartbeat);

-- ============================================
-- Triggers
-- ============================================

-- Auto-update updated_at timestamp
CREATE TRIGGER IF NOT EXISTS trg_payments_updated
AFTER UPDATE ON payments
FOR EACH ROW
BEGIN
    UPDATE payments SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
END;

-- Make reconciliation log append-only
CREATE TRIGGER IF NOT EXISTS trg_reconciliation_no_update
BEFORE UPDATE ON payment_reconciliation_log
FOR EACH ROW WHEN OLD.action IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'payment_reconciliation_log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_reconciliation_no_delete
BEFORE DELETE ON payment_reconciliation_log
FOR EACH ROW WHEN OLD.action IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'payment_reconciliation_log is append-only');
END;

-- Make webhook events append-only
CREATE TRIGGER IF NOT EXISTS trg_webhook_no_update
BEFORE UPDATE ON payment_webhook_events
FOR EACH ROW WHEN OLD.event_hash IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'payment_webhook_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_webhook_no_delete
BEFORE DELETE ON payment_webhook_events
FOR EACH ROW WHEN OLD.event_hash IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'payment_webhook_events is append-only');
END;
