# QRIS Payment Simple

A standalone, pluggable QRIS payment gateway for Node.js/Express applications. Designed specifically for **merchant.qris.interactive.co.id** with automatic payment verification.

## ⚠️ Important: Mutation Provider

This project is built specifically to work with **[merchant.qris.interactive.co.id](https://merchant.qris.interactive.co.id)** - a QRIS merchant dashboard that provides mutation/transaction data.

### How It Works

```
┌─────────────┐     QRIS      ┌──────────────┐
│   Customer  │ ────────────► │  QRIS Code   │
│             │   (pay)      │              │
└─────────────┘               └──────────────┘
                                   │
                                   ▼
┌─────────────┐   mutation    ┌──────────────┐
│  Merchant   │ ◄─────────── │  Dashboard   │
│  Dashboard  │   (inquiry)  │  merchant.   │
│  qris.     │              │  interactive │
│  interactive│              │  .co.id      │
└─────────────┘               └──────────────┘
                                   │
                                   ▼
                          ┌──────────────────┐
                          │  This Gateway     │
                          │  - Polls mutations│
                          │  - Matches to     │
                          │    payments       │
                          │  - Updates status │
                          └──────────────────┘
```

### Auto-Verification Flow

1. **Payment Created** → Generate QRIS with unique suffix (e.g., Rp 99,099)
2. **Customer Pays** → Payment appears in merchant.qris.interactive.co.id dashboard
3. **Collector Polls** → This gateway fetches mutations every few seconds
4. **Match Found** → Payment automatically marked as SUCCESS
5. **SSE Notification** → Real-time update sent to your app

---

## Features

- ✅ **QRIS Static → Dynamic** - Generate unique QR codes with suffix-based verification
- ✅ **Auto-Verification** - Self-healing collector with circuit breaker pattern
- ✅ **Real-time Updates** - Server-Sent Events (SSE) for instant status updates
- ✅ **Webhook Support** - HMAC-signed webhook endpoints
- ✅ **Security First** - HMAC validation, CSRF protection, rate limiting, no hardcoded secrets
- ✅ **Fork-Friendly** - Interface-based providers, hook pattern, no business logic
- ✅ **SQLite Backend** - WAL mode, atomic transactions, audit logging

---

## Requirements

1. **QRIS Static String** - Get from your QRIS provider (GPN, BRI, etc.)
2. **Merchant Dashboard Account** - Register at [merchant.qris.interactive.co.id](https://merchant.qris.interactive.co.id)
3. **Node.js 18+**

---

## Quick Start

### Installation

```bash
npm install qris-payment-simple
```

### 1. Setup Environment

Create `.env` file:

```bash
# ===========================================
# QRIS Static String (from your QRIS provider)
# ===========================================
QRIS_STATIC_STRING=00020101021126360009...

# ===========================================
# QRIS Interactive Provider
# https://merchant.qris.interactive.co.id
# ===========================================
MUTATION_COLLECTOR_ENABLED=true
QRIS_INTERACTIVE_EMAIL=your@email.com
QRIS_INTERACTIVE_PASSWORD=your-password
QRIS_LOOKBACK_DAYS=1

# Security (REQUIRED in production)
PAYMENT_WEBHOOK_SECRET=your-secret-key
HASH_PEPPER=random-pepper-for-hashing

# Optional
DATABASE_PATH=./payments.db
PORT=3000
NODE_ENV=development
```

### 2. Create Payment Server

```javascript
const { createPaymentApp } = require('qris-payment-simple');

const app = createPaymentApp({
  qris: {
    staticString: process.env.QRIS_STATIC_STRING,
    merchantName: 'Your Store'
  },

  // Collector config (uses merchant.qris.interactive.co.id)
  collector: {
    enabled: true,
    email: process.env.QRIS_INTERACTIVE_EMAIL,
    password: process.env.QRIS_INTERACTIVE_PASSWORD
  },

  hooks: {
    // Called when payment succeeds
    onPaymentSuccess: async (db, payment) => {
      console.log('Payment succeeded:', payment.merchant_order_id);
      // TODO: Grant access to your product
    }
  }
});

app.listen(3000);
```

### 3. Run

```bash
node standalone.js
```

---

## Configuration

### Required

| Variable | Description |
|----------|-------------|
| `QRIS_STATIC_STRING` | Your QRIS static string from provider |
| `QRIS_INTERACTIVE_EMAIL` | Email for merchant.qris.interactive.co.id |
| `QRIS_INTERACTIVE_PASSWORD` | Password for merchant.qris.interactive.co.id |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `QRIS_MERCHANT_NAME` | "Payment Gateway" | Display name on QR |
| `QRIS_EXPIRY_MINUTES` | 20 | Payment expiry time |
| `QRIS_LOOKBACK_DAYS` | 1 | Days to look back for mutations |
| `MUTATION_COLLECTOR_ENABLED` | false | Enable auto-verification |
| `PAYMENT_WEBHOOK_SECRET` | - | HMAC secret for webhooks |
| `HASH_PEPPER` | - | Pepper for hashing |

---

## How Payment Verification Works

### Without Auto-Verification (Collector Disabled)

You need to manually mark payments or use webhooks.

### With Auto-Verification (Collector Enabled)

```
Customer pays Rp 99,099
         │
         ▼
┌─────────────────────────────────────┐
│  QRIS Interactive Dashboard          │
│  Shows: "QRIS-xxx" = Rp 99,099     │
└─────────────────────────────────────┘
         │ polls every 3-10 seconds
         ▼
┌─────────────────────────────────────┐
│  This Gateway                        │
│  1. Fetches mutations                │
│  2. Finds matching payment          │
│  3. Marks as SUCCESS                │
│  4. Sends SSE notification          │
└─────────────────────────────────────┘
         │
         ▼
Your app receives real-time update
```

---

## API Endpoints

### Payment API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/payment/create` | Create a new payment |
| GET | `/api/payment/status/:id` | Check payment status |
| GET | `/api/payment/stream/:id` | SSE real-time updates |
| GET | `/api/payment/invoices` | Payment history |
| GET | `/api/payment/config` | Gateway configuration |

### Create Payment

```bash
curl -X POST http://localhost:3000/api/payment/create \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 99000,
    "description": "Premium Plan",
    "email": "user@example.com",
    "name": "John Doe",
    "referenceId": "ORDER-123"
  }'
```

### Response

```json
{
  "success": true,
  "data": {
    "payment": {
      "merchantOrderId": "PAY-1699000000000-ABC123-1A2B3C",
      "amount": 99000,
      "suffix": 99,
      "fullAmount": 99099,
      "qrImageDataUrl": "data:image/png;base64,...",
      "status": "PENDING",
      "expiresAt": "2024-01-15T10:30:00.000Z"
    }
  }
}
```

### Admin API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/payment/admin/list` | List all payments |
| GET | `/api/payment/admin/pending` | List pending payments |
| POST | `/api/payment/admin/:id/mark-paid` | Mark as paid |
| POST | `/api/payment/admin/:id/mark-failed` | Mark as failed |
| GET | `/api/payment/admin/dashboard` | Dashboard stats |

### Webhook API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/payment/webhook/verify` | QRIS verification webhook |
| POST | `/api/payment/webhook/mutation` | Push mutation manually |

---

## Hooks

Inject your business logic:

```javascript
hooks: {
  onPaymentSuccess: async (db, payment) => {
    // Grant product access
    await grantAccess(payment.reference_id, payment.email);
  },

  onPaymentFailed: async (db, payment, reason) => {
    // Handle failed payment
  },

  onPaymentExpired: async (db, payment) => {
    // Clean up pending order
  }
}
```

---

## Custom Mutation Provider

If you don't use merchant.qris.interactive.co.id, implement your own provider:

```javascript
const { MutationProvider } = require('qris-payment-simple/src/providers/base/MutationProvider');

class MyBankProvider extends MutationProvider {
  constructor(config) {
    super();
    this.name = 'my-bank';
    this.api = new MyBankAPI(config);
  }

  async connect() {
    await this.api.login();
  }

  async fetchMutations() {
    return this.api.getMutations();
  }
}

const app = createPaymentApp({
  customProvider: new MyBankProvider({ apiKey: '...' })
});
```

---

## Security

- **HMAC Validation** - All webhooks use timing-safe HMAC-SHA256
- **CSRF Protection** - Double-submit cookie pattern
- **Rate Limiting** - Configurable per-endpoint limits
- **No Hardcoded Secrets** - Required config validated in production
- **Audit Logging** - All reconciliation actions logged

---

## Architecture

```
qris-payment-simple/
├── src/
│   ├── index.js                    # Main exports
│   ├── config.js                   # Config loader
│   ├── database.js                 # DB initialization
│   ├── types/                      # Type definitions
│   ├── utils/                      # Utilities
│   ├── middleware/                 # Express middleware
│   ├── payments/                   # Core payment logic
│   │   ├── qris-generator.js       # QRIS string + QR image
│   │   ├── suffix-allocator.js     # Unique suffix pool
│   │   ├── payment-state.js        # State machine
│   │   ├── mutation-matcher.js     # Auto-matching
│   │   ├── mutation-ingester.js    # Deduplication
│   │   └── self-healing-collector.js # Adaptive polling
│   ├── providers/
│   │   ├── qris-interactive-provider.js  # merchant.qris.interactive.co.id
│   │   └── mock-provider.js        # For testing
│   └── routes/                     # API routes
├── db/schema.sql                  # Database schema
└── standalone.js                   # Entry point
```

---

## Running Tests

```bash
npm test
```

---

## License

MIT
