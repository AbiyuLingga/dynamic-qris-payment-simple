# QRIS Payment Simple

Payment gateway untuk **merchant.qris.interactive.co.id** dengan auto-verification.

---

## Apa Ini?

Plugin/node/server buat terima pembayaran QRIS. Tinggal colok, langsung bisa terima uang.

### Fungsi:

- **Auto-Verification** - Pembayaran langsung verified tanpa harus cek manual
- **Real-time** - Dapet update pembayaran langsung (SSE)
- **Suffix System** - Tiap payment dapet nominal unik (Rp 99,099) biar gampang dicocokkan
- **SSE / Webhook** - Notifikasi ke app kamu pas pembayaran berhasil
- **SQLite** - Database sederhana, nggak perlu setup server

---

## Cara Kerja

```
Customer bayar QRIS → Dana masuk ke merchant.qris.interactive.co.id →
Gateway detect → Payment auto verified → App kamu dapet notifikasi
```

1. Customer scan QRIS
2. Bayar
3. Dana masuk ke dashboard merchant.qris.interactive.co.id
4. Gateway otomatis nge-detect pembayaran
5. Payment mark SUCCESS
6. App kamu dapet real-time notification

---

## Fitur

- ✅ Auto-verification pembayaran
- ✅ Real-time update (SSE)
- ✅ QRIS static to dynamic
- ✅ Webhook support
- ✅ Admin dashboard (list payment, mark paid/failed)
- ✅ Rate limiting & security
- ✅ SQLite database
- ✅ Auto expire payment

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
4. Siap terima pembayaran

---

## Endpoint Utama

| Endpoint | Fungsi |
|----------|--------|
| POST `/api/payment/create` | Buat pembayaran |
| GET `/api/payment/status/:id` | Cek status |
| GET `/api/payment/stream/:id` | Real-time update |
| GET `/api/payment/admin/dashboard` | Dashboard admin |

---

## Deploy

Standalone - bisa jalan di Render, Railway, VPS, dll.

```bash
npm install
node standalone.js
```
