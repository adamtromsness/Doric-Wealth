# Ledger — self-hosted finance tracker

A runnable budgeting, wealth-tracking, and receipt-analysis app built with **TypeScript + PostgreSQL + React**. Track transactions against budgets, attach itemized receipts so an AI model can analyze the individual products you buy, log utility bills, record daily account balances for a net-worth history, and ask Claude to analyze things like a vehicle's true cost of ownership.

Users **log in** with email + password, and all financial data belongs to a **book** that you can **share with family** via an invite link. A user can belong to several books and switch between them. Every resource is **tenant-isolated** — each request resolves to your active book and all queries are scoped to it. The only outbound calls are to the Anthropic API, and only when *you* trigger an analysis with *your own* API key. To deploy on AWS, see **[DEPLOY.md](DEPLOY.md)**.

---

## Features

- **Accounts & sharing** — sign up with email + password; your data lives in a **book**. Invite family with a shareable link (owner/admin roles); they create an account or sign in and join. Switch between books from the sidebar.
- **Transactions** — log expenses, income, and **transfers** between accounts; mark pending vs. posted (entering a date auto-fills the posted date, rolling weekends to the next business day); **split** a transaction into per-line categories and tags; filter by account / date / category / vehicle / property / channel / amount / text. Merchant names auto-standardize.
- **CSV import** — upload a bank CSV, map its columns (auto-detected), and the system standardizes each row (merchant from your history, suggested category, direction from amount) and **flags likely duplicates** (same account/amount within a few days, defaulted to skip). Imported rows land in a **Review** queue on the Transactions page — they don't touch balances until you confirm each one (or "Confirm all"), at which point they post. The same queue is where future auto-loaded transactions will land.
- **Budgets** — weekly / monthly / yearly / custom budgets allocated by category, grouped by parent. Each line has a **rollover mode** (reset, carry over, or accrue a sinking-fund balance) with an adjustable **starting balance**, optional **account scoping** (only selected accounts count), a **daily/weekly cash-flow chart** with a "today" marker, days-remaining, and drag-to-reorder groups & items. Click any "spent/received" figure to see the underlying transactions and categorize them inline. Closing a **period snapshot** freezes that window's plan-vs-actual — planned amounts plus category *and* group labels are pinned, so later line edits or category renames never rewrite a historical report.
- **Account tools** — **reconcile** an account against a statement (cleared-item sessions are scoped to that account, so only its own transactions — including the far side of a transfer — can be cleared); **archive or close** accounts (history is preserved, just hidden from the active list); and a per-account **import status** (last import time, result, and any error) surfaced on the account list.
- **Subscriptions** — track recurring non-property charges, their true monthly cost, renewal dates, and a per-subscription charge history; cancel now or on a future date.
- **Utilities** — utility accounts tied to a property, with invoices that store the original bill (PDF/image), a no-AI heuristic scanner (optional AI assist), separate on-time vs. late totals, and **partial payments** (a payments ledger; an invoice closes once covered). Categorizing a transaction to a utility auto-applies it to the open invoice.
- **Itemized receipts** — attach a receipt image to any transaction; AI extracts line-item products (name, category, qty, unit price), which powers product-level analysis.
- **Wealth tracker** — net worth is **computed** from each account's opening balance plus posted transaction flows, combined with vehicles, generic assets, properties, and liabilities. Dated **balance snapshots** also feed a net-worth **history** chart: each snapshot is a dated balance fact in an append-only ledger, deleting a snapshot removes it from the history too, and every manual change is recorded in an append-only **balance-adjustment audit**.
- **Vehicles & properties** — track values; tag transactions to them for cost rollups.
- **Goals** — savings, debt-payoff, and reduce-spending goals with progress.
- **AI analysis** (requires an Anthropic API key): vehicle total cost of ownership, product-level spending, a spending & net-worth overview, and free-form questions over a snapshot. Every analysis is saved and re-viewable.

---

## Requirements

- **Node.js 18+**
- **Docker** (for the bundled PostgreSQL), or your own PostgreSQL 14+ instance
- An **Anthropic API key** — optional, only needed for the AI analysis features

---

## Quick start

```bash
# 1. Install all dependencies (root, server, web)
npm run install:all

# 2. Configure environment
cp .env.example .env
#    then open .env and (optionally) add your ANTHROPIC_API_KEY

# 3. Start Postgres, run migrations, and load sample data
npm run setup

# 4. Create your login (adopts the sample/legacy data into your book)
cd server && EMAIL=you@example.com PASSWORD='your-password' NAME='You' npm run bootstrap && cd ..

# 5. Run the app (API on :4000, web on :5173)
npm run dev
```

Then open **http://localhost:5173** and sign in. New users who sign up from the login
screen get their own empty book; the **bootstrap** step above instead attaches
your login to the book that adopted the existing seed/legacy data.

The app ships with seed data (sample accounts, a budget, transactions, two itemized receipts, utility bills, and a vehicle) so every screen is populated on first run. To start empty, edit `server/src/seed.ts` or simply delete records in the UI.

---

## Configuration (`.env`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://finance:finance@localhost:5432/finance` | Privileged Postgres connection (migrations, bootstrap, db-role setup) |
| `APP_DATABASE_URL` | _(= `DATABASE_URL`)_ | Connection the running server uses. Set to a **non-superuser** role so row-level security is enforced (superusers bypass RLS). |
| `DB_POOL_MAX` | `20` | Max pooled DB connections (each in-flight request holds one). |
| `PORT` | `4000` | API server port |
| `HOST` | `127.0.0.1` | Interface to bind. Loopback by default; set `0.0.0.0` to expose / run in a container. |
| `COOKIE_SECURE` | prod: `true` | Send the session cookie over HTTPS only. Defaults on when `NODE_ENV=production`. |
| `TRUST_PROXY` | prod: `true` | Trust `X-Forwarded-*` from one upstream proxy (ALB), so Secure cookies work behind TLS. |
| `APP_BASE_URL` | _(empty)_ | Public base URL, used to build absolute invite links (else links are relative). |
| `WEB_ORIGIN` | _(empty)_ | Optional CORS origin lock. Only needed if the SPA is served from a different origin. |
| `ANTHROPIC_API_KEY` | _(empty)_ | Your Anthropic key. AI features are disabled until this is set. |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | Model used for analysis. Alternatives: `claude-opus-4-8`, `claude-haiku-4-5-20251001`. |
| `RENTCAST_API_KEY` | _(empty)_ | Optional, for property value lookups. |

If `ANTHROPIC_API_KEY` is empty, the app runs fine — the AI Analysis page shows a notice, and AI endpoints return a clear "not configured" message instead of failing.

### Security & networking

Access is gated by **per-user login** (email + password). Passwords are hashed with
scrypt (per-user salt, constant-time compare). Sessions are **opaque tokens** stored
server-side (only a hash is persisted) and delivered as an **httpOnly, Secure,
SameSite=Lax** cookie; logging out revokes the session. All `/api` routes require a
valid session except `/api/auth/*`, the public invite preview `GET /api/invites/:code`,
and the `/api/health` + `/api/ready` probes.

- **Tenant isolation (two layers)** — (1) app layer: every request resolves to an
  active book and all data routes filter every query by `book_id`, with
  write-time checks that referenced accounts/categories belong to the caller; (2)
  database layer: **Postgres row-level security** on every tenant table. Each request
  runs on a dedicated connection with `app.book_id` set, and RLS policies restrict
  rows to it (default-deny when unset). RLS is enforced when the app connects as a
  non-superuser role — create one with `npm run setup:db-role` and point
  `APP_DATABASE_URL` at it (superusers bypass RLS).
- **Rate limiting** — login, sign-up, and invite endpoints are IP-rate-limited (429 with
  `Retry-After`) to blunt brute-force and code guessing.
- **Behind a proxy/TLS** — set `HOST=0.0.0.0`, terminate TLS at the proxy, and keep
  `TRUST_PROXY`/`COOKIE_SECURE` on (defaults in production) so Secure cookies work.
- **Invites** — random, single-link codes with optional expiry/max-uses and revoke; the
  public preview leaks only the book name.
- **Input validation** — a shared layer (`server/src/validation.ts`) gives every write
  route consistent, clean **400s** for malformed money / date / enum / id fields and
  **404s** for references to another book's records, instead of leaking 500s.
- **Uploads** — incoming files are MIME-allow-listed (HTML/SVG rejected) and served back
  with a forced content type + `nosniff` (non-image types as downloads), and AI-rendered
  markdown is escaped with safe link/image protocols, so stored content can't run as script.
- Server errors return a generic message (details are logged, not leaked); uploaded
  files are size-capped (25 MB on the upload routes, 256 KB elsewhere).
- **Connection model:** the app binds one DB connection per request (to carry the RLS
  book setting), so size `DB_POOL_MAX` above your expected concurrency.

---

## Available scripts (root)

| Script | What it does |
| --- | --- |
| `npm run install:all` | Install dependencies in root, `server/`, and `web/` |
| `npm run db:up` / `db:down` | Start / stop the Postgres container |
| `npm run migrate` | Apply SQL migrations in `server/migrations/` |
| `npm run seed` | Reset and load sample data |
| `npm run setup` | `db:up` → wait → `migrate` → `seed` |
| `npm run dev` | Run API and web together |
| `npm run dev:server` / `dev:web` | Run them individually |

---

## Using your own Postgres (no Docker)

Set `DATABASE_URL` in `.env` to your instance, then run `npm run migrate` and (optionally) `npm run seed`. Skip `npm run db:up`.

---

## Testing

Backend integration tests run against a **dedicated, disposable** Postgres
database (`finance_test`) on the docker-compose server — they never touch your
real `finance` data. They use Node's built-in test runner (via `tsx`), so there's
no extra test dependency.

```bash
# Make sure Postgres is up (docker compose), then:
cd server && npm test
```

`npm test` (alias `npm run test:integration`) drops/recreates `finance_test`,
applies all migrations, and runs the suite in `server/test/`. Each test registers
its own user + book, so tests are isolated by tenancy with no shared cleanup.
Override the target with `TEST_DATABASE_URL` (e.g. for CI):

```bash
TEST_DATABASE_URL=postgresql://finance:finance@localhost:5433/finance_test npm test
```

The suite covers the priority/regression areas: fresh migrate+seed, auth /
sessions / book switching / invite accept / `API_TOKEN`, transaction
transfers / split totals / cross-book refs / tag validation, budget progress
(splits, income, rollover, custom periods, account scoping) plus **period-snapshot
freezing** of category & group labels and **validated** account-scope writes,
**net-worth history** (snapshot delete voids its ledger fact), **reconciliation**
account-match enforcement, **import status** transitions (staged → imported / failed,
including rows re-pointed to another account) and staged partial-edit preservation,
import dedup, and upload MIME validation.

---

## Architecture

```
finance-tracker/
├─ docker-compose.yml        # PostgreSQL 16
├─ server/                   # Express + pg API (TypeScript, ESM)
│  ├─ migrations/            # 001_init.sql (full schema) + ordered .sql migrations
│  └─ src/
│     ├─ index.ts             # app, routes, serves web/dist in production
│     ├─ db.ts                # pg pool + NUMERIC→number parsing
│     ├─ config.ts            # env loading
│     ├─ validation.ts        # shared request validation (clean 400s / cross-book 404s)
│     ├─ uploads.ts           # upload MIME allow-list + safe file serving
│     ├─ ai/claude.ts         # Anthropic Messages API client
│     ├─ auth.ts              # scrypt password hashing + session helpers
│     ├─ tenant.ts            # authContext middleware + book scoping
│     └─ routes/              # auth, books, invites, accounts, categories, budgets,
│                             #   transactions, reconciliation, imports, networth,
│                             #   utilities, subscriptions, analysis, …
└─ web/                      # Vite + React + TypeScript SPA
   └─ src/
      ├─ App.tsx              # sidebar nav + routes
      ├─ api.ts               # fetch helpers + money/date formatting
      ├─ styles.css           # "greenbar ledger" design system
      └─ pages/               # Dashboard, Transactions, Budgets, Utilities, Accounts,
                              #   Vehicles, Analysis (large pages split into per-feature
                              #   folders: budgets/, transactions/, utilities/)
```

**Design notes**

- Money is stored as `NUMERIC` in Postgres and parsed to JS numbers at the DB boundary; derived sums are rounded to cents.
- Transactions use a `direction` (`expense` / `income` / `transfer`) with an always-positive `amount`.
- A reusable SQL CTE (`EFFECTIVE_LINES`) attributes split transactions to their parts, so budgets, goals, and rollups all count splits consistently. Current account balances anchor to the latest dated snapshot (or the opening balance) plus posted flows after it (`ACCOUNT_BALANCES`); the net-worth **history** reads a separate dated **balance-event ledger** (`account_balance_events`) where each manual snapshot is a fact and deleting a snapshot **voids** its fact, so history stays consistent without rewriting the append-only ledger.
- **Historical reports are frozen at close.** Closing a budget period snapshots its planned lines *and* their category/group labels into `budget_period_lines`, so a later rename or edit can't alter a past report; un-snapshotted (future) periods still read live data.
- **Validation is centralized.** `validation.ts` provides the money/date/enum/id checks and book-ownership lookups every write route shares, so invalid input fails fast with a 400 and cross-tenant references fail with a 404 — never a 500.
- **Migrations** are plain `.sql` files in `server/migrations/`, replayed in order on every `npm run migrate` (there's no tracking table), so each must be idempotent. One-time backfills are guarded so re-running migrations never clobbers data (e.g. manual orderings).
- **Multi-tenancy** is a shared schema: every ownable table carries a `book_id`, and tenant-scoped routes filter every query by the request's active book (resolved from the session cookie by `authContext`). See `tenant.ts` and `routes/accounts.ts` for the pattern.
- Multi-statement mutations run inside DB transactions (BEGIN/COMMIT) so a partial failure rolls back.
- The frontend talks to the API via a Vite dev proxy in development; in production the API serves the built SPA from `web/dist`.

---

## Status

The app is feature-complete for the workflows above and has been through a full code & architecture review. Recent work:

- **Multi-tenancy & auth** — email/password login, server-side sessions (httpOnly cookies), books with multi-membership + a sidebar switcher, and family **invite links**. **Every route is tenant-isolated** by `book_id` (Phase 1 wired accounts + transactions; Phase 2 swept all remaining routes — categories, budgets, goals, subscriptions, utilities, vehicles, properties, assets, liabilities, dashboard, net worth, AI analysis — plus per-book managed categories and write-time ownership checks on referenced accounts/categories). Hardened with **Postgres row-level security** (per-request `app.book_id`, enforced via a non-superuser app role) and **IP rate-limiting** on auth/invite endpoints. AWS deploy via Docker + **[DEPLOY.md](DEPLOY.md)**.
- **Migrations made safe to re-run** — one-time backfills are guarded so `npm run migrate` never resets manual category/budget ordering or re-categorizes transactions.
- **Security defaults** — per-user sessions (scrypt-hashed passwords, httpOnly Secure cookies); CORS lockable via `WEB_ORIGIN`; generic 500s; per-route body-size caps.
- **Correct dates** — calendar dates are parsed/compared in local time (no off-by-one for non-UTC users); "today" markers and overdue/due logic are consistent.
- **Transaction safety & DB** — multi-statement mutations (subscription pay, budget account scoping, reorders) run in DB transactions; added indexes on `transactions(account_id)` and other FKs, plus a CHECK on budget rollover mode.
- **Analysis accuracy** — AI overview/snapshot now read the current utility tables and compute net worth the same way as the dashboard; the reduce-spending goal counts split transactions.
- **Frontend cleanup** — shared `DragHandle`/reorder helpers, `EditIcon`, chart constants, and a canonical `Category` type are consolidated in `components/ui.tsx` / `types.ts` to prevent drift; the large Transactions / Budgets / Utilities pages are split into per-feature folders.
- **Hardening pass** (reviewed by an external model with no remaining blocking issues) — a **shared validation layer** across every entity route (clean 400s, cross-book 404s); upload + AI-markdown **XSS** fixes (MIME allow-list, escaped rendering); a dated **balance-event ledger** for net-worth history with **void-on-delete** semantics and an append-only balance audit; **reconciliation** items constrained to their session's account; **account import status** wired through staging/confirm (including rows re-pointed to another account); and **frozen budget-period** category *and* group labels (with a migration backfill for existing snapshots). Each fix ships with an integration test.

**Known limitations:** rate-limit state is per-process (use a shared store like Redis for strict limits across multiple instances); the business-day posted-date roll handles weekends but not bank holidays; budget "carry over" and "accrue" share the same running-balance math; migrations are replayed in order with no tracking table (each must stay idempotent).

---

## Production build

```bash
cd web && npm run build      # outputs web/dist
cd ../server && npm run build && npm start   # API serves web/dist at PORT
```

The API automatically serves `web/dist` when it exists, with SPA fallback for client-side routes.
