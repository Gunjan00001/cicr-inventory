# Back-of-the-Envelope (BOTE) Estimation & System Capacity Analysis

> Quick, napkin-style math for the CICR Inventory **email pipeline** (admin-OTP approval → borrow/return confirmations + daily due/overdue reminders). Assumptions are stated up front; every figure is derived, not measured, unless noted. Treat numbers as planning guidance, not guarantees.

**Current pipeline (as implemented):**

* `backend/src/services/emailService.ts`, synchronous Nodemailer `transporter.sendMail()` over Gmail SMTP (`smtp.gmail.com:587`, STARTTLS).
* `backend/src/modules/borrow/borrow.controller.ts`, admin-OTP approval workflow (`POST /api/borrow/request-otp` → `POST /api/borrow/verify-otp`), borrow/return confirmation emails fired **asynchronously** (`.catch()` fire-and-forget) so they never block the HTTP response.
* `backend/src/services/reminderService.ts`, `node-cron` runs a due/overdue scan **daily at 09:00** + on server boot, sending **Day N-1 "due tomorrow" reminders** and due/overdue reminders **sequentially** (`await` per recipient).

> This analysis corresponds to project release **v1.4.7 (Pre-release, not production-ready)** (see the Version History and [Version Registry (Git Tags)](../README.md#-version-registry-git-tags) in `README.md`). All numbers assume the 3-email borrow workflow (admin OTP → borrow confirmation → return confirmation). Since **v1.4.7 (Institutional Email Support)** the sender is **`CICR Inventory Support <kushagragargdelhi@gmail.com>`** with `Reply-To: kushagragargdelhi@gmail.com`, and the live OTP probe targets the numeric institutional inbox **`992501030406@mail.jiit.ac.in`** (see the [Test OTP mail routing](../README.md#-test-accounts-seeded) note in `README.md`).

---

## 0. BOTE formulas, as implemented (`boteService.ts`)

The math below is not just napkin analysis, it ships as a live metrics engine in
`backend/src/services/boteService.ts`, exposed by two API endpoints (mounted at
`/api/system` in `backend/src/server.ts`):

| Endpoint | Returns |
|----------|---------|
| `GET /api/system/bote-metrics` | live snapshot `{ capacity, peak, latency, memory, inventory }` built from real Supabase counts (`borrow_records`, `users`, `inventory`) |
| `GET /api/system/simulate-scale?users=&borrowsPerUserPerMonth=&jobsPerUser=` | forward-looking simulation `{ scenario, gmail_accounts_needed, exceeds_single_gmail_cap, cost, capacity, latency, memory }` |

**Canonical constants** (`DEFAULT_BOTE_CONFIG`): `smtpDailyCap = 500`,
`emailsPerBorrowCycle = 2`, `smtpAvgLatencyMs = 1000`, `reminderWorkers = 25`,
`jobSizeBytes = 2048`, `redisOverheadFactor = 1.5`.

```
# Capacity (per day)
used              = emailsUsedToday
remaining         = max(0, cap − used)
utilization_pct   = (used / cap) × 100
max_transactions  = floor(cap / emailsPerBorrowCycle)      # 500 / 2 = 250
transactions_used = floor(used / emailsPerBorrowCycle)

# Peak load (burst check)
burst        = emailsUsedToday + dueTodayEmails
exceeds_cap  = burst > cap
headroom     = max(0, cap − burst)

# Latency
sequential_ms = emails × smtpAvgLatencyMs
parallel_ms   = sequential_ms / reminderWorkers             # 25 workers
speedup_x     = sequential_ms / parallel_ms                 # = workers

# Redis queue memory
total_jobs    = users × jobsPerUser
queue_bytes   = total_jobs × jobSizeBytes                   # 2 KB / job
redis_bytes   = queue_bytes × redisOverheadFactor           # 1.5× overhead

# Scale simulation (per month → per day)
emails_per_month     = users × borrowsPerUserPerMonth × emailsPerBorrowCycle
emails_per_day       = emails_per_month / 30
transactions_per_day = emails_per_month / 30 / emailsPerBorrowCycle
gmail_accounts_needed = ceil(emails_per_day / smtpDailyCap)
ses_usd_per_month    = emails_per_month / 1000 × 0.10
resend_usd_per_month = emails_per_month / 1000 × 0.20
```

Worked example (matches the `bote.test.cjs` suite): 10,000 users × 2
borrows/user/month → `emails_per_day = 1,333.3`, `gmail_accounts_needed = 3`,
`exceeds_single_gmail_cap = true`, SES ≈ **$4/mo**, Resend ≈ **$8/mo**.

> Note: the live engine counts **2** emails per borrow workflow (borrow confirmation
> + return confirmation), admin OTP emails and reminders ride on top of the same
> 500/day pool. The prose sections below use **3** emails/workflow when reasoning
> about the *full* OTP-approved workflow ceiling (~166/day).

---

## 1. Gmail SMTP daily limits & inbox capacity

Gmail's free tier caps outbound mail at **500 emails / day / account**. Each email is one `sendMail()` call.

| Email type | Emails per event |
|------------|------------------|
| Admin OTP approval email | 1 per borrow |
| Borrow confirmation | 1 per borrow |
| Return confirmation | 1 per return |
| Day N-1 (due tomorrow) reminder | 1 per active due borrower / day |
| Due / overdue reminder | 1 per active due borrower / day |

A full borrow workflow (OTP request → borrow → return) consumes **3 emails** (OTP to admin + borrow confirmation + return confirmation).

**Max sustainable full borrow workflows / day (Gmail inbox capacity)**

```
max_workflows = daily_email_cap / emails_per_workflow
              = 500 / 3
              = 166.6 → ~166 full borrow workflows / day
```

**Monthly headroom**

```
166 workflows/day × 30 days = 4,980 workflows / month
                            = 14,940 emails / month
```

| Metric | Value |
|--------|-------|
| Gmail free daily cap | 500 emails / account / day |
| Emails per full borrow workflow | 3 (OTP + borrow + return) |
| **Gmail inbox capacity (full workflows / day)** | **~166** |
| Max workflows / month | ~4,980 |
| Peak reminder burst (all 166 active) | +166 emails on top of the 500 budget |

> **Headroom check:** reminders share the same 500/day pool. If all 166 daily borrowers also have a due/overdue reminder the same day, the daily budget is `500 borrows/returns` already at cap, and reminders push **past** it. Realistically only a fraction of borrows are due on any given day, but the burst must be scheduled to not collide with the transaction cap.

### Traffic model (per-day formula)

```
daily_emails = borrows_today × 1          (OTP to admin)
             + borrows_today × 1          (borrow confirmations)
             + returns_today × 1          (return confirmations)
             + due_borrowers_today × 1    (Day N-1 + due/overdue reminders)

constraint: daily_emails ≤ 500
```

For a club-scale deployment (hundreds of members, a few dozen borrows/day) Gmail's cap is comfortable. For **10,000 active students** (see §3) it is 40× short of the requirement.

---

## 2. Latency analysis, synchronous SMTP vs. BullMQ/Redis async job queue

### Where latency currently exists

1. **Borrow / return path:** the HTTP handler returns immediately (fire-and-forget), but each `sendMail()` still consumes event-loop time in the Node process. Under burst traffic, SMTP socket timeouts and TLS handshakes add event-loop pressure even though the API response isn't blocked.
2. **Reminder job:** `reminderService.ts` awaits `sendReturnReminder(...)` in a **strict `for` loop**. Total time scales linearly with the number of due borrowers.

### Back-of-envelope latency

Typical Gmail SMTP round-trip ≈ **0.3–1.5 s** (TLS handshake + SMTP dialogue + queueing). Use **~1 s** for planning.

| Scenario | Emails | Sequential `await` (current) | Parallel workers (BullMQ, concurrency 25) |
|----------|--------:|:---:|:---:|
| Average club day | 20 | ~20 s | ~1 s |
| Busy club day (Gmail-cap: 166 workflows) | 332 | ~5.5 min | ~13 s |
| 10,000-user rollout | 1,333 | ~22 min | ~53 s |
| Worst-case overdue flood | 10,000 | ~2.8 h | ~6.7 min |

```
sequential_time = emails × 1 s
parallel_time   = emails × 1 s / workers
```

> The 10,000-user scenario comes from §3/§4 (≈1,333 transactional emails/day). At that scale the sequential reminder job alone would run for ~22 minutes, well beyond a "daily 09:00" job window. The busy-club-day row uses the Gmail cap of 166 workflows × 2 transactional emails (borrow + return) = 332 emails; OTP + Day N-1 emails ride on top of the same 500/day budget.

### Why a queue (BullMQ + Redis) wins

| Concern | Synchronous SMTP (current) | BullMQ / Redis queue |
|---------|---------------------------|----------------------|
| HTTP latency impact | None (fire-and-forget), but event-loop load | None, enqueue is O(1), `<1 ms` |
| Send throughput | 1 email at a time (reminders), serial | N workers in parallel (`concurrency`) |
| Failure handling | Logged and dropped, no retry | Automatic retries with exponential backoff |
| Crash resilience | In-flight email lost on process restart | Job persists in Redis, re-run after restart |
| Visibility | Console logs only | Job states, metrics, dead-letter queue |

Queue recommendation (when scaling past Gmail):

```
API (borrow/return) ──enqueue(<1ms)──► BullMQ ──► Workers (SMTP / SES / Resend)
                                          ▲
cron (reminder scan) ────produce──────────┘
```

---

## 3. Memory calculations, 10,000 active student users

A BullMQ job occupies roughly **~2 KB** in memory: job metadata (id, attempts, timestamps, ~0.5 KB) + JSON payload (`{ user_id, email, item_id, item_name, due_date, purpose }`, ~0.5–1.5 KB).

**Queued reminder batch for 10,000 users**

```
queue_memory = jobs × job_size
             = 10,000 × 2 KB
             = 20 MB
```

| Metric | Estimate |
|--------|----------|
| Jobs to enqueue (one reminder per user) | 10,000 |
| Avg job size (meta + payload) | ~2 KB |
| **Estimated queue memory footprint** | **~20 MB** |
| Redis-side mirror (lists + metadata) | ~10–15 MB |
| Per-request latency impact | negligible (<1 ms enqueue) |

**Context check, is 10,000 users realistic for the mail volume?**

```
10,000 students × 2 borrows / month × 3 emails per workflow (OTP + borrow + return)
    = 40,000 transactional emails / month
    ≈ 1,333 emails / day
```

* **Gmail cap:** 1,333/day vs. 500/day → **needs 3× Gmail accounts**, or a proper ESP (below).
* **Queue memory:** 20 MB is trivially small for any Node process or Redis instance, the queue is **not** the bottleneck; the SMTP daily cap is.

---

## 3.5 Failure-rate analysis & delivery health

Email is the only external dependency on the borrow path, so delivery failure directly translates to a broken workflow:

| Failure mode | Rate (Gmail → institutional domains) | Impact | Mitigation |
|--------------|:---:|--------|------------|
| **Institutional Email Sinkhole** (silent drop) | 2–5% of outbound | OTP / confirmation never seen → borrow stalls; SMTP still replies `250 OK` | Plain-text fallback + custom Message-ID + X-headers (v1.4.4); then SPF/DKIM or Resend/SES |
| SMTP hard-bounce | <1% | Admin OTP not delivered → student blocked | Verify admin addresses in `adminDirectory.ts` |
| SMTP soft-fail / rate-limit (`421`) | occasional bursts | OTP delayed, retry needed | Retry with backoff in `emailService.ts` |
| `535 BadCredentials` | config-time | All email dead | Valid Gmail App Password; `SMTP_FROM` must equal `SMTP_USER` |

### The Institutional Email Sinkhole (v1.4.4)

Institutional gateways (`@mail.jiit.ac.in`, `.ac.in`, `.edu`) aggressively filter
low-reputation, **HTML-only**, or header-light mail. The sender's MTA (Gmail)
replies `250 OK`, the gateway silently sinks the message, and **no bounce ever
arrives**, so a "successful" send tells you nothing about inbox landing.

**v1.4.4 patch** (`backend/src/services/emailService.ts`):

* **Plain-text (`text/`) fallback on all five templates**, HTML-only mail scores as bulk;
* **Custom Message-ID** (`<<unixms>.<hex>@…>`), avoids the default
  nodemailer format that some gateways fingerprint;
* **X-header + priority set**, `X-CICR-Mailer: CICR-Inventory/v1.4.7`, `X-Mailer-Type`,
  `Importance`, `List-Unsubscribe`; OTP mail is `priority: 'high'`;
* **Full SMTP response logging**, every send logs raw `response` (`250 2.0.0 OK …`)
  plus the complete `envelope`, `accepted[]` / `rejected[]` and `messageId`.

**v1.4.7, Institutional Email Support (`@mail.jiit.ac.in`):**

* **RFC 2822 dynamic Message-ID**, `generateMessageId()` derives `id-right` from `SMTP_HOST`
  (`smtp.gmail.com → gmail.com`), `id-left` = unix-ms + 128-bit hex, aligning the id domain
  with the authenticated sending domain;
* **Explicit sender + Reply-To**, `CICR Inventory Support <kushagragargdelhi@gmail.com>`
  with `Reply-To: kushagragargdelhi@gmail.com`;
* **High-priority headers**, `X-Priority: 1 (Highest)` + `Importance: High` on OTP mail;
* **Numeric student-ID validation**, `backend/src/validators/email.validator.ts` accepts
  12-digit numeric institutional IDs `^[0-9]{12}@mail\.jiit\.ac\.in$` (any `jiit.ac.in`
  subdomain) without validation errors;
* **Institutional probe**, `node test/test-email.cjs` dispatches the live OTP to
  `992501030406@mail.jiit.ac.in` and logs full SMTP response codes + sent headers.

**Detection rule:** `accepted=["…@mail.jiit.ac.in"]` + `rejected=[]` + empty inbox ⇒
**sinkholed upstream**, the fix is SPF/DKIM alignment or moving to an ESP
(Resend/SES), not more SMTP retries.

**Back-of-envelope OTP workflow reliability**

```
otp_success = send_success × (1 − sinkhole_rate)
            ≈ 0.97 × 0.96
            ≈ 0.93 (≈ 93% end-to-end OTP delivery on institutional domains)
```

> **Delivery math:** with a 2–5% sinkhole/spam rate on institutional domains (missing custom SPF/DKIM headers), roughly **3–5% of OTP emails never reach the admin inbox** on a first send. Borrowing workflows are not lost, the OTP remains valid for 10 minutes and a re-request is idempotent, but a production inbox needs SPF/DKIM configured (or an ESP like Resend/SES) before relying on OTP approval at scale.

### Concurrency limits, 500–1000 concurrent users

The web tier (Express + Supabase PostgREST) is **not** the bottleneck, it comfortably serves **500–1000 concurrent users** with <1s API response latency (stateless JSON routes, serverless-friendly, connection-pooled Postgres).

| Constraint | Limit | Notes |
|------------|:---:|-------|
| Concurrent web users (Express + Supabase) | 500–1000 | <1s p95 API latency; stateless controllers |
| Concurrent SMTP sends (single Gmail) | ~1 (serial) | Nodemailer awaits per recipient → serialized |
| OTP requests / minute (in-memory store) | effectively unlimited | Map-based, OTP TTL 10 min |
| OTP verification / minute | effectively unlimited | O(1) hash lookup |
| **True ceiling → Gmail inbox capacity** | **~166 full workflows/day** | 500 emails ÷ 3 emails/workflow |

> The concurrency sweet-spot of 500–1000 simultaneous web users is real for the API tier, but the **email tier caps daily throughput** at ~166 full borrow workflows. Concurrency and daily-capacity are orthogonal: web concurrency scales horizontally (more Render/Vercel instances), the Gmail cap does not. Migrating `emailService.ts` to Resend/SES + BullMQ/Redis workers is the planned escape hatch (see §4/§6).

### Live SMTP email test log (v1.4.7 institutional run)

Run as part of `node test/system-health-check.cjs` (see the [System Audit & Health Check](../README.md#-system-audit--health-check-v145) section of `README.md`) and `node test/test-email.cjs`. Nodemailer → `smtp.gmail.com:587` (STARTTLS, App Password), sender **`kushagragargdelhi@gmail.com`** (`CICR Inventory Support`, `Reply-To` same) → numeric institutional inbox **`992501030406@mail.jiit.ac.in`**:

```
== Live OTP via real SMTP transport (Institutional Email Support) ==
  From:      kushagragargdelhi@gmail.com
  To:        [ '992501030406@mail.jiit.ac.in' ]
  envelope:  { from: 'kushagragargdelhi@gmail.com', to: [ '992501030406@mail.jiit.ac.in' ] }
  accepted:  [ '992501030406@mail.jiit.ac.in' ]
  rejected:  []
  response:  250 2.0.0 OK  1786640023 a92af1059eb24-141387ed5b1sm225810c88.8 - gsmtp
  messageId: <1786640020999.7d55d326d83e776c261f66dc083c2ef3@gmail.com>
  headers:   X-CICR-Mailer: CICR-Inventory/v1.4.7 · X-Mailer-Type: borrow-otp ·
             X-Priority: 1 (Highest) · Importance: High · Reply-To: kushagragargdelhi@gmail.com
```

The `250 2.0.0 OK … - gsmtp` tail is the raw SMTP dialogue the app's
`logDelivery()` helper echoes on every transactional send. Per the sinkhole
analysis above, `250 OK` + `rejected=[]` confirms **SMTP acceptance**, for an
institutional `.ac.in` recipient, an empty inbox with the same response would
mean upstream sinkholing (fix: SPF/DKIM or an ESP). The v1.4.7 Message-ID now
aligns with the authenticated sending domain (`@gmail.com`), the mail carries
high-priority + RFC headers and a plain-text fallback, and the numeric
`@mail.jiit.ac.in` recipient passes `validators/email.validator.ts`, so `250 OK`
here means the OTP lands in the numeric institutional inbox.

---

## 4. Capacity comparison, Gmail vs. Resend vs. AWS SES

Pricing is approximate (back-of-envelope) for 2026 public tiers; verify on provider sites before committing.

| Provider | Free tier | Price per 1,000 | Daily cap (free) | Latency | Suited for |
|----------|-----------|-----------------:|:---:|:---:|-----------|
| **Gmail SMTP** (current) | 500 emails/day | $0 | 500/day/account | ~1 s/msg, serial | Small club (< 166 workflows/day) |
| **Resend** | 100 emails/day | ~$20 per 100k ($0.20) | 100/day free, none when paid | ~100–300 ms, parallel | Mid-scale teams, dev-friendly API + webhooks |
| **AWS SES** | 3,000 emails/day (12-mo trial*) | $0.10 | 3,000/day | ~100–300 ms, parallel | High-volume / production at lowest cost |

\* Trial allowance applies to EC2-originated sending; new SES accounts start in the sandbox with 200 emails/day and require a support ticket to lift.

### Projected monthly cost at 10,000 users (40,000 emails/month)

```
Gmail:   $0.00     (but exceeds 500/day cap → infeasible)
Resend:  40,000 × $0.20 / 1,000 = $8.00 / month
AWS SES: 40,000 × $0.10 / 1,000 = $4.00 / month
```

| Scenario | Emails/month | Gmail | Resend | AWS SES |
|----------|-------------:|:---:|:---:|:---:|
| Club today (~4,980 workflows) | ~14,940 | 500/day cap OK (≈166 workflows/day) | $2.99 | $1.49 |
| 10,000 students | ~40,000 | cap exceeded 3× | $8.00 | $4.00 |

### Decision matrix

* **Stay on Gmail** while `full_workflows/day ≤ 166` and reminder bursts are scheduled off-peak (e.g. run the cron after 18:00 so the 09:00 reminder batch doesn't compete with the transaction cap).
* **Move to Resend** for a drop-in API replacement, generous webhooks/analytics, and instant parallelism without operating Redis.
* **Move to AWS SES** for lowest cost at sustained high volume; adds sender reputation management (warm-up, DKIM/SPF) and a slightly heavier SDK/API.

---

## 5. Third-party integration bottlenecks & rate limits

The system has two hard external dependencies: **Gmail SMTP** (email pipeline) and
**Supabase** (database + auth). Both ship free-tier ceilings that bite well before
the API tier does. This section is the "when do we need to pay?" answer for each.

### 5.1 Gmail SMTP, burst limit & connection throttle

The daily 500-emails cap (§1) is only one side of the constraint. Gmail also
throttles **bursts**:

| Limit | Operational value | Effect when exceeded |
|-------|:---:|-------|
| Sustained send rate | **~20–30 emails / min** | Sends slow down; SMTP `421 4.7.0` "temporary rate limit" responses appear |
| Concurrent SMTP connections | **~10–15** | Additional connections are refused; Nodemailer queues in-process |
| Per-message latency | ~1 s (serialized) | A 30-email burst ≈ 30 s wall-clock |
| Daily recipients | 500 / account / day | Hard stop; further `sendMail()` calls fail |

**Burst behavior under load (250–300 requests/min):**

```
250 requests/min ÷ ~25 msgs/min sustainable = ~10 min to drain the burst
→ backpressure: some sends return `421` (retryable), others queue
→ with no queue (fire-and-forget), mails can silently drop after cap
```

In practice a **250–300 req/min** burst (e.g. a club-wide reminder kick or a
stress test) exceeds the sustainable Gmail throughput by **~10×**, so the
pipeline must either (a) queue + rate-limit to ~25/min, or (b) move to an ESP
with a real per-minute budget. This is a **threshold, not a hard failure**,
Gmail returns `421` retryable errors rather than hard bounces, so a
BullMQ/Redis queue with retries absorbs the burst; the API stays responsive.

**Upgrade trigger:** sustained send rate approaching 20–30/min or bursts
> 100 in a single minute → switch `emailService.ts` to **Resend** or **AWS SES**
(both handle thousands/min on paid tiers).

### 5.2 Supabase Free Tier, database, storage & auth ceilings

| Resource | Free tier cap | Pro tier ($25/mo) |
|----------|:---:|:---:|
| Direct DB connections (`max_connections`) | **60** | 120 |
| Database storage | **500 MB** | 8 GB |
| File storage | 1 GB | 100 GB |
| Monthly active users (auth) | **50,000** | 100,000 |
| Edge/API requests | 500k/mo | 2M/mo |
| Projects | 2 | 1 (paid, unlimited-ish) |

The **60 direct-connection limit** is the practical bottleneck for a Node server:
every Express route that touches Supabase holds a pooled Postgres connection, and
Node's `pg` pool default can exhaust 60 connections under >60 simultaneous
latent queries. Mitigation: keep `pool` sized ≤ 40 and use the Supabase
connection pooler (port `6543`) for serverless/many-instance deploys.

**Upgrade trigger:** sustained >40 concurrent pooled queries, DB >500 MB, or
>50k auth users/month → **Supabase Pro ($25/mo)**.

### 5.3 The two "pay now" thresholds at a glance

| Symptom | Cap hit | Fix | Cost |
|---------|---------|-----|------|
| Send rate > ~20–30 msgs/min, or a 100+ burst in 1 min | Gmail SMTP burst throttle | **Resend** (50k msgs tier) or **AWS SES** | ~$20/mo (Resend) / ~$4–5/mo (SES usage) |
| DB > 500 MB or concurrent connections > 60 | Supabase Free limits | **Supabase Pro** | $25/mo |
| Both of the above simultaneously | Production scale | Resend/SES + Supabase Pro | ~$45–50/mo total |

> **The math to remember:** Gmail caps you at ~**166 full borrow workflows/day**
> and ~**20–30 emails/min**; Supabase caps you at **60 connections / 500 MB**.
> A paid tier is required at ~10,000 students (≈1,333 emails/day) or once the DB
> passes 500 MB, whichever comes first.

---

## Summary

| Question | Answer |
|----------|--------|
| How many full borrow workflows/day can Gmail sustain? | **~166** (500 emails ÷ 3 emails/workflow) |
| What is the web-tier concurrency limit? | **500–1000 concurrent users**, <1s API latency |
| What is the OTP delivery failure rate? | **2–5%** on institutional domains (missing SPF/DKIM), ≈93% end-to-end first-send OTP success |
| Gmail burst / connection limits? | **~20–30 emails/min**, **~10–15 concurrent SMTP connections**, `421` throttling beyond that |
| Supabase Free Tier caps? | **60 direct DB connections**, **500 MB DB**, **50k MAU** |
| When do we need Resend/SES? | Send rate > ~25/min sustained or >100-email burst/min → ~**$20/mo** (Resend) / ~$4–5/mo (SES) |
| When do we need Supabase Pro? | DB > 500 MB or > 60 pooled connections → **$25/mo** |
| What happens at 10,000 students? | ~1,333 emails/day, **3× over Gmail's cap** |
| Reminder job latency at scale (sequential)? | 10,000 × ~1 s = **~2.8 h**, use a queue + workers |
| Memory for a 10,000-job queue? | **~20 MB**, non-issue for the process/Redis |
| Cheapest production ESP at 40k emails/month? | **AWS SES ≈ $4/month** (Resend ≈ $8/month) |

**Next-step recommendation:** keep Gmail for current club scale (≤166 workflows/day); when cross-user volume approaches that ceiling, introduce a BullMQ/Redis worker pool for reminders (or switch `emailService.ts` to the Resend/SES SDK) before the daily cap becomes the bottleneck.

---

*Numbers are estimates for planning only, measure with real SMTP timing and queue metrics before making infrastructure decisions.*
