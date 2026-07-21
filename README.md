# QRIS Payment Simple

Auto-verification gateway untuk **merchant.qris.interactive.co.id**.

## Setup

```bash
npm install qris-payment-simple
```

Buat `.env`:

```bash
QRIS_STATIC_STRING=00020101021126360009...

MUTATION_COLLECTOR_ENABLED=true
QRIS_INTERACTIVE_EMAIL=email@merchant.qris.interactive.co.id
QRIS_INTERACTIVE_PASSWORD=password

PAYMENT_WEBHOOK_SECRET=secret
HASH_PEPPER=pepper
```

## Usage

```javascript
const { createPaymentApp } = require('qris-payment-simple');

const app = createPaymentApp({
  qris: { staticString: process.env.QRIS_STATIC_STRING },
  collector: {
    enabled: true,
    email: process.env.QRIS_INTERACTIVE_EMAIL,
    password: process.env.QRIS_INTERACTIVE_PASSWORD
  },
  hooks: {
    onPaymentSuccess: async (db, payment) => {
      // grant access
    }
  }
});

app.listen(3000);
```

## Run

```bash
node standalone.js
```

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/payment/create` | Create payment |
| GET | `/api/payment/status/:id` | Check status |
| GET | `/api/payment/stream/:id` | Real-time update |
| POST | `/api/payment/webhook/verify` | Webhook |

## Create Payment

```bash
curl -X POST http://localhost:3000/api/payment/create \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 99000,
    "description": "Premium",
    "email": "user@example.com"
  }'
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `QRIS_STATIC_STRING` | Yes | QRIS static string |
| `QRIS_INTERACTIVE_EMAIL` | Yes* | Email merchant dashboard |
| `QRIS_INTERACTIVE_PASSWORD` | Yes* | Password merchant dashboard |
| `PAYMENT_WEBHOOK_SECRET` | Yes** | HMAC secret |
| `HASH_PEPPER` | Yes** | Hash pepper |
| `QRIS_MERCHANT_NAME` | No | Nama merchant di QR (default: Payment Gateway) |
| `QRIS_EXPIRY_MINUTES` | No | Expiry payment (default: 20) |
| `QRIS_LOOKBACK_DAYS` | No | Hari lookback mutation (default: 1) |

*Required jika `MUTATION_COLLECTOR_ENABLED=true`
**Required di production

## Deploy

```bash
# Render, Railway, dll
git push
npm start
```
