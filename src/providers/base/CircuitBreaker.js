/**
 * Circuit Breaker
 *
 * Prevents cascading failures by failing fast when a service is down.
 * Implements the circuit breaker pattern.
 */

/**
 * Circuit breaker states
 */
const CircuitBreakerState = {
  CLOSED: 'CLOSED',     // Normal operation
  OPEN: 'OPEN',         // Failing, reject requests
  HALF_OPEN: 'HALF_OPEN' // Testing recovery
};

/**
 * Circuit breaker events
 */
const CircuitBreakerEvent = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  REJECTED: 'rejected',
  TIMEOUT: 'timeout',
  RESET: 'reset',
  STATE_CHANGE: 'stateChange'
};

/**
 * Create a circuit breaker
 *
 * @param {Object} options - Configuration options
 * @param {string} options.name - Circuit name (for logging)
 * @param {number} [options.failureThreshold=5] - Failures before opening
 * @param {number} [options.successThreshold=2] - Successes to close from half-open
 * @param {number} [options.timeout=60000] - Time to wait before half-open (ms)
 * @param {number} [options.halfOpenRequests=3] - Requests to allow in half-open
 * @param {Function} [options.onStateChange] - Callback on state change
 * @returns {Object} Circuit breaker instance
 */
function createCircuitBreaker(options = {}) {
  const {
    name = 'circuit',
    failureThreshold = 5,
    successThreshold = 2,
    timeout = 60000,
    halfOpenRequests = 3,
    onStateChange = null
  } = options;

  let state = CircuitBreakerState.CLOSED;
  let failureCount = 0;
  let successCount = 0;
  let lastFailureTime = null;
  let halfOpenCount = 0;

  /**
   * Emit event
   */
  function emit(event, data = {}) {
    console.log(`[CircuitBreaker:${name}] ${event}`, data);
    if (onStateChange && event === CircuitBreakerEvent.STATE_CHANGE) {
      onStateChange(data.from, data.to);
    }
  }

  /**
   * Execute a function with circuit breaker protection
   *
   * @param {Function} fn - Function to execute
   * @param {Function} [fallback] - Fallback function when circuit is open
   * @returns {Promise<any>}
   */
  async function execute(fn, fallback = null) {
    // Check if we can proceed
    if (state === CircuitBreakerState.OPEN) {
      // Check if timeout has passed
      if (lastFailureTime && Date.now() - lastFailureTime >= timeout) {
        state = CircuitBreakerState.HALF_OPEN;
        halfOpenCount = 0;
        emit(CircuitBreakerEvent.STATE_CHANGE, {
          from: CircuitBreakerState.OPEN,
          to: CircuitBreakerState.HALF_OPEN
        });
      } else {
        emit(CircuitBreakerEvent.REJECTED, { reason: 'circuit_open' });

        if (fallback) {
          return fallback();
        }

        throw new Error(`Circuit breaker ${name} is OPEN`);
      }
    }

    // Allow request in half-open if under limit
    if (state === CircuitBreakerState.HALF_OPEN) {
      if (halfOpenCount >= halfOpenRequests) {
        emit(CircuitBreakerEvent.REJECTED, { reason: 'half_open_limit' });
        throw new Error(`Circuit breaker ${name} is HALF_OPEN, max requests reached`);
      }
      halfOpenCount++;
    }

    try {
      const result = await fn();

      // Record success
      if (state === CircuitBreakerState.HALF_OPEN) {
        successCount++;
        if (successCount >= successThreshold) {
          state = CircuitBreakerState.CLOSED;
          failureCount = 0;
          successCount = 0;
          emit(CircuitBreakerEvent.STATE_CHANGE, {
            from: CircuitBreakerState.HALF_OPEN,
            to: CircuitBreakerState.CLOSED
          });
        }
      } else {
        failureCount = 0;
      }

      emit(CircuitBreakerEvent.SUCCESS);
      return result;

    } catch (error) {
      failureCount++;
      lastFailureTime = Date.now();
      successCount = 0;

      emit(CircuitBreakerEvent.FAILURE, { error: error.message });

      if (state === CircuitBreakerState.HALF_OPEN) {
        // Immediately open on failure in half-open
        state = CircuitBreakerState.OPEN;
        emit(CircuitBreakerEvent.STATE_CHANGE, {
          from: CircuitBreakerState.HALF_OPEN,
          to: CircuitBreakerState.OPEN
        });
      } else if (failureCount >= failureThreshold) {
        state = CircuitBreakerState.OPEN;
        emit(CircuitBreakerEvent.STATE_CHANGE, {
          from: CircuitBreakerState.CLOSED,
          to: CircuitBreakerState.OPEN
        });
      }

      throw error;
    }
  }

  /**
   * Record a failure without executing
   */
  function recordFailure() {
    failureCount++;
    lastFailureTime = Date.now();

    if (failureCount >= failureThreshold) {
      state = CircuitBreakerState.OPEN;
      emit(CircuitBreakerEvent.STATE_CHANGE, {
        from: CircuitBreakerState.CLOSED,
        to: CircuitBreakerState.OPEN
      });
    }
  }

  /**
   * Record a success without executing
   */
  function recordSuccess() {
    if (state === CircuitBreakerState.HALF_OPEN) {
      successCount++;
      if (successCount >= successThreshold) {
        state = CircuitBreakerState.CLOSED;
        failureCount = 0;
        successCount = 0;
        emit(CircuitBreakerEvent.STATE_CHANGE, {
          from: CircuitBreakerState.HALF_OPEN,
          to: CircuitBreakerState.CLOSED
        });
      }
    } else {
      failureCount = 0;
    }
  }

  /**
   * Get circuit breaker status
   */
  function getStatus() {
    return {
      name,
      state,
      failureCount,
      successCount,
      failureThreshold,
      successThreshold,
      timeout,
      lastFailureTime,
      timeUntilRetry: state === CircuitBreakerState.OPEN && lastFailureTime
        ? Math.max(0, timeout - (Date.now() - lastFailureTime))
        : 0
    };
  }

  /**
   * Force state change (for testing/admin)
   */
  function forceState(newState) {
    const oldState = state;
    state = newState;

    if (newState === CircuitBreakerState.CLOSED) {
      failureCount = 0;
      successCount = 0;
    } else if (newState === CircuitBreakerState.HALF_OPEN) {
      halfOpenCount = 0;
    }

    emit(CircuitBreakerEvent.STATE_CHANGE, { from: oldState, to: newState });
  }

  /**
   * Reset circuit breaker
   */
  function reset() {
    state = CircuitBreakerState.CLOSED;
    failureCount = 0;
    successCount = 0;
    halfOpenCount = 0;
    lastFailureTime = null;
    emit(CircuitBreakerEvent.RESET);
  }

  return {
    execute,
    recordFailure,
    recordSuccess,
    getStatus,
    forceState,
    reset,
    State: CircuitBreakerState
  };
}

module.exports = {
  createCircuitBreaker,
  CircuitBreakerState,
  CircuitBreakerEvent
};
