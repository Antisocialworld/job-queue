# job-queue — DOCUMENTATION

Full documentation for Task 2 of the Five Engineering Tasks: *Background
Jobs Done Properly.*

Governing spec: `JOB-QUEUE-COMBINED.md`. Entry point: `README.md`.

---

## 1. What This Is

A real background job system. A user triggers sending an email (real,
via Gmail SMTP, reusing the pattern proven across prior projects). The
work is taken off the request path entirely — the enqueue API hands back
`202 Accepted` and never does the work. A separate worker process polls
the database, atomically claims jobs, does the work, and records every
real outcome. Jobs survive real failures via retry with exponential
backoff + jitter, a stuck-job sweep, a dead-letter view, and an
idempotent email send backed by a second table (`EmailLog`).

Stack: Next.js (App Router) + Prisma 6 + PostgreSQL 16 (local Docker),
Node-based worker run with `tsx`.

## 2. How To Run It

Prerequisites: Docker, Node 24, npm.

1. `docker compose up -d` — starts Postgres 16 on port `5434`
   (ports `5432`/`5433` were already owned by tonight's sibling
   projects, so this one deliberately uses `5434`).
2. **Create your `.env` by hand** — copy `.env.example` and fill in a
   real `DATABASE_URL` (and `GMAIL_USER`/`GMAIL_APP_PASSWORD` to send
   real email). The default local docker values are
   `postgresql://jobqueue:jobqueue@localhost:5434/jobqueue`.
3. `npx prisma migrate dev` — applies the schema migration(s).
4. `npm run dev` — the web app: `/` (trigger) and `/dead-letter`.
5. `npm run worker` — the job worker, in its own process.
6. `npm run sweep` — one-shot stuck-job recovery sweep.
7. `npm run db:studio` — browse the tables directly if you like.

Useful endpoints:

| method | route | purpose |
| ------ | ----- | ------- |
| POST | `/api/jobs` | enqueue a job (body has `idempotencyKey`, `payload`, `userId`) → `202` |
| GET | `/api/jobs/[id]` | status, attempts, lastError |
| POST | `/api/jobs/[id]/retry` | manual retry of a `dead` job (from the dead-letter view) |
| GET | `/dead-letter` | dead-letter view with payload + lastError + retry button |

## 3. The Flow Step By Step

1. **Enqueue.** `POST /api/jobs` validates the payload, then writes a
   `pending` row: `status='pending'`, `attempts=0`, `maxAttempts` (from
   config, snapshotted onto the row), `runAt=now`, and the unique
   `idempotencyKey`. Returns `202` + the job id immediately. Idempotency
   is enforced by a **database unique constraint**: a duplicate key hits
   `P2002`, the existing row is returned, and no second row is ever
   created (the app also checks first as an optimization, but the
   database is the arbiter).
2. **Claim.** The worker, in its own process, runs one atomic SQL
   statement:
   ```sql
   UPDATE "Job"
   SET status='processing', "startedAt"=NOW(), attempts=attempts+1
   WHERE id = (
     SELECT id FROM "Job"
     WHERE status='pending' AND "runAt" <= NOW()
     ORDER BY "runAt" ASC
     LIMIT 1
     FOR UPDATE SKIP LOCKED
   )
   RETURNING *;
   ```
   `FOR UPDATE SKIP LOCKED` is the entire point: multiple workers (or
   one worker at its concurrency cap) each grab a different row without
   ever colliding, with no application-level lock and no read-then-write
   in between. **`attempts` is incremented exactly once, here, atomically,
   at claim time. Failure handling never increments it again.**
3. **Work.** The email job checks `EmailLog` first (see idempotency
   below), then sends the real email over Gmail SMTP via `nodemailer`.
4. **Success.** The job is set `succeeded` with `finishedAt=now`. The
   `EmailLog` row is `sent` with a real `sentAt`.
5. **Failure.** The real error is stored in `lastError`. The
   already-incremented `attempts` is compared to the row's
   `maxAttempts`. Below → back to `pending`, `runAt = now + base * 2^attempts + jitter` (jitter up to 30%). At/above → `dead`, `finishedAt=now`.
   `dead` means "retries exhausted, needs a human"; it is not the same
   as `failed`.
6. **Stuck jobs.** The sweep (separate process, one-shot,
   `worker/sweep.ts`) resets any job stuck `processing` for longer than
   `STUCK_TIMEOUT_MS` (read from the real config module `config.ts`,
   not a hardcoded literal) back to `pending` with attempts
   incremented once.
7. **Dead-letter view.** `/dead-letter` lists `dead` jobs with payload +
   lastError and a manual retry button that POSTs to the retry route.
   The retry keeps the honest attempt count and simply re-queues the job
   at `runAt=now`.

## 4. The Data Model

Full design rationale and column-by-column tables live in `README.md`.
In short:

- `Job` — the work lifecycle. Cuid id, `type`, JSON `payload`, one of
  `pending`/`processing`/`succeeded`/`failed`/`dead`, `attempts`,
  `maxAttempts` (from config, snapshotted), `lastError`, `runAt`,
  `startedAt`, `finishedAt`, unique `idempotencyKey`,
  index `(status, runAt)` for the claim query.
- `EmailLog` — one row per job (`jobId` unique, FK, cascade delete).
  Owns the *proven* send state: `state` is `sending` (written before
  the provider is ever called) or `sent` (flipped only after a real,
  successful send, recording real `sentAt`).

Enums: `JobStatus`, `EmailSendState` are real Postgres enums.

## 5. The Concepts

- **Idempotency, enforced by the database.** Not an application-level
  check that "usually works" — a unique constraint. This is the
  difference between a guarantee and a hope.
- **Idempotent work, with honest uncertainty.** The `EmailLog`
  check-before-send pattern from Part 3, implemented with the stronger
  `sending`-state fix: the row is created in `sending` *before*
  `sendRealEmail` is called and flipped to `sent` only after success.
  A resumed job finding a `sent` row is a proven no-op. A resumed job
  finding a `sending` row records genuine uncertainty about whether the
  email went out — surfaced honestly rather than silently guessed.

  **Residual race, documented honestly (per AGENT_RULES):** a crash
  between a successful SMTP send and the `sent` update leaves the row at
  `sending`; the next attempt will send one duplicate real email. The
  `sending` state does not eliminate that final window — nothing short
  of an outbox+provider-id ledger does — but it makes the ambiguity
  visible in the data instead of invisible. This is deliberately
  narrower than a plain check-then-act: that pattern carries the same
  crash window *and* double-sends under concurrent claims, whereas this
  pattern cannot double-send from two concurrent claims because the
  unique `jobId` in `EmailLog` serializes them.
- **Backoff with jitter.** `BASE_DELAY_MS * 2^attempts + (0..30% jitter)`.
  The real formula is `worker/backoff.ts` and the values come from the
  real config module.
- **Concurrency cap is about in-flight work, not about who owns a row.**
  The worker claims at most `WORKER_CONCURRENCY` jobs at once. Exclusivity
  of each claimed row is always the database's job (`FOR UPDATE SKIP
  LOCKED`), never an in-memory flag — an in-memory Map is meaningless
  across separate processes.
- **`failed` vs `dead`.** `failed` = will retry automatically. `dead` =
  retries exhausted, needs a human. Distinct states, deliberately.

## 6. What Went Wrong (real bugs, honestly reported)

1. **create-next-app auto-committed.** The scaffold created git repo and
   made an `Initial commit from Create Next App` (`8bd8b68`) by itself —
   before any of my work. Reported immediately; no further commits have
   been made (AGENT_RULES: no commits without authorization).
2. **`create-next-app` refused to scaffold into a non-empty folder.**
   Symptom: "contains files that could conflict: JOB-QUEUE-COMBINED.md,
   README.md". Investigation: the CLI refuses to overwrite existing
   docs. Fix: temporarily moved the two files to a temp dir, scaffolded,
   restored both exactly. `JOB-QUEUE-COMBINED.md` is byte-for-byte the
   original.
3. **`npm install` kept hanging / submitting no output.** Symptom: the
   install of `prisma` (latest at the time = `8.0.0-rc.15`) timed out
   repeatedly even at high timeouts, leaving zombie `node` processes
   holding locks. Investigation: the tool's timeout SIGTERM killed the
   shell but not the npm children; later ticks showed 4 orphaned node
   processes. Also the unpinned install resolved to a release candidate
   plus long engine-downloads. Fix: kill the orphans, pin
   `prisma@7.10.0`... then, after the engine tooling became the problem
   (below), pin the whole stack to the Prisma 6 line.
4. **Prisma 7's new client generator throws `EEXIST: file already
   exists, mkdir '...\prisma\models'` on Windows.** Symptom: `prisma
   generate` deterministically failed on this machine when the output
   directory lived under the project; it succeeded into a temp dir and
   failed for `models` *and* `internal` depending on run. Investigation:
   instrumented `fs.promises.mkdir` with a preload shim and captured
   stacks showing the generator's recursive tree-writer calling
   `mkdir('models')` twice concurrently (two `Promise.all(index 5)`
   i8e invocations). No upstream fix (7.10.0 is the newest stable 7.x).
   Fix: **downgraded the project to Prisma 6.19.3**, the stable,
   battle-tested line used across prior projects tonight (classic
   `prisma-client-js`, native query engine, auto `.env` loading, no
   driver-adapter ceremony). The `$queryRaw ... FOR UPDATE SKIP LOCKED`
   claim pattern is identical. Also removed the v7-only
   `prisma.config.ts` and `@prisma/adapter-pg` and `dotenv` (v6
   auto-loads `.env`).
5. **Next 16 breaking-changes bite (this is NOT the Next.js from
   training data).** Symptom: `tsc` failed with `Cannot find name
   'RouteContext'` and later `"/jobs/[id]" does not satisfy the
   constraint 'AppRouteHandlerRoutes'`. Investigation: read the bundled
   docs in `node_modules/next/dist/docs/` per this repo's `AGENTS.md`;
   discovered `ctx.params` is an awaited Promise and `RouteContext<...>`
   must name the full route including `/api/`. Fix: `await ctx.params`
   with `RouteContext<"/api/jobs/[id]">`, and ran `next typegen`.
6. **Leftover `MAX_ATTEMPTS` reference after simplification.** Symptom:
   `tsc` error `Cannot find name 'MAX_ATTEMPTS'` in the worker. Fix:
   removed the stale reference; failure threshold is the row's own
   `maxAttempts` snapshot.
7. **A concurrency-capacity parse scare during the break-it tests.**
   Symptom: the backoff retry-schedule timestamps in a test run looked
   "wrong" when read across attempts. Investigation: instrumented the
   failure path with a one-off `[worker][dbg]` log of
   `nextRunAt(job.attempts)` and confirmed the DB `runAt` written matched
   the formula exactly (`2000 · 2^attempts + ≤30% jitter`: +8.1s, +17.0s,
   +37.0s for attempts 2→4). The apparent discrepancy was caused by
   comparing claim/failure timestamps instead of the actual `runAt`
   values — not a code bug. The debug line was removed.
8. **Test-only send gate added deliberately (not a bug).** To run the
   bulk tests without sending real email, `sendRealEmail` gained a
   clearly-labelled, env-gated branch: `WORKER_TEST_DISABLE_SEND=1`
   skips only the Gmail network call (sleeps `WORKER_TEST_SLEEP_MS` to
   hold the claim open, logs `[email][TEST]`). Every other code path
   (claim, attempts, status, EmailLog, backoff) runs exactly as in
   production. Chosen over a fake recipient address because a
   non-delivering address still burns real SMTP attempts and hard-fails
   on external behaviour.

## 7. What This Slice Does Not Handle

- No real authentication or user system — a `userId` string is enough
  (per PRD, deliberately).
- The job table is append-only for now; no retention/culling of
  `succeeded` jobs.
- Backoff cap: the formula grows unboundedly (`5s, 10s, 20s, 40s …`);
  no ceiling is applied. Fine for a max of 5 attempts.
- No dead-letter "purge" or "snooze" beyond manual retry.
- Only one job `type` (`email`) is implemented.
- The residual email duplicate-send window described in Section 5 is
  real and not eliminated.

## 8. If I Built This Again

- I'd adopt the stronger send ledger earlier: rather than a boolean-ish
  `state` on `EmailLog`, keep a provider message id / last-attempt
  ledger so a crashed `sending` row can be resolved without risking a
  duplicate.
- I would not have started the migration on Prisma 7 the same way —
  given this machine, going straight to the proven 6.x setup would have
  saved the npm/engine/generator detour recorded in Section 6.
- The sweep and worker would eventually share a library with the app's
  route handlers (they already share `config.ts` and `lib/prisma.ts`).

## 9. Break-It Test Evidence (authorized run)

All five tests below ran against the real local Postgres (same DB used
by the confirmed end-to-end smoke test), with real output captured. The
bulk tests used the safe gate from Section 6.8 — no real email was ever
sent to the user's inbox by any test.

**Test 1 — 50 jobs, concurrency cap holds.**
50 jobs enqueued via `POST /api/jobs` (payload `to=test@example.invalid`,
gate on). One worker (`WORKER_CONCURRENCY=3`). Worker's real logs:
claimed `inFlight=1/3, 2/3, 3/3, 1/3, …` repeated across all 50 claims —
peak observed concurrent = 3/3, never above. DB after drain:
`succeeded|50`, `anyJobAttemptedTwice=0`, `t1Total=50`.

**Test 2 — forced 100% failure → retry → dead, growing backoff.**
Job of type `broken-type` (worker throws `unknown job type: broken-type`
before any email code, so no email is ever created). With
`BASE_DELAY_MS=2000`, real `runAt` schedule written by
`nextRunAt(job.attempts)` (verified against the DB `runAt`):
attempt 1 → +4.2s, attempt 2 → +8.1s, attempt 3 → +17.0s, attempt 4 →
+37.0s; attempt 5 exceeded `maxAttempts=5` →
`dead`, `lastError=unknown job type: broken-type`, `attempts=5`. The
inter-attempt deltas are strictly growing and within
`2000 · 2^attempts + ≤30% jitter`.

**Test 3 — real process kill + stuck-job sweep recovery.**
Worker PID captured; job claimed (status `processing`, attempts 1,
`startedAt` set, EmailLog row `sending`). `Stop-Process -Force` — a real
OS process kill (`gone=True`). Job stayed `processing` with `startedAt`
unchanged. `npm run sweep` with `STUCK_TIMEOUT_MS=3000`:
`[sweep] reset 1 stuck job(s) to pending` → row `pending|2`. Restarted
worker claimed it (attempts 3), found the `sending` EmailLog row →
logged `has a 'sending' row (unconfirmed prior attempt) - attempting
send`, completed, final row `succeeded|3`, EmailLog `sent|sentAt`. The
idempotent resume path was genuinely exercised.

**Test 4 — identical idempotency key twice → exactly one row.**
submit1 `created=True`, submit2 `created=False` with the same `jobId`;
`SELECT COUNT(*) WHERE idempotencyKey=…` → `rows_for_key=1`.

**Test 5 — two concurrent workers, zero double-processing.**
Two independent worker processes (A PID and B PID) started against the
same queue with 20 jobs. Both reached full `inFlight=3/3`
simultaneously (6 claims in flight at the cap). Final DB truth:
`succeeded|20`, `jobClaimedTwice=0`, `maxAttemptsOnAnyT5=1` (no job ever
claimed twice), `emailLogRowsForT5=20` (each job processed exactly
once). `FOR UPDATE SKIP LOCKED` arbitration held; no application-level
locks were used.