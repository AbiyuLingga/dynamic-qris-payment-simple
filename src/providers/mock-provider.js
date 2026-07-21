/**
 * Mock Mutation Provider
 *
 * Generates fake mutations for testing and development.
 * Simulates real mutation collection without external dependencies.
 */

const crypto = require('crypto');
const { maskName } = require('../../utils/validation');

/**
 * Create mock mutation provider
 *
 * @param {Object} options - Configuration options
 * @param {number} [options.frequencyMs=3000] - Mutation generation frequency
 * @param {number[]} [options.amounts] - Amounts to cycle through
 * @param {number} [options.probability=1.0] - Probability of generating mutation per cycle
 * @param {string} [options.name] - Provider name
 * @returns {Object} Mock provider instance
 */
function createMockMutationProvider(options = {}) {
  const {
    frequencyMs = 3000,
    amounts = [99001, 99099, 149001, 149099, 199001, 199099, 249001, 249099],
    probability = 1.0,
    name = 'mock-mutation-provider'
  } = options;

  let intervalHandle = null;
  let isConnected = false;
  let pendingMutations = [];
  let index = 0;
  let mutationIdCounter = 0;

  /**
   * Generate a fake mutation
   */
  function generateMutation() {
    const amount = amounts[index % amounts.length];
    const timestamp = new Date();

    // Add some time variation (random 0-5 minutes in the past)
    timestamp.setMinutes(timestamp.getMinutes() - Math.floor(Math.random() * 5));

    mutationIdCounter++;
    const mutation = {
      // Provider fields
      providerMutationId: `MOCK-${Date.now()}-${String(mutationIdCounter).padStart(4, '0')}`,
      amount,
      direction: 'IN',
      status: 'SUCCESS',

      // Timestamps
      transactedAt: timestamp.toISOString(),
      receivedAt: new Date().toISOString(),

      // Payer info
      payerName: generateRandomName(),
      payerId: `ACC${Math.floor(Math.random() * 9000000000) + 1000000000}`,

      // Note/description
      note: `Transfer ${amount}`,
      description: `Payment mutation ${mutationIdCounter}`,

      // Metadata
      transactionType: 'QRIS',
      merchantId: 'MOCK_MERCHANT'
    };

    index++;
    return mutation;
  }

  /**
   * Generate random Indonesian-style name
   */
  function generateRandomName() {
    const firstNames = ['Budi', 'Ani', 'Dewi', 'Eko', 'Fitri', 'Gede', 'Hendra', 'Ika', 'Joko', 'Kiki'];
    const lastNames = ['Santoso', 'Wati', 'Kusuma', 'Pratama', 'Andayani', 'Saputra', 'Nugroho', 'Hartati'];

    const firstName = firstNames[Math.floor(Math.random() * firstNames.length)];
    const lastName = lastNames[Math.floor(Math.random() * lastNames.length)];

    return `${firstName} ${lastName}`;
  }

  return {
    name,

    /**
     * Connect to the mock source
     */
    async connect() {
      if (isConnected) return;

      console.log(`[${name}] Connecting...`);
      isConnected = true;

      // Start generating mutations periodically
      intervalHandle = setInterval(() => {
        if (Math.random() <= probability) {
          const mutation = generateMutation();
          pendingMutations.push(mutation);
        }
      }, frequencyMs);

      console.log(`[${name}] Connected (generating every ${frequencyMs}ms)`);
    },

    /**
     * Disconnect from the mock source
     */
    async disconnect() {
      if (!isConnected) return;

      isConnected = false;

      if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }

      console.log(`[${name}] Disconnected`);
    },

    /**
     * Fetch pending mutations
     *
     * @returns {Promise<Object[]>}
     */
    async fetchMutations() {
      if (!isConnected) {
        throw new Error('Provider not connected');
      }

      const mutations = [...pendingMutations];
      pendingMutations = [];
      return mutations;
    },

    /**
     * Manually inject a mutation (for testing)
     *
     * @param {Object} mutation - Mutation data
     */
    injectMutation(mutation) {
      pendingMutations.push({
        providerMutationId: mutation.providerMutationId || `INJECT-${Date.now()}`,
        amount: mutation.amount || amounts[0],
        direction: 'IN',
        status: mutation.status || 'SUCCESS',
        transactedAt: mutation.transactedAt || new Date().toISOString(),
        receivedAt: new Date().toISOString(),
        payerName: mutation.payerName || 'Injected User',
        note: mutation.note || 'Test injection'
      });
    },

    /**
     * Get provider status
     */
    getStatus() {
      return {
        name,
        connected: isConnected,
        pendingMutations: pendingMutations.length,
        totalGenerated: mutationIdCounter,
        currentAmount: amounts[index % amounts.length]
      };
    },

    /**
     * Reset provider state
     */
    reset() {
      pendingMutations = [];
      index = 0;
      mutationIdCounter = 0;
    }
  };
}

module.exports = {
  createMockMutationProvider
};
