/**
 * Payment Broadcaster (SSE)
 *
 * Server-Sent Events pub/sub for real-time payment status updates.
 */

const crypto = require('crypto');

/**
 * Create SSE broadcaster
 *
 * @param {Object} options - Configuration options
 * @param {Object} options.db - Database instance
 * @param {number} [options.maxConnectionsPerOrder=10] - Max SSE connections per order
 * @param {number} [options.maxConnectionsPerUser=3] - Max SSE connections per user/IP
 * @param {number} [options.heartbeatInterval=30000] - Heartbeat interval (ms)
 * @returns {Object} Broadcaster functions
 */
function createBroadcaster(options = {}) {
  const {
    db,
    maxConnectionsPerOrder = 10,
    maxConnectionsPerUser = 3,
    heartbeatInterval = 30000
  } = options;

  if (!db) {
    throw new Error('Broadcaster requires database instance');
  }

  // Connection storage (in-memory for simple deployment)
  // For production, use Redis pub/sub
  const connections = new Map();
  const orderSubscribers = new Map();

  // Prepared statements
  const insertConnectionStmt = db.prepare(`
    INSERT INTO sse_connections (merchant_order_id, connection_id, ip_address, user_agent)
    VALUES (?, ?, ?, ?)
  `);

  const removeConnectionStmt = db.prepare(`
    DELETE FROM sse_connections WHERE connection_id = ?
  `);

  const updateHeartbeatStmt = db.prepare(`
    UPDATE sse_connections SET last_heartbeat = datetime('now')
    WHERE connection_id = ?
  `);

  const cleanupStaleConnectionsStmt = db.prepare(`
    DELETE FROM sse_connections
    WHERE last_heartbeat < datetime('now', '-' || ? || ' seconds')
  `);

  const getConnectionCountStmt = db.prepare(`
    SELECT COUNT(*) as count FROM sse_connections
    WHERE merchant_order_id = ?
  `);

  /**
   * Generate unique connection ID
   */
  function generateConnectionId() {
    return crypto.randomBytes(16).toString('hex');
  }

  /**
   * Check connection limits
   *
   * @param {string} merchantOrderId - Order ID
   * @param {string} ipAddress - Client IP
   * @returns {{ allowed: boolean, reason?: string }}
   */
  function checkLimits(merchantOrderId, ipAddress) {
    // Check per-order limit
    const orderCount = getConnectionCountStmt.get(merchantOrderId);
    if (orderCount.count >= maxConnectionsPerOrder) {
      return { allowed: false, reason: 'max_connections_per_order' };
    }

    // Check per-user limit (by IP)
    const ipStmt = db.prepare(`
      SELECT COUNT(*) as count FROM sse_connections
      WHERE ip_address = ?
    `);
    const ipCount = ipStmt.get(ipAddress);
    if (ipCount.count >= maxConnectionsPerUser) {
      return { allowed: false, reason: 'max_connections_per_user' };
    }

    return { allowed: true };
  }

  /**
   * Subscribe to payment updates
   *
   * @param {Object} options - Subscription options
   * @returns {{ success: boolean, connectionId?: string, error?: string }}
   */
  function subscribe(options) {
    const { merchantOrderId, ipAddress, userAgent } = options;

    // Check limits
    const limits = checkLimits(merchantOrderId, ipAddress);
    if (!limits.allowed) {
      return { success: false, error: limits.reason };
    }

    const connectionId = generateConnectionId();

    // Store in memory
    connections.set(connectionId, {
      merchantOrderId,
      ipAddress,
      userAgent,
      createdAt: Date.now(),
      lastActivity: Date.now()
    });

    // Add to order subscribers
    if (!orderSubscribers.has(merchantOrderId)) {
      orderSubscribers.set(merchantOrderId, new Set());
    }
    orderSubscribers.get(merchantOrderId).add(connectionId);

    // Persist to DB
    try {
      insertConnectionStmt.run(merchantOrderId, connectionId, ipAddress, userAgent);
    } catch (error) {
      console.error('Failed to persist SSE connection:', error);
    }

    return { success: true, connectionId };
  }

  /**
   * Unsubscribe (close connection)
   *
   * @param {string} connectionId - Connection ID
   */
  function unsubscribe(connectionId) {
    const conn = connections.get(connectionId);
    if (conn) {
      // Remove from order subscribers
      const subscribers = orderSubscribers.get(conn.merchantOrderId);
      if (subscribers) {
        subscribers.delete(connectionId);
        if (subscribers.size === 0) {
          orderSubscribers.delete(conn.merchantOrderId);
        }
      }

      // Remove from memory
      connections.delete(connectionId);
    }

    // Remove from DB
    try {
      removeConnectionStmt.run(connectionId);
    } catch (error) {
      console.error('Failed to remove SSE connection:', error);
    }
  }

  /**
   * Broadcast payment update to subscribers
   *
   * @param {string} merchantOrderId - Order ID
   * @param {Object} data - Event data
   */
  function broadcast(merchantOrderId, data) {
    const subscribers = orderSubscribers.get(merchantOrderId);
    if (!subscribers || subscribers.size === 0) {
      return;
    }

    const event = formatSseEvent('payment_update', data);
    const heartbeat = formatSseEvent('heartbeat', { timestamp: Date.now() });

    for (const connectionId of subscribers) {
      const conn = connections.get(connectionId);
      if (conn) {
        try {
          conn.res.write(event);
          conn.lastActivity = Date.now();
        } catch (error) {
          // Connection closed, clean up
          unsubscribe(connectionId);
        }
      }
    }
  }

  /**
   * Broadcast to all subscribers
   *
   * @param {Object} data - Event data
   */
  function broadcastAll(data) {
    for (const merchantOrderId of orderSubscribers.keys()) {
      broadcast(merchantOrderId, data);
    }
  }

  /**
   * Format SSE event
   *
   * @param {string} event - Event type
   * @param {Object} data - Event data
   * @returns {string} SSE formatted string
   */
  function formatSseEvent(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  /**
   * Create SSE response handler
   *
   * @param {string} merchantOrderId - Order ID
   * @param {Object} req - Express request
   * @param {Object} res - Express response
   * @returns {{ unsubscribe: Function }}
   */
  function createSseStream(merchantOrderId, req, res) {
    const ipAddress = req.clientIp || req.ip || 'unknown';
    const userAgent = req.headers['user-agent'] || '';

    // Subscribe
    const subResult = subscribe({
      merchantOrderId,
      ipAddress,
      userAgent
    });

    if (!subResult.success) {
      return {
        error: subResult.error,
        unsubscribe: () => {}
      };
    }

    const connectionId = subResult.connectionId;
    const conn = connections.get(connectionId);

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no' // Disable nginx buffering
    });

    // Send initial connection event
    res.write(formatSseEvent('connected', {
      connectionId,
      merchantOrderId
    }));

    // Attach write function to connection
    conn.res = res;

    // Set up heartbeat
    const heartbeatInterval = setInterval(() => {
      if (conn && !conn.res.destroyed) {
        try {
          conn.res.write(formatSseEvent('heartbeat', {
            timestamp: Date.now()
          }));
          updateHeartbeatStmt.run(connectionId);
        } catch (error) {
          clearInterval(heartbeatInterval);
          unsubscribe(connectionId);
        }
      }
    }, 30000);

    // Handle client disconnect
    req.on('close', () => {
      clearInterval(heartbeatInterval);
      unsubscribe(connectionId);
    });

    req.on('error', () => {
      clearInterval(heartbeatInterval);
      unsubscribe(connectionId);
    });

    return {
      connectionId,
      unsubscribe: () => {
        clearInterval(heartbeatInterval);
        unsubscribe(connectionId);
      }
    };
  }

  /**
   * Cleanup stale connections
   *
   * @param {number} [staleSeconds=60] - Seconds before connection is considered stale
   * @returns {number} Number of cleaned connections
   */
  function cleanupStale(staleSeconds = 60) {
    const before = connections.size;

    // Get stale connection IDs
    const staleThreshold = Date.now() - (staleSeconds * 1000);
    const staleIds = [];

    for (const [id, conn] of connections) {
      if (conn.lastActivity < staleThreshold) {
        staleIds.push(id);
      }
    }

    // Remove stale connections
    for (const id of staleIds) {
      unsubscribe(id);
    }

    // Also cleanup in DB
    cleanupStaleConnectionsStmt.run(staleSeconds);

    return before - connections.size;
  }

  /**
   * Get broadcaster statistics
   *
   * @returns {Object}
   */
  function getStats() {
    let totalConnections = 0;
    const byOrder = {};

    for (const [orderId, subs] of orderSubscribers) {
      totalConnections += subs.size;
      byOrder[orderId] = subs.size;
    }

    return {
      totalConnections,
      totalOrdersSubscribed: orderSubscribers.size,
      byOrder,
      memoryConnections: connections.size
    };
  }

  // Periodic cleanup
  setInterval(() => cleanupStale(60), 60000);

  return {
    subscribe,
    unsubscribe,
    broadcast,
    broadcastAll,
    createSseStream,
    cleanupStale,
    getStats,
    formatSseEvent
  };
}

module.exports = {
  createBroadcaster
};
