# QRIS Payment Simple

Payment gateway for **merchant.qris.interactive.co.id** with auto-verification.

---

## What Is This?

A plugin/node/server to receive QRIS payments. Just plug in and start **accepting money**.

### Features:

- **Auto-Verification** - Payments verified automatically, no manual check needed
- **Real-time** - Get payment updates instantly (SSE)
- **Suffix System** - Each payment gets unique amount (Rp 99,099) for easy matching
- **SSE / Webhook** - Notification to your app when payment succeeds
- **SQLite** - Simple database, no server setup needed

---

## How It Works

```
Customer pays QRIS → Money goes to merchant.qris.interactive.co.id →
Gateway detects → Payment auto verified → Your app gets notification
```

1. Customer scans QRIS
2. Pays
3. Money arrives at merchant.qris.interactive.co.id dashboard
4. Gateway automatically detects the payment
5. Payment marked as SUCCESS
6. Your app gets real-time notification

---

## Features

- ✅ Auto-verification payments
- ✅ Real-time updates (SSE)
- ✅ QRIS static to dynamic
- ✅ Webhook support
- ✅ Admin dashboard (list payments, mark paid/failed)
- ✅ Rate limiting & security
- ✅ SQLite database
- ✅ Auto expire payments

---

## Environment Variables

```bash
# QRIS
QRIS_STATIC_STRING=

# QRIS Interactive (merchant.qris.interactive.co.id)
QRIS_INTERACTIVE_EMAIL=
QRIS_INTERACTIVE_PASSWORD=
MUTATION_COLLECTOR_ENABLED=true

# Security
PAYMENT_WEBHOOK_SECRET=
HASH_PEPPER=
```

---

## Quick Start

1. Clone/Install
2. Setup `.env`
3. `node standalone.js`
4. Start accepting payments

---

## Main Endpoints

| Endpoint | Function |
|----------|----------|
| POST `/api/payment/create` | Create payment |
| GET `/api/payment/status/:id` | Check status |
| GET `/api/payment/stream/:id` | Real-time update |
| GET `/api/payment/admin/dashboard` | Admin dashboard |

---

## Architecture

### Payment Flow

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                           PAYMENT LIFECYCLE                                    │
│                                                                                │
│  1. CREATE                                                                   │
│  ┌──────────┐         ┌──────────────┐        ┌──────────────────────────┐   │
│  │ Client   │────────►│ POST /create │───────►│ QRIS Generator            │   │
│  │          │         │              │        │ • Parse static QRIS     │   │
│  │          │         │              │        │ • Add unique suffix      │   │
│  │          │         │              │        │ • Return dynamic QR     │   │
│  └──────────┘         └──────────────┘        └───────────┬──────────────┘   │
│                                                            │                   │
│  2. PAY                                                                    │
│  ▼                                                            │                   │
│  ┌──────────┐                                                │                   │
│  │ Customer │◄───────────────────────────────────────────────┘                   │
│  │ scans QR │         Returned:                                                       │
│  │          │         • merchant_order_id                                            │
│  └────┬─────┘         • qris_full_amount (e.g. Rp 99,099)                          │
│       │               • qris_image (base64)                                         │
│       │               • expires_at                                                 │
│       ▼                                                                       │
│  ┌──────────┐                                                                   │
│  │ Pays to  │                                                                   │
│  │ Merchant │                                                                   │
│  │ Account  │                                                                   │
│  └────┬─────┘                                                                   │
│       │                                                                         │
│       ▼                                                                         │
│  3. AUTO-VERIFY                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │                        Self-Healing Collector                              │  │
│  │                                                                          │  │
│  │  ┌────────────────┐    ┌────────────────┐    ┌────────────────────────┐  │  │
│  │  │ Poll Mutations │───►│ Match by Suffix│───►│ Update Payment Status │  │  │
│  │  │ (QRIS Int.)   │    │ + Amount       │    │ PENDING → SUCCESS     │  │  │
│  │  └────────────────┘    └────────────────┘    └───────────┬────────────┘  │  │
│  │                                                           │               │  │
│  │                      ┌────────────────┐                   │               │  │
│  │                      │ SSE Broadcast  │◄──────────────────┘               │  │
│  │                      │ /stream/:id    │   Notify client in real-time      │  │
│  │                      └────────────────┘                                  │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                                │
│  4. NOTIFY                                                                   │
│  ▼                                                                            │
│  ┌──────────┐         ┌──────────────┐        ┌──────────────────────────┐   │
│  │ Webhook  │◄───────│ POST /webhook│◄──────│ Payment Success          │   │
│  │ Receiver │         │              │        │ → Call onPaymentSuccess  │   │
│  │          │         │              │        │   hook in your app       │   │
│  └──────────┘         └──────────────┘        └──────────────────────────┘   │
│                                                                                │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Deploy

Standalone - works on Render, Railway, VPS, etc.

```bash
npm install
node standalone.js
```
