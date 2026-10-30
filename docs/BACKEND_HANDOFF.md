# Backend Handoff Guide, v1.5.0

**Date:** 2026-08-17
**Branch:** `kush-backend`
**Tag:** `v1.5.0`

---

## 1. Implemented Features

### 1.1 Redis Sessions & Caching (`backend/src/config/redis.ts`)

* **Dual-mode client**: When `REDIS_URL` is set, uses `ioredis` for session storage, API response caching, and TTL-based OTP state. When unset, falls back to an in-memory `Map` with identical async TTL semantics.
* **Session store**: `connect-redis` (`RedisStore`) backs `express-session` cookies. Sessions are prefixed `cicr:sess:`, httpOnly, 7-day TTL, SameSite=lax.
* **API response caching**: Inventory list (`GET /api/items`) and individual items (`GET /api/items/:id`) are cached for 30 seconds via `cacheGetJSON` / `cacheSetJSON`. Cache is invalidated on create/update/delete/borrow/return via `invalidateItemsCache()`.
* **Admin directory caching**: `GET /api/borrow/admins` cached for 60 seconds.
* **Graceful degradation**: Every Redis call is wrapped in try/catch. Connection errors log a warning and fall through to the in-memory store, no request ever crashes on Redis failure.
* **BullMQ email queue** (`backend/src/config/emailQueue.ts`): When Redis is configured, outbound emails are enqueued via BullMQ with exponential backoff (3 attempts, 2s base). The worker runs with concurrency 5. Without Redis, `emailService.ts` falls back to direct `transporter.sendMail()`.

### 1.2 Master-Slave DB Read/Write Splitting (`backend/src/config/database.ts`)

* **Two Supabase clients**: `dbWrite` (primary, for INSERT/UPDATE/DELETE) and `dbRead` (replica when `SUPABASE_READ_URL` is set, otherwise primary).
* **All SELECTs** route through `dbRead`; all mutations route through `dbWrite` (aliased as `supabase` for backward compatibility).
* **Replica-ready**: Set `SUPABASE_READ_URL` in `.env` to point reads at a read replica. Without it, both clients hit the primary, identical behavior on the free tier.
* **Controller coverage**: `auth.controller.ts`, `borrow.controller.ts`, `inventory.controller.ts`, `dashboard.controller.ts`, `system.controller.ts`, and `reminderService.ts` all use `dbRead` for queries.

### 1.3 Hardened JWT/RBAC Auth (`backend/src/middleware/auth.middleware.ts`)

* **JWT-first with session fallback**: Bearer JWT is verified with strict claim validation (role restricted to ADMIN|MEMBER, optional `JWT_ISSUER`/`JWT_AUDIENCE`). If no Bearer token, falls back to the Redis-backed session cookie.
* **Role-based access control**: `requireAdmin` middleware for admin-only endpoints; `requireRole('ADMIN')` / `requireRole('ADMIN', 'MEMBER')` for fine-grained RBAC.
* **Session invalidation**: `clearSessionUser()` destroys the server-side session (used on logout).
* **Token claims**: JWT carries `{ id, name, email, role }` with 7-day expiry.

### 1.4 Institutional Email Support (`@mail.jiit.ac.in`)

* **Email validator** (`backend/src/validators/email.validator.ts`): Accepts 12-digit numeric student IDs on any `jiit.ac.in` subdomain (`^[0-9]{12}@[a-z0-9-]+\.jiit\.ac\.in$`), plus standard email formats.
* **SMTP headers**: Custom `Message-ID` per RFC 2822 (domain derived from `SMTP_HOST`), `X-CICR-Mailer`, `X-Priority`, `Importance`, `List-Unsubscribe`, `Reply-To`.
* **Plain-text fallback** on every HTML template to avoid institutional spam sinkholing.
* **Sender identity**: `"CICR Inventory Support" <kushagragargdelhi@gmail.com>` with `Reply-To`.

### 1.5 OTP Approval Workflow

* 6-digit cryptographic OTP, 10-minute TTL, 5-attempt verification budget, hashed at rest.
* Admin directory (`modules/borrow/adminDirectory.ts`) maps admin IDs to emails.
* Full flow: `POST /api/borrow/request-otp` → admin receives OTP → `POST /api/borrow/verify-otp` → borrow record created + stock decremented + confirmation email dispatched.

### 1.6 Email Notification System

* **5 email types**: OTP (high priority), borrow confirmation, return confirmation, upcoming-due reminder (Day N-1), overdue/due-today reminder.
* **Async dispatch**: Fire-and-forget `.catch()` on all email sends, SMTP latency never blocks HTTP responses.
* **Reminder scheduler**: `node-cron` runs daily at 09:00 + on boot. Scans for due/overdue borrows and emails borrowers.
* **Mock mode**: When `SMTP_USER` is unset, all emails are logged to console, development never breaks.

### 1.7 Rental Duration Cap

* `duration_days` clamped to **1–30** (default 5) via `parseRentalDays()` in `borrow.controller.ts`.
* `due_date` computed as `borrowed_at + duration_days`.

---

## 2. Directory Structure

```
CICR_Inventory/
├── backend/                          # Express + TypeScript API
│   ├── src/
│   │   ├── server.ts                 # Entry point (HTTP listen + reminder scheduler + system routes)
│   │   ├── app.ts                    # Express app, Redis session store, route mounting
│   │   ├── config/
│   │   │   ├── database.ts           # dbRead / dbWrite Supabase clients (read/write splitting)
│   │   │   ├── redis.ts              # Redis client + in-memory fallback + cache helpers
│   │   │   └── emailQueue.ts         # BullMQ email queue (Redis-only, optional)
│   │   ├── modules/
│   │   │   ├── auth/
│   │   │   │   ├── auth.routes.ts    # POST /register, /login, GET /profile
│   │   │   │   └── auth.controller.ts
│   │   │   ├── inventory/
│   │   │   │   ├── inventory.routes.ts
│   │   │   │   └── inventory.controller.ts  # CRUD + Redis cache + invalidation
│   │   │   ├── borrow/
│   │   │   │   ├── borrow.routes.ts
│   │   │   │   ├── borrow.controller.ts     # borrow, return, OTP workflow, history
│   │   │   │   ├── otpService.ts            # In-memory OTP store (generate/verify/consume)
│   │   │   │   └── adminDirectory.ts        # Admin email directory
│   │   │   ├── dashboard/
│   │   │   │   ├── dashboard.routes.ts
│   │   │   │   └── dashboard.controller.ts  # stats + audit logs
│   │   │   └── system/
│   │   │       └── system.controller.ts     # BOTE metrics + scale simulation
│   │   ├── middleware/
│   │   │   └── auth.middleware.ts    # JWT verify + session fallback + RBAC
│   │   ├── validators/
│   │   │   └── email.validator.ts    # Institutional email validation
│   │   ├── services/
│   │   │   ├── emailService.ts       # Nodemailer transport + 5 email templates
│   │   │   ├── reminderService.ts    # node-cron due/overdue reminder job
│   │   │   └── boteService.ts        # BOTE capacity/latency math
│   │   └── routes/
│   │       └── system.routes.ts      # /api/system/* routes (mounted in server.ts)
│   ├── migrations/
│   │   ├── 001_add_due_date_to_borrow_records.sql
│   │   └── 002_seed_test_users.sql
│   ├── test/                         # Test suite (72 tests)
│   ├── .env                          # Local secrets (gitignored)
│   ├── .env.example                  # Environment template (committed)
│   ├── package.json
│   └── tsconfig.json
├── src/                              # Frontend (Vite + Three.js + TypeScript)
├── docs/
│   ├── BACKEND_HANDOFF.md            # This file
│   └── BOTE_ESTIMATION.md            # Scalability math
├── README.md
├── API_DOCUMENTATION.md
├── ER_DIAGRAM.md
├── AGENT.md
├── index.html
├── package.json
└── tsconfig.json
```

---

## 3. Environment Variables (.env Template)

```bash
# === Required ===
PORT=5000
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_ANON_KEY=<supabase-anon-key>
JWT_SECRET=<random-secret-min-32-chars>

# === Redis (optional, enables sessions, caching, BullMQ email queue) ===
REDIS_URL=redis://127.0.0.1:6379
SESSION_SECRET=<random-session-secret>

# === Read Replica (optional, falls back to SUPABASE_URL when unset) ===
SUPABASE_READ_URL=

# === Email (mock mode when SMTP_USER is empty) ===
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-16-char-app-password
SMTP_FROM="CICR Inventory Support" <your-email@gmail.com>

# === JWT (optional, for issuer/audience validation) ===
JWT_ISSUER=
JWT_AUDIENCE=

# === Reminder Schedule (default: daily at 09:00) ===
REMINDER_CRON=0 9 * * *
```

---

## 4. API Endpoints Summary

| Mount | Method | Path | Auth | Description |
|-------|--------|------|------|-------------|
| `/api` | `GET` | `/health` | Public | Health check |
| `/api/auth` | `POST` | `/register` | Public | Register new user |
| `/api/auth` | `POST` | `/login` | Public | Login → JWT |
| `/api/auth` | `GET` | `/profile` | Bearer | Current user profile |
| `/api/items` | `GET` | `/` | Public | List items (cached 30s, read pool) |
| `/api/items` | `GET` | `/categories` | Public | Static categories |
| `/api/items` | `GET` | `/:id` | Public | Single item (cached 30s, read pool) |
| `/api/items` | `POST` | `/` | Admin | Create item |
| `/api/items` | `PATCH` | `/:id` | Admin | Update item |
| `/api/items` | `DELETE` | `/:id` | Admin | Delete item |
| `/api/borrow` | `GET` | `/admins` | Bearer | Admin directory (cached 60s) |
| `/api/borrow` | `POST` | `/` | Bearer | Direct borrow (1–30 day cap) |
| `/api/borrow` | `POST` | `/request-otp` | Bearer | Request admin OTP |
| `/api/borrow` | `POST` | `/verify-otp` | Bearer | Verify OTP → borrow + email |
| `/api/borrow` | `POST` | `/return` | Bearer | Return item + email |
| `/api/borrow` | `GET` | `/history` | Bearer | Borrow history |
| `/api` | `GET` | `/stats` | Public | Dashboard stats |
| `/api` | `GET` | `/audit` | Bearer | Audit logs |
| `/api/system` | `GET` | `/bote-metrics` | Public | BOTE capacity snapshot |
| `/api/system` | `GET` | `/simulate-scale` | Public | Scale simulation |

---

## 5. Key Architectural Decisions

| Decision | Rationale |
|----------|-----------|
| Redis as optional (in-memory fallback) | Local dev and tests run without Redis; production enables it via `REDIS_URL` |
| `dbRead` / `dbWrite` split | Replica-ready from day one; identical behavior on free tier (both hit primary) |
| BullMQ only when Redis is present | Avoids adding Redis as a hard dependency for the email pipeline |
| JWT-first + session fallback | Supports both API clients (Bearer) and browser-based flows (cookies) |
| `invalidateItemsCache()` on borrow/return | Prevents stale stock counts in cached inventory responses |
| `dotenv.config()` in config modules | Ensures env vars are loaded before `process.env` reads, regardless of import order |

---

## 6. Pending Frontend Integration Steps

The frontend (`src/main.ts`) currently targets `http://localhost:5000/api` via the `API_BASE` constant. To complete the v1.5.0 integration:

### 6.1 Session-Aware Fetch Wrapper

The backend now accepts both JWT Bearer tokens and Redis-backed session cookies. The frontend should:

```typescript
// src/main.ts, replace direct fetch with credentials-aware fetch
const apiFetch = async (url: string, options: RequestInit = {}) => {
  const token = localStorage.getItem('token');
  return fetch(`${API_BASE}${url}`, {
    ...options,
    credentials: 'include',  // send session cookies
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
};
```

### 6.2 OTP Entry UI

The borrow flow currently uses direct `POST /api/borrow` in the UI. Wire the OTP approval step:

1. Add an "Request Admin Approval" button that calls `POST /api/borrow/request-otp`.
2. Show an OTP input field (6-digit) for the student to enter the code received from the admin.
3. On submit, call `POST /api/borrow/verify-otp` with the OTP.
4. Show success/error feedback.

### 6.3 Login → Session Sync

After `POST /api/auth/login` returns a JWT:

1. Store the JWT in `localStorage` (existing behavior).
2. The session cookie is set automatically by `express-session` on the login response, no extra work needed if `credentials: 'include'` is used on subsequent requests.

### 6.4 Logout → Session Invalidation

On logout:

1. Clear `localStorage` token.
2. Call `POST /api/auth/logout` (if added) or simply redirect, the server-side session is invalidated on the next request if the cookie expires.

### 6.5 Environment-Aware API_BASE

For production deployment, update `src/main.ts:11`:

```typescript
const API_BASE = import.meta.env.PROD
  ? 'https://cicr-inventory-backend.onrender.com/api'
  : 'http://localhost:5000/api';
```

### 6.6 Optional: Admin Dashboard BOTE Panel

The `GET /api/system/bote-metrics` and `GET /api/system/simulate-scale` endpoints are public. The admin dashboard could display:

* Daily email capacity remaining
* Active borrows vs. Gmail cap
* Simulated scale for N users

---

## 7. Test Accounts (Seeded)

| Role | Email | Notes |
|------|-------|-------|
| Admin | `kushagragargdelhi@gmail.com` | KUSH, OTP approval directory |
| Student | `kushgdhi@gmail.com` | `kush`, original test student |
| Student | `992501030406@mail.jiit.ac.in` | Institutional, live OTP probe target |
| Student | `992501030395@mail.jiit.ac.in` | Institutional |
| Student | `992501030399@mail.jiit.ac.in` | Institutional |
| Student | `992401210050@mail.jiit.ac.in` | Institutional |
| Student | `992401030154@mail.jiit.ac.in` | Institutional |

All `@jiit.ac.in` students share password: `JiitCICR@2026!`

---

## 8. Running the Backend

```bash
cd backend
cp .env.example .env    # fill in secrets
npm ci

# Development (with hot reload)
npm run dev             # nodemon + ts-node → http://localhost:5000

# Production build
npm run build           # tsc → dist/
npm start               # node dist/server.js

# Tests (72 tests)
npm test                # node --test "test/*.test.cjs"

# Manual diagnostics (not part of npm test)
node test/system-health-check.cjs
node test/test-email.cjs
```

---

## 9. Known Limitations

| Issue | Status | Path Forward |
|-------|--------|-------------|
| OTP store is in-memory (server restart loses pending OTPs) | Acceptable for club scale | Redis-backed OTP via `redisSet` / `redisGet` with TTL |
| `register` accepts `role: 'ADMIN'` from client | Security gap | Server-side role hardcoding or admin-only role assignment |
| Gmail SMTP 500 emails/day cap | Hard ceiling at ~166 workflows/day | Switch to Resend/SES at scale |
| 2–5% institutional email sinkhole | SPF/DKIM alignment needed | Configure SPF/DKIM on sending domain or use ESP |
| Frontend OTP entry UI not wired | Pending | See §6.2 above |
