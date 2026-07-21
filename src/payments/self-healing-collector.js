/**
 * Self-Healing Collector
 *
 * Adaptive polling collector with circuit breaker pattern.
 * Collects mutations from providers with automatic rate adjustment.
 */

/**
 * Circuit breaker states
 */
const CircuitState = {
  CLOSED: 'CLOSED',   // Normal operation
  OPEN: 'OPEN',       // Failing, reject requests
  HALF_OPEN: 'HALF_OPEN'  // Testing if recovery is possible
};

/**
 * Collector states (temperature)
 */
const CollectorState = {
  HOT: 'HOT',         // Fast polling (3s)
  WARM: 'WARM',       // Medium polling (10s)
  COLD: 'COLD'        // Slow polling (60s)
};

/**
 * Create self-healing collector
 *
 * @param {Object} options - Configuration options
 * @param {Object} options.db - Database instance
 * @param {Object} options.mutationIngester - Mutation ingester
 * @param {Object} options.mutationMatcher - Mutation matcher
 * @param {Object} options.paymentState - Payment state machine
 * @param {Object} options.broadcaster - SSE broadcaster
 * @param {Object} options.provider - Mutation provider instance
 * @param {Object} [options.config] - Config getter
 * @returns {Object} Collector functions
 */
function createSelfHealingCollector(options = {}) {
  const {
    db,
    mutationIngester,
    mutationMatcher,
    paymentState,
    broadcaster,
    provider,
    config
  } = options;

  if (!db) {
    throw new Error('Collector requires database instance');
  }

  if (!provider) {
    throw new Error('Collector requires a mutation provider');
  }

  // Circuit breaker config
  const circuitConfig = {
    failureThreshold: config?.get?.('COLLECTOR_FAILURE_THRESHOLD') || 3,
    recoveryTimeoutMs: config?.get?.('COLLECTOR_RECOVERY_TIMEOUT_MS') || 5 * 60 * 1000,
    halfOpenRequests: 1
  };

  // Adaptive polling config
  const pollingConfig = {
    [CollectorState.HOT]: config?.get?.('COLLECTOR_HOT_INTERVAL_MS') || 3000,
    [CollectorState.WARM]: config?.get?.('COLLECTOR_WARM_INTERVAL_MS') || 10000,
    [CollectorState.COLD]: config?.get?.('COLLECTOR_COLD_INTERVAL_MS') || 60000
  };

  // State
  let circuitState = CircuitState.CLOSED;
  let collectorState = CollectorState.WARM;
  let failureCount = 0;
  let lastFailureTime = null;
  let halfOpenAttempts = 0;
  let intervalHandle = null;
  let isRunning = false;

  let stats = {
    totalRuns: 0,
    successfulRuns: 0,
    failedRuns: 0,
    mutationsCollected: 0,
    paymentsMatched: 0,
    circuitTransitions: 0,
    stateTransitions: 0,
    lastRun: null
  };

  /**
   * Record a failure for circuit breaker
   */
  function recordFailure() {
    failureCount++;
    lastFailureTime = Date.now();

    if (circuitState === CircuitState.CLOSED) {
      if (failureCount >= circuitConfig.failureThreshold) {
        circuitState = CircuitState.OPEN;
        stats.circuitTransitions++;
        console.log('[Collector] Circuit OPEN - too many failures');
      }
    } else if (circuitState === CircuitState.HALF_OPEN) {
      circuitState = CircuitState.OPEN;
      stats.circuitTransitions++;
      halfOpenAttempts = 0;
      console.log('[Collector] Circuit OPEN - recovery failed');
    }
  }

  /**
   * Record a success for circuit breaker
   */
  function recordSuccess() {
    if (circuitState === CircuitState.HALF_OPEN) {
      circuitState = CircuitState.CLOSED;
      stats.circuitTransitions++;
      console.log('[Collector] Circuit CLOSED - recovery successful');
    }
    failureCount = 0;
  }

  /**
   * Update collector state based on activity
   *
   * @param {number} matchesFound - Number of matches found
   */
  function updateCollectorState(matchesFound) {
    const newState = matchesFound > 0 ? CollectorState.HOT : collectorState;

    if (newState !== collectorState) {
      collectorState = newState;
      stats.stateTransitions++;
      console.log(`[Collector] State: ${collectorState} (matches: ${matchesFound})`);

      // Reset interval
      if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = setInterval(runCollect, pollingConfig[collectorState]);
      }
    }
  }

  /**
   * Check if circuit allows request
   */
  function canProceed() {
    if (circuitState === CircuitState.CLOSED) {
      return true;
    }

    if (circuitState === CircuitState.OPEN) {
      // Check if recovery timeout has passed
      if (Date.now() - lastFailureTime >= circuitConfig.recoveryTimeoutMs) {
        circuitState = CircuitState.HALF_OPEN;
        stats.circuitTransitions++;
        halfOpenAttempts = 0;
        console.log('[Collector] Circuit HALF_OPEN - testing recovery');
        return true;
      }
      return false;
    }

    // HALF_OPEN - allow limited requests
    return halfOpenAttempts < circuitConfig.halfOpenRequests;
  }

  /**
   * Run a single collection cycle
   *
   * @returns {Object} Collection results
   */
  async function runCollect() {
    if (!canProceed()) {
      return { skipped: 'circuit_open' };
    }

    const startTime = Date.now();

    try {
      // Fetch mutations from provider
      const rawMutations = await provider.fetchMutations();

      if (!rawMutations || rawMutations.length === 0) {
        stats.successfulRuns++;
        stats.lastRun = new Date().toISOString();
        recordSuccess();
        return { collected: 0, matches: 0 };
      }

      // Ingest mutations
      const ingestResult = mutationIngester.ingestBatch(rawMutations, provider.name || 'collector');

      if (!ingestResult.success) {
        throw new Error(ingestResult.error || 'Ingest failed');
      }

      stats.mutationsCollected += ingestResult.inserted;

      // Get unmatched mutations and match them
      const unmatched = mutationIngester.getUnmatchedMutations({ limit: 50 });
      let matchesFound = 0;

      for (const mutation of unmatched) {
        const matchResult = mutationMatcher.processMatch(mutation);

        if (matchResult.matched) {
          matchesFound++;
          stats.paymentsMatched++;

          // Mark payment as success
          paymentState.markPaymentSuccess({
            merchantOrderId: matchResult.merchantOrderId,
            source: 'auto_verify',
            details: {
              mutationId: mutation.id,
              confidence: matchResult.confidence
            }
          });

          // Broadcast update
          broadcaster?.broadcast(matchResult.merchantOrderId, {
            event: 'payment_success',
            merchantOrderId: matchResult.merchantOrderId,
            source: 'auto_verify',
            timestamp: new Date().toISOString()
          });
        }
      }

      // Update state based on activity
      updateCollectorState(matchesFound);

      stats.successfulRuns++;
      stats.totalRuns++;
      stats.lastRun = new Date().toISOString();

      // Track half-open attempts
      if (circuitState === CircuitState.HALF_OPEN) {
        halfOpenAttempts++;
      }

      recordSuccess();

      return {
        collected: ingestResult.inserted,
        duplicates: ingestResult.duplicates,
        matches: matchesFound,
        duration: Date.now() - startTime
      };

    } catch (error) {
      console.error('[Collector] Collection failed:', error);
      stats.failedRuns++;
      stats.totalRuns++;
      stats.lastRun = new Date().toISOString();
      recordFailure();

      // Slow down on failure
      if (collectorState !== CollectorState.COLD) {
        collectorState = CollectorState.COLD;
        stats.stateTransitions++;
      }

      return {
        error: error.message,
        duration: Date.now() - startTime
      };
    }
  }

  /**
   * Start the collector
   */
  async function start() {
    if (intervalHandle) {
      return { started: false, reason: 'already_running' };
    }

    console.log('[Collector] Starting self-healing collector');

    // Connect to provider
    if (provider.connect) {
      await provider.connect();
    }

    isRunning = true;

    // Start polling
    intervalHandle = setInterval(async () => {
      await runCollect();
    }, pollingConfig[collectorState]);

    return {
      started: true,
      initialState: collectorState,
      pollingInterval: pollingConfig[collectorState]
    };
  }

  /**
   * Stop the collector
   */
  async function stop() {
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }

    isRunning = false;

    // Disconnect from provider
    if (provider.disconnect) {
      await provider.disconnect();
    }

    console.log('[Collector] Stopped');
  }

  /**
   * Force a collection run
   */
  async function forceCollect() {
    return runCollect();
  }

  /**
   * Get collector status
   */
  function getStatus() {
    return {
      running: isRunning,
      circuitState,
      collectorState,
      failureCount,
      pollingInterval: pollingConfig[collectorState],
      ...stats
    };
  }

  /**
   * Reset circuit breaker
   */
  function resetCircuit() {
    circuitState = CircuitState.CLOSED;
    failureCount = 0;
    halfOpenAttempts = 0;
    console.log('[Collector] Circuit breaker reset');
  }

  return {
    start,
    stop,
    runCollect: forceCollect,
    getStatus,
    resetCircuit,
    getCircuitState: () => circuitState,
    getCollectorState: () => collectorState
  };
}

module.exports = {
  createSelfHealingCollector,
  CircuitState,
  CollectorState
};
