/**
 * Mutation Provider Interface
 *
 * Abstract base class for mutation source providers.
 * Implement this interface to add custom mutation sources.
 */

/**
 * Abstract Mutation Provider
 *
 * @abstract
 */
class MutationProvider {
  /**
   * Provider name (for logging/debugging)
   * @type {string}
   */
  name = 'abstract';

  /**
   * Connect to the mutation source
   *
   * @abstract
   * @returns {Promise<void>}
   */
  async connect() {
    throw new Error('Not implemented');
  }

  /**
   * Disconnect from the mutation source
   *
   * @abstract
   * @returns {Promise<void>}
   */
  async disconnect() {
    throw new Error('Not implemented');
  }

  /**
   * Fetch new mutations since last fetch
   *
   * @abstract
   * @returns {Promise<Object[]>} Array of mutation objects
   */
  async fetchMutations() {
    throw new Error('Not implemented');
  }

  /**
   * Get provider status
   *
   * @returns {Object} Status object
   */
  getStatus() {
    return {
      name: this.name,
      connected: this.isConnected || false
    };
  }
}

/**
 * Create a mock mutation provider for testing
 *
 * @param {Object} options - Configuration options
 * @param {number} [options.frequency=5000] - How often to generate mutations (ms)
 * @param {number[]} [options.amounts] - Amounts to generate
 * @returns {Object} Mock provider instance
 */
function createMockProvider(options = {}) {
  const {
    frequency = 5000,
    amounts = [100001, 100099, 200001, 200099]
  } = options;

  let intervalHandle = null;
  let isConnected = false;
  let mutations = [];
  let index = 0;

  return {
    name: 'mock',

    async connect() {
      isConnected = true;
      console.log('[MockProvider] Connected');

      // Start generating fake mutations
      intervalHandle = setInterval(() => {
        const amount = amounts[index % amounts.length];
        const mutation = {
          providerMutationId: `MOCK-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          amount,
          direction: 'IN',
          status: 'SUCCESS',
          transactedAt: new Date().toISOString(),
          payerName: 'TEST USER',
          note: 'Test mutation'
        };

        mutations.push(mutation);
        index++;
      }, frequency);
    },

    async disconnect() {
      isConnected = false;
      if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }
      console.log('[MockProvider] Disconnected');
    },

    async fetchMutations() {
      const result = [...mutations];
      mutations = [];
      return result;
    },

    getStatus() {
      return {
        name: 'mock',
        connected: isConnected,
        pendingMutations: mutations.length
      };
    }
  };
}

module.exports = {
  MutationProvider,
  createMockProvider
};
