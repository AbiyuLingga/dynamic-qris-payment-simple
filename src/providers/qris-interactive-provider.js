/**
 * QRIS Interactive Provider
 *
 * Fetches mutation data from merchant.qris.interactive.co.id
 */

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const { MutationProvider } = require('./base/MutationProvider');

/**
 * QRIS Interactive Provider
 *
 * @extends MutationProvider
 */
class QrisInteractiveProvider extends MutationProvider {
  /**
   * @param {Object} options - Configuration options
   * @param {string} options.email - QRIS merchant email
   * @param {string} options.password - QRIS merchant password
   * @param {string} [options.cookieDir] - Directory to store cookies
   * @param {number} [options.timeout=30000] - Request timeout
   * @param {number} [options.lookbackDays=1] - Days to look back for mutations
   * @param {boolean} [options.debug=false] - Enable debug logging
   */
  constructor(options = {}) {
    super();

    this.name = 'qris-interactive';
    this.baseUrl = 'https://merchant.qris.interactive.co.id';
    this.email = options.email || process.env.QRIS_INTERACTIVE_EMAIL;
    this.password = options.password || process.env.QRIS_INTERACTIVE_PASSWORD;
    this.cookieDir = options.cookieDir || path.join(process.env.HOME || '/tmp', '.qris-payment-simple');
    this.timeout = options.timeout || 30000;
    this.lookbackDays = options.lookbackDays || 1;
    this.debug = options.debug || process.env.DEBUG === 'true';

    this.isConnected = false;
    this.sessionToken = null;
    this.lastFetchTime = null;
    this.fetchCount = 0;
    this.requestCount = 0;
  }

  /**
   * Ensure cookie directory exists
   */
  _ensureCookieDir() {
    if (!fs.existsSync(this.cookieDir)) {
      fs.mkdirSync(this.cookieDir, { recursive: true });
    }
  }

  /**
   * Get cookie file path
   */
  _getCookiePath() {
    const emailHash = crypto.createHash('md5').update(this.email).digest('hex');
    return path.join(this.cookieDir, `qris-interactive-${emailHash}.json`);
  }

  /**
   * Save session to file
   */
  _saveSession() {
    this._ensureCookieDir();
    const data = {
      sessionToken: this.sessionToken,
      expires: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
      email: this.email
    };
    fs.writeFileSync(this._getCookiePath(), JSON.stringify(data, null, 2));
    this._log('Session saved to file');
  }

  /**
   * Load session from file
   */
  _loadSession() {
    const cookiePath = this._getCookiePath();
    if (!fs.existsSync(cookiePath)) {
      return null;
    }

    try {
      const data = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));

      // Check if expired
      if (data.expires < Date.now()) {
        this._log('Session expired');
        fs.unlinkSync(cookiePath);
        return null;
      }

      this._log('Session loaded from file');
      return data.sessionToken;
    } catch (error) {
      this._log(`Failed to load session: ${error.message}`);
      return null;
    }
  }

  /**
   * Clear session
   */
  _clearSession() {
    const cookiePath = this._getCookiePath();
    if (fs.existsSync(cookiePath)) {
      fs.unlinkSync(cookiePath);
    }
    this.sessionToken = null;
  }

  /**
   * Make HTTP request
   */
  _request(method, endpoint, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(endpoint, this.baseUrl);
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;

      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'qris-payment-simple/1.0',
          ...headers
        },
        timeout: this.timeout
      };

      // Add session token if available
      if (this.sessionToken) {
        options.headers['Authorization'] = `Bearer ${this.sessionToken}`;
      }

      this.requestCount++;

      const req = lib.request(options, (res) => {
        let data = '';

        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          // Handle Set-Cookie header
          if (res.headers['set-cookie']) {
            const tokenMatch = res.headers['set-cookie']
              .join('; ')
              .match(/token=([^;]+)/);
            if (tokenMatch) {
              this.sessionToken = tokenMatch[1];
            }
          }

          try {
            const json = JSON.parse(data);
            resolve({
              status: res.statusCode,
              data: json,
              headers: res.headers
            });
          } catch {
            resolve({
              status: res.statusCode,
              data: data,
              headers: res.headers
            });
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (body) {
        req.write(JSON.stringify(body));
      }

      req.end();
    });
  }

  /**
   * Connect to merchant portal
   *
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.isConnected) return;

    this._log('Connecting to merchant.qris.interactive.co.id...');

    // Try to load existing session
    const savedToken = this._loadSession();
    if (savedToken) {
      this.sessionToken = savedToken;

      // Verify session is still valid
      try {
        const response = await this._request('GET', '/api/auth/profile');
        if (response.status === 200) {
          this.isConnected = true;
          this._log('Connected (existing session)');
          return;
        }
      } catch (error) {
        this._log('Session invalid, will login');
      }
    }

    // Need to login
    if (!this.email || !this.password) {
      throw new Error('Email and password are required. Set QRIS_INTERACTIVE_EMAIL and QRIS_INTERACTIVE_PASSWORD env vars.');
    }

    try {
      const response = await this._request('POST', '/api/auth/login', {
        email: this.email,
        password: this.password
      });

      if (response.status !== 200) {
        throw new Error(`Login failed: ${response.data?.message || response.status}`);
      }

      this.sessionToken = response.data?.token || response.data?.sessionToken;
      this._saveSession();
      this.isConnected = true;
      this._log(`Connected as ${this.email}`);

    } catch (error) {
      this._log(`Connection failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Disconnect from merchant portal
   *
   * @returns {Promise<void>}
   */
  async disconnect() {
    if (!this.isConnected) return;

    // Optionally logout
    try {
      await this._request('POST', '/api/auth/logout');
    } catch {
      // Ignore logout errors
    }

    this.isConnected = false;
    this._log('Disconnected');
  }

  /**
   * Fetch mutations since last fetch
   *
   * @returns {Promise<Object[]>} Array of mutations
   */
  async fetchMutations() {
    if (!this.isConnected) {
      throw new Error('Provider not connected');
    }

    this.fetchCount++;
    const startTime = Date.now();

    try {
      // Calculate date range
      const endDate = new Date();
      const startDate = new Date(Date.now() - this.lookbackDays * 24 * 60 * 60 * 1000);

      const response = await this._request('GET',
        `/api/mutations?start=${startDate.toISOString()}&end=${endDate.toISOString()}`
      );

      this.lastFetchTime = new Date();

      if (response.status !== 200) {
        this._log(`Fetch failed: ${response.status}`);
        return [];
      }

      // Normalize mutations
      const rawMutations = response.data?.data || response.data || [];
      const mutations = rawMutations
        .map(m => this._normalizeMutation(m))
        .filter(m => m !== null);

      this._log(`Fetched ${mutations.length} mutations (${Date.now() - startTime}ms)`);

      return mutations;

    } catch (error) {
      this._log(`Fetch error: ${error.message}`);

      // If unauthorized, clear session and reconnect
      if (error.message.includes('401') || error.message.includes('403')) {
        this._clearSession();
        this.isConnected = false;
        await this.connect();
      }

      return [];
    }
  }

  /**
   * Normalize mutation from API response
   *
   * @param {Object} raw - Raw mutation from API
   * @returns {Object|null} Normalized mutation
   */
  _normalizeMutation(raw) {
    try {
      return {
        providerMutationId: raw.id || raw.mutationId || raw.transactionId,
        amount: parseInt(raw.amount || raw.nominal || raw.total),
        direction: raw.type?.toUpperCase() === 'DEBIT' || raw.direction === 'OUT' ? 'OUT' : 'IN',
        status: raw.status === 'SUCCESS' || raw.status === 'success' ? 'SUCCESS' : 'PENDING',
        transactedAt: raw.date || raw.createdAt || raw.timestamp || raw.transactedAt,
        payerName: raw.payerName || raw.senderName || raw.name,
        payerAccount: raw.payerAccount || raw.senderAccount || raw.accountNumber,
        note: raw.description || raw.note || raw.message,
        merchantReference: raw.reference || raw.merchantReference,
        // Raw for debugging
        _raw: raw
      };
    } catch (error) {
      this._log(`Failed to normalize mutation: ${error.message}`);
      return null;
    }
  }

  /**
   * Get provider status
   *
   * @returns {Object}
   */
  getStatus() {
    return {
      name: this.name,
      baseUrl: this.baseUrl,
      connected: this.isConnected,
      email: this.email ? this.email.replace(/(.{2}).*(@.*)/, '$1***$2') : null,
      hasSession: !!this.sessionToken,
      fetchCount: this.fetchCount,
      requestCount: this.requestCount,
      lastFetch: this.lastFetchTime?.toISOString() || null,
      lookbackDays: this.lookbackDays
    };
  }

  /**
   * Log debug message
   */
  _log(message) {
    if (this.debug) {
      console.log(`[${this.name}] ${message}`);
    }
  }
}

/**
 * Create QRIS Interactive provider
 *
 * @param {Object} options - Configuration options
 * @returns {QrisInteractiveProvider}
 */
function createQrisInteractiveProvider(options = {}) {
  return new QrisInteractiveProvider(options);
}

module.exports = {
  QrisInteractiveProvider,
  createQrisInteractiveProvider
};
