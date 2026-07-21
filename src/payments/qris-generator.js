/**
 * QRIS Generator
 *
 * Generates dynamic QRIS strings from static merchant QRIS.
 * Adds unique suffix to amount for payment verification.
 */

const QRIS = require('@prasetya/qris');
const QRCode = require('qrcode');

/**
 * Generate dynamic QRIS string
 *
 * @param {Object} options - Configuration options
 * @param {string} options.staticString - Static QRIS string from provider
 * @param {number} options.amount - Payment amount (with suffix)
 * @param {string} [options.merchantName] - Merchant name override
 * @param {string} [options.city] - City code override
 * @returns {string} Dynamic QRIS string
 */
function generateDynamicQris(options) {
  const { staticString, amount, merchantName, city } = options;

  if (!staticString) {
    throw new Error('Static QRIS string is required');
  }

  if (!amount || amount < 100) {
    throw new Error('Amount must be at least 100');
  }

  try {
    // Parse static QRIS
    const qris = QRIS.parse(staticString);

    // Update with dynamic values
    qris.set('54', String(amount)); // Amount (numeric, no decimals)

    if (merchantName) {
      // Update merchant name in additional data
      const additionalData = qris.get('62') || '';
      qris.set('62', updateAdditionalData(additionalData, merchantName));
    }

    if (city) {
      qris.set('60', city); // City code
    }

    // Add unique transaction ID
    const transactionId = generateTransactionId();
    qris.set('05', transactionId);

    // Recalculate CRC
    qris.crc = true;

    return qris.toString();
  } catch (error) {
    throw new Error(`Failed to generate dynamic QRIS: ${error.message}`);
  }
}

/**
 * Update additional data field with merchant name
 *
 * @param {string} additionalData - Current additional data
 * @param {string} merchantName - New merchant name
 * @returns {string} Updated additional data
 */
function updateAdditionalData(additionalData, merchantName) {
  // Parse existing additional data
  // Format: GIANT/00/ID/merchantName
  if (additionalData.includes('GIANT')) {
    return additionalData.replace(/GIANT\/00\/ID\/[^/]+/, `GIANT/00/ID/${merchantName}`);
  }

  // Add new merchant name
  return `GIANT/00/ID/${merchantName}`;
}

/**
 * Generate unique transaction ID for QRIS
 *
 * @returns {string} Transaction ID (max 14 chars for QRIS)
 */
function generateTransactionId() {
  const timestamp = Date.now().toString().slice(-6);
  const random = Math.floor(Math.random() * 99).toString().padStart(2, '0');
  return `TX${timestamp}${random}`;
}

/**
 * Generate QR code image as data URL
 *
 * @param {string} qrisString - QRIS string
 * @param {Object} [options] - QRCode options
 * @returns {Promise<string>} Data URL (base64 PNG)
 */
async function generateQrImage(qrisString, options = {}) {
  const defaultOptions = {
    type: 'image/png',
    width: 300,
    margin: 2,
    color: {
      dark: '#000000',
      light: '#FFFFFF'
    }
  };

  return QRCode.toDataURL(qrisString, { ...defaultOptions, ...options });
}

/**
 * Generate QR code as base64 string (without data URL prefix)
 *
 * @param {string} qrisString - QRIS string
 * @param {Object} [options] - QRCode options
 * @returns {Promise<string>} Base64 string
 */
async function generateQrBase64(qrisString, options = {}) {
  const defaultOptions = {
    type: 'png',
    width: 300,
    margin: 2
  };

  return QRCode.toDataURL(qrisString, { ...defaultOptions, ...options });
}

/**
 * Validate QRIS string format
 *
 * @param {string} qrisString - QRIS string to validate
 * @returns {{ valid: boolean, error?: string }}
 */
function validateQrisString(qrisString) {
  if (!qrisString || typeof qrisString !== 'string') {
    return { valid: false, error: 'QRIS string is required' };
  }

  if (!qrisString.startsWith('000201')) {
    return { valid: false, error: 'QRIS string must start with 000201' };
  }

  if (qrisString.length < 50) {
    return { valid: false, error: 'QRIS string is too short' };
  }

  try {
    const qris = QRIS.parse(qrisString);

    // Check required fields
    const formatIndicator = qris.get('00');
    const pointOfInitiation = qris.get('01');

    if (!formatIndicator || formatIndicator !== '01') {
      return { valid: false, error: 'Invalid format indicator' };
    }

    // 01 = Static QR, 02 = Dynamic QR
    if (!pointOfInitiation || !['01', '02'].includes(pointOfInitiation)) {
      return { valid: false, error: 'Invalid point of initiation' };
    }

    return { valid: true };
  } catch (error) {
    return { valid: false, error: `Invalid QRIS format: ${error.message}` };
  }
}

/**
 * Parse QRIS string to get details
 *
 * @param {string} qrisString - QRIS string to parse
 * @returns {Object} Parsed QRIS data
 */
function parseQris(qrisString) {
  if (!qrisString) return null;

  try {
    const qris = QRIS.parse(qrisString);

    return {
      formatIndicator: qris.get('00'),
      pointOfInitiation: qris.get('01'),
      merchantId: qris.get('02'),
      acquiringBank: qris.get('03'),
      merchantName: qris.get('59'),
      merchantCity: qris.get('60'),
      countryCode: qris.get('61'),
      currency: qris.get('53'),
      amount: qris.get('54'),
      tipIndicator: qris.get('55'),
      tipValue: qris.get('56'),
      additionalData: qris.get('62'),
      crc: qris.get('63'),
      raw: qrisString
    };
  } catch (error) {
    return null;
  }
}

/**
 * Create QRIS generator with configuration
 *
 * @param {Object} config - Configuration object
 * @param {string} config.staticString - Static QRIS string
 * @param {string} [config.merchantName] - Default merchant name
 * @param {string} [config.city] - Default city code
 * @returns {Object} Generator functions
 */
function createQrisGenerator(config) {
  return {
    /**
     * Generate full payment QR
     */
    generatePaymentQr: async (amount) => {
      const dynamicString = generateDynamicQris({
        staticString: config.staticString,
        amount,
        merchantName: config.merchantName,
        city: config.city
      });

      const imageDataUrl = await generateQrImage(dynamicString);

      return {
        qrString: dynamicString,
        qrImageDataUrl: imageDataUrl,
        amount
      };
    },

    /**
     * Validate static string
     */
    validateStatic: () => validateQrisString(config.staticString),

    /**
     * Get generator config
     */
    getConfig: () => ({ ...config })
  };
}

module.exports = {
  generateDynamicQris,
  generateQrImage,
  generateQrBase64,
  validateQrisString,
  parseQris,
  generateTransactionId,
  createQrisGenerator
};
