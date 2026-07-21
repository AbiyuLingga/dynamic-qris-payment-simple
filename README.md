# QRIS Payment Simple

Payment gateway for **merchant.qris.interactive.co.id** with auto-verification.

---

## What Is This?

A plugin/node/server to receive QRIS payments. Just plug in and start accepting money.

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

### High-Level System

```
┌──────────────────────────────────────────────────────────────────┐
│                         Client App                                │
│  (Your frontend - mobile app, web, etc.)                          │
└──────────────────────────┬───────────────────────────────────────┘
                           │ POST /api/payment/create
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                    QRIS Payment Gateway                            │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                   Express Server                             │  │
│  │                                                             │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │  │
│  │  │payment.js   │  │ admin.js    │  │ webhook.js           │ │  │
│  │  │             │  │             │  │                      │ │  │
│  │  │• create     │  │• dashboard   │  │• qris webhook        │ │  │
│  │  │• status     │  │• list        │  │• mutasiku webhook     │ │  │
│  │  │• stream(SSE)│  │• verify      │  │                      │ │  │
│  │  └─────────────┘  └─────────────┘  └─────────────────────┘ │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────┬───────────────────────────────────────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
          ▼                ▼                ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│   SQLite DB     │ │ QRIS Generator  │ │   Collector     │
│                 │ │                 │ │                 │
│ • payments      │ │ Static → Dynamic│ │ • Self-healing  │
│ • mutations     │ │ + suffix        │ │ • Polling       │
│ • webhooks      │ │                 │ │ • Auto-verify   │
└─────────────────┘ └─────────────────┘ └─────────────────┘
                                              │
                                              ▼
                                    ┌─────────────────────┐
                                    │ External Services     │
                                    │                      │
                                    │ • merchant.qris.     │
                                    │   interactive.co.id  │
                                    │ • Mutasiku (optional)│
                                    └─────────────────────┘
```

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

### Module Structure

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              src/                                             │
│                                                                                │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  Core Entry                                                            │  │
│  │                                                                         │  │
│  │  index.js ───► createPaymentApp() / createPaymentRouter()              │  │
│  │  standalone.js ───► Production server runner                           │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                    │                                          │
│           ┌────────────────────────┼────────────────────────┐                │
│           ▼                        ▼                        ▼                │
│  ┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐       │
│  │  Routes         │      │   Providers     │      │   Payments      │       │
│  │                 │      │                 │      │                 │       │
│  │ • payment.js    │      │ • base/          │      │ • qris-generator│       │
│  │   - create      │      │   MutationProv.  │      │ • suffix-alloc.  │       │
│  │   - status      │      │ • qris-inter-    │      │ • payment-state  │       │
│  │   - stream      │      │   active-prov.  │      │ • mutation-      │       │
│  │ • admin.js      │      │ • qris-mutasi-   │      │   matcher        │       │
│  │   - dashboard   │      │   provider      │      │ • mutation-      │       │
│  │   - list        │      │ • mock-provider  │      │   ingester       │       │
│  │ • webhook.js    │      │                 │      │ • payment-       │       │
│  │   - qris        │      │                 │      │   broadcaster    │       │
│  │   - mutasiku    │      │                 │      │ • expiry-sweeper  │       │
│  │                 │      │                 │      │ • self-healing-  │       │
│  └─────────────────┘      └─────────────────┘      │   collector      │       │
│                                                     └─────────────────┘       │
│                                                                                │
│  ┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐       │
│  │  Middleware     │      │   Utils         │      │   Types         │       │
│  │                 │      │                 │      │                 │       │
│  │ • csrf.js       │      │ • hash.js        │      │ • payment.js    │       │
│  │                 │      │ • id-generator.js│      │ • mutation.js    │       │
│  └─────────────────┘      └─────────────────┘      └─────────────────┘       │
│                                                                                │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Data Flow

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                           DATABASE (SQLite)                                    │
│                                                                                │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐               │
│  │    payments     │  │   mutations     │  │    webhooks     │               │
│  │                 │  │                 │  │                 │               │
│  │ • id            │  │ • id            │  │ • id            │               │
│  │ • merchant_     │  │ • provider      │  │ • payment_id   │               │
│  │   order_id      │  │ • amount        │  │ • url           │               │
│  │ • qris_         │  │ • direction     │  │ • created_at    │               │
│  │   full_amount   │  │ • status        │  │ • sent_at       │               │
│  │ • status        │  │ • transacted_at │  │ • response      │               │
│  │ • expires_at    │  │ • payer_name    │  │                 │               │
│  │ • reference_id  │  │ • matched_      │  │                 │               │
│  │ • metadata      │  │   payment_id   │  │                 │               │
│  │ • created_at    │  │ • created_at    │  │                 │               │
│  └────────┬────────┘  └────────┬────────┘  └─────────────────┘               │
│           │                      │                                             │
│           │                      │ matched_by                                 │
│           │                      ▼                                             │
│           │              ┌─────────────────┐                                    │
│           │              │    payments     │                                    │
│           │              │ (update status) │                                    │
│           │              └─────────────────┘                                    │
│           │                                                                    │
│           └───────────────────────────────────────────► SSE / Webhook           │
│                                                                                │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Collector & Verifier Flow

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                         Self-Healing Collector                                 │
│                                                                                │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                         Main Loop (runs every 60s)                        │  │
│  │                                                                         │  │
│  │    ┌─────────────┐                                                     │  │
│  │    │ Start Tick │                                                     │  │
│  │    └──────┬──────┘                                                     │  │
│  │           ▼                                                            │  │
│  │    ┌─────────────┐    ┌─────────────┐                                 │  │
│  │    │ Poll        │───►│ Got         │───► Continue                    │  │
│  │    │ Mutations   │    │ Mutations?  │    (skip tick)                  │  │
│  │    │ from        │    └──────┬──────┘                                 │  │
│  │    │ Provider   │           │ Yes                                     │  │
│  │    └─────────────┘           ▼                                        │  │
│  │                     ┌─────────────┐                                  │  │
│  │                     │ Normalize   │                                  │  │
│  │                     │ Mutations   │                                  │  │
│  │                     └──────┬──────┘                                  │  │
│  │                            ▼                                         │  │
│  │    ┌──────────────────────────────────────────┐                       │  │
│  │    │        For Each Mutation                 │                       │  │
│  │    │                                           │                       │  │
│  │    │  ┌────────────────┐  ┌────────────────┐  │                       │  │
│  │    │  │ Find Pending   │  │ Amount Match?  │  │                       │  │
│  │    │  │ Payment by     │◄─┤                │  │                       │  │
│  │    │  │ Suffix         │  └───────┬────────┘  │                       │  │
│  │    │  │                 │          │ Yes      │                       │  │
│  │    │  └────────────────┘          ▼          │                       │  │
│  │    │                      ┌────────────────┐ │                       │  │
│  │    │                      │ Update Status │ │                       │  │
│  │    │                      │ PENDING →     │ │                       │  │
│  │    │                      │ SUCCESS       │ │                       │  │
│  │    │                      └───────┬────────┘ │                       │  │
│  │    │                              │          │                       │  │
│  │    │           ┌─────────────────┼──────┐   │                       │  │
│  │    │           ▼                 ▼      │   │                       │  │
│  │    │  ┌──────────────┐  ┌──────────────┐ │   │                       │  │
│  │    │  │ SSE Broadcast │  │ Call Webhook │ │   │                       │  │
│  │    │  │ (real-time)  │  │ (if configured│ │  │                       │  │
│  │    │  └──────────────┘  └──────────────┘ │   │                       │  │
│  │    │                    ┌────────────────┘│   │                       │  │
│  │    │                    │ Call onPayment  │   │                       │  │
│  │    │                    │ Success hook   │   │                       │  │
│  │    │                    └────────────────┘│   │                       │  │
│  │    └──────────────────────────────────────────┘                       │  │
│  │                                                                         │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                                │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                         Expiry Sweeper                                  │  │
│  │   (runs every 60s)                                                     │  │
│  │                                                                         │  │
│  │   Find PENDING payments past expires_at ──► Status → EXPIRED          │  │
│  │   Call onPaymentExpired hook                                          │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                                │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                         Self-Healing                                    │  │
│  │                                                                         │  │
│  │   If collector fails ──► Retry with backoff ──► Reconnect              │  │
│  │   If session expired ──► Re-login ──► Continue                         │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
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
