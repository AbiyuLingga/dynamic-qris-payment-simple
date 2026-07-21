# QRIS Payment Simple

A standalone, pluggable QRIS payment gateway for Node.js/Express applications. Fork-friendly, security-hardened, and designed for multi-tenant SaaS.

## Features

- ✅ **QRIS Static → Dynamic** - Generate unique QR codes with suffix-based verification
- ✅ **Auto-Verification** - Self-healing collector with circuit breaker pattern
- ✅ **Real-time Updates** - Server-Sent Events (SSE) for instant status updates
- ✅ **Webhook Support** - HMAC-signed webhook endpoints
- ✅ **Security First** - HMAC validation, CSRF protection, rate limiting, no hardcoded secrets
- ✅ **Fork-Friendly** - Interface-based providers, hook pattern, no business logic
- ✅ **SQLite Backend** - WAL mode, atomic transactions, audit logging

## Quick Start

### Installation

```bash
npm install qris-payment-simple
```

### As Standalone Server

```javascript
const { createPaymentApp } = require('qris-payment-simple');

const app = createPaymentApp({
  qris: {
    staticString: process.env.QRIS_STATIC_STRING,
    merchantName: 'Your Store'
  },
  hooks: {
    onPaymentSuccess: async (db, payment) => {
      console.log('Payment succeeded:', payment.merchant_order_id);
    }
  }
});

app.listen(3000);
```

### As Express Router

```javascript
const express = require('express');
const { createPaymentRouter } = require('qris-payment-simple');

const app = express();
app.use(express.json());

app.use('/payments', createPaymentRouter({
  qris: { staticString: process.env.QRIS_STATIC_STRING },
  hooks: {
    onPaymentSuccess: async (db, payment) => {
      await grantProductAccess(payment.metadata.userId);
    }
  }
}));

app.listen(3000);
```

## Configuration

Create a `.env` file:

```bash
# QRIS Configuration (REQUIRED)
QRIS_STATIC_STRING=00020101021126360009...
QRIS_MERCHANT_NAME=Your Store Name
QRIS_EXPIRY_MINUTES=20

# Security (REQUIRED in production)
PAYMENT_WEBHOOK_SECRET=your-secret-key
HASH_PEPPER=your-hash-pepper

# Optional
DATABASE_PATH=./payments.db
PORT=3000
NODE_ENV=development
```

## API Endpoints

### Payment API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/payment/create` | Create a new payment |
| GET | `/api/payment/status/:id` | Check payment status |
| GET | `/api/payment/stream/:id` | SSE real-time updates |
| GET | `/api/payment/invoices` | Payment history |
| GET | `/api/payment/config` | Gateway configuration |

### Create Payment Request

```bash
curl -X POST http://localhost:3000/api/payment/create \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 99000,
    "description": "Premium Plan",
    "email": "user@example.com",
    "name": "John Doe",
    "referenceId": "ORDER-123",
    "metadata": { "userId": "abc123" }
  }'
```

### Create Payment Response

```json
{
  "success": true,
  "data": {
    "payment": {
      "merchantOrderId": "PAY-1699000000000-ABC123-1A2B3C",
      "amount": 99000,
      "suffix": 99,
      "fullAmount": 99099,
      "qrString": "00020101021126360009...",
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
| GET | `/api/payment/admin/:id/audit` | Audit log |
| GET | `/api/payment/admin/dashboard` | Dashboard stats |
| GET | `/api/payment/admin/ambiguous` | Ambiguous matches |

### Webhook API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/payment/webhook/verify` | QRIS verification webhook |
| POST | `/api/payment/webhook/mutation` | Push single mutation |
| POST | `/api/payment/webhook/batch` | Push batch mutations |

## Hooks

Inject your business logic via callbacks:

```javascript
const app = createPaymentApp({
  hooks: {
    // Called when payment succeeds
    onPaymentSuccess: async (db, payment) => {
      await grantProductAccess(payment.metadata.userId);
    },

    // Called when payment fails
    onPaymentFailed: async (db, payment, reason) => {
      await logFailedPayment(payment, reason);
    },

    // Called when payment expires
    onPaymentExpired: async (db, payment) => {
      await cleanupPendingOrder(payment.reference_id);
    },

    // Called when mutation match is ambiguous
    onAmbiguousMatch: async (db, mutation, candidates) => {
      await queueForManualReview(mutation, candidates);
    },

    // Admin authorization (optional)
    authorizeAdmin: (req) => {
      return req.session?.user?.role === 'admin';
    }
  }
});
```

## Custom Mutation Provider

Implement the `MutationProvider` interface for custom mutation sources:

```javascript
const { MutationProvider } = require('qris-payment-simple/src/providers/base/MutationProvider');

class BankTransferProvider extends MutationProvider {
  constructor(config) {
    super();
    this.name = 'bank-transfer';
    this.api = new BankAPI(config);
  }

  async connect() {
    await this.api.authenticate();
  }

  async disconnect() {
    await this.api.logout();
  }

  async fetchMutations() {
    const raw = await this.api.getMutations();
    return raw.map(m => ({
      providerMutationId: m.id,
      amount: m.amount,
      direction: 'IN',
      status: 'SUCCESS',
      transactedAt: m.date
    }));
  }
}

// Use it
const app = createPaymentApp({
  customProvider: new BankTransferProvider({ apiKey: '...' })
});
```

## Security

- **HMAC Validation** - All webhooks use timing-safe HMAC-SHA256
- **CSRF Protection** - Double-submit cookie pattern
- **Rate Limiting** - Configurable per-endpoint limits
- **No Hardcoded Secrets** - Required config validated in production
- **IP Allowlist** - Optional IP restrictions
- **Audit Logging** - All reconciliation actions logged

## Architecture

```
qris-payment-simple/
├── src/
│   ├── index.js              # Main exports
│   ├── config.js             # Config loader
│   ├── database.js            # DB initialization
│   ├── types/                 # Type definitions
│   ├── utils/                 # Utilities (crypto, validation, response)
│   ├── middleware/            # Express middleware
│   ├── payments/              # Core payment logic
│   ├── providers/             # Mutation providers
│   └── routes/                # API routes
├── db/schema.sql             # Database schema
└── standalone.js              # Entry point
```

## Running Tests

```bash
npm test
```

## License

MIT
