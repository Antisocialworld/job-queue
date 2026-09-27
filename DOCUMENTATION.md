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
6. **Overlong jobs, capped by wall-clock duration.** A second, independent
   mechanism (`worker/overlong.ts`) reclaims any `processing` job whose real
   duration `now - startedAt` exceeds `MAX_JOB_DURATION_MS`, *regardless of
   whether its heartbeat is still current*. It reclaims to `pending` with
   `attempts` incremented once and a real `lastError`. See §4b.
7. **Stuck jobs, detected by heartbeat.** The sweep (separate process,
   one-shot, `worker/sweep.ts`) resets any job whose worker has stopped
   beating to `pending` with attempts incremented once. Liveness is measured
   from `Job.lastHeartbeat`, **not** from `startedAt` — see §4a. The timeout
   is `STUCK_TIMEOUT_MS` (read from the real config module `config.ts`, not a
   hardcoded literal).
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
   `startedAt`, `lastHeartbeat`, `finishedAt`, unique `idempotencyKey`,
   index `(status, runAt)` for the claim query, plus
   `(status, lastHeartbeat)` for the sweep query. Also `leaseVersion`,
   `workerInstanceId` and `possibleDuplicateSend` — see section 4c.
- `EmailLog` — one row per job (`jobId` unique, FK, cascade delete).
  Owns the *proven* send state: `state` is `sending` (written before
  the provider is ever called) or `sent` (flipped only after a real,
  successful send, recording real `sentAt`).

Enums: `JobStatus`, `EmailSendState` are real Postgres enums.

## 4a. `lastHeartbeat`: liveness, not elapsed time
**The bug this replaces.** The sweep used to decide a job was stuck purely
from `startedAt`: any job that had been `processing` for longer than
`STUCK_TIMEOUT_MS` was reset to `pending`. That conflates *"has been open a
long time"* with *"nobody is working on it"*. A worker that is alive and
healthy but slow — Gmail's SMTP server taking unusually long, a large
payload — keeps its claim while the sweep resets the job out from under it.
The job becomes claimable a second time, and the same email can be sent
twice.

**The mechanism.** `Job.lastHeartbeat DateTime?` is a liveness signal, not a
duration:

- The atomic claim stamps `lastHeartbeat = NOW()` alongside
  `startedAt = NOW()`.
- While a job is in flight, the worker refreshes `lastHeartbeat` every
  `HEARTBEAT_INTERVAL_MS` (`withHeartbeat` in `worker/worker.ts`), including
  one immediate beat before the work starts.
- The sweep resets a job only when `lastHeartbeat` is **older than
  `STUCK_TIMEOUT_MS`**. A slow-but-alive worker keeps beating, so its job is
  never reclaimed no matter how long it has been open.

**Why the interval is derived, not hardcoded.** `HEARTBEAT_INTERVAL_MS`
defaults to `STUCK_TIMEOUT_MS / 6` — 10s against the default 60s timeout. A
worker must therefore miss ~6 consecutive beats before the sweep will touch
its job, so the margin is structural rather than a coin-flip against timer
scheduling. Override it only if you keep it under `STUCK_TIMEOUT_MS / 3`.

**A late beat cannot resurrect a reclaimed job.** The heartbeat update is
guarded on `status = 'processing'`, so if the sweep has already reclaimed a
job, a straggler beat from the original worker is a no-op instead of
refreshing the heartbeat of a job that is back in the queue.

**NULL-safety, deliberately.** A plain `lastHeartbeat < cutoff` filter would
be a trap: in SQL, comparing `NULL` with `<` yields `NULL`, never true, so
every job with no heartbeat would sit `processing` *forever*. The sweep
therefore matches `lastHeartbeat < cutoff` **or** (`lastHeartbeat IS NULL`
**and** `startedAt < cutoff`). Rows with no heartbeat can only predate this
column, so they fall back to the old `startedAt` rule and still get
reclaimed.

**Unchanged.** This is a change to *detection timing* only. The unique
constraints (`Job.idempotencyKey_key`, `EmailLog.jobId_key`), the
`sending`→`sent` state machine, and the `FOR UPDATE SKIP LOCKED` claim are all
exactly as they were.

## 4b. The three timeouts, and why they are three

A heartbeat answers "is the process alive?", which is not the same question as
"is this job making progress?". A job stuck in an infinite loop, or waiting on
a call that never times out, keeps beating happily forever and would hold a
worker slot for the life of the process. Liveness alone therefore cannot bound
how long a single attempt may run. There are three separate settings, and
conflating any two of them reintroduces a real bug:

| Setting | Question it answers | Signal | Default | Detects |
|---|---|---|---|---|
| `HEARTBEAT_INTERVAL_MS` | How often is liveness *proven*? | cadence, not a threshold | `STUCK_TIMEOUT_MS / 6` = 10000 | nothing by itself |
| `STUCK_TIMEOUT_MS` | Has the worker **stopped beating**? | `lastHeartbeat` age | 60000 | dead / crashed worker |
| `MAX_JOB_DURATION_MS` | Has this job run **too long at all**? | `startedAt` age | 20000 | hung-but-alive job |

- **`HEARTBEAT_INTERVAL_MS`** is a cadence, not a limit. It only controls how
  often `lastHeartbeat` is refreshed, and therefore how much slack
  `STUCK_TIMEOUT_MS` needs in order to tolerate missed beats. It is derived as
  `STUCK_TIMEOUT_MS / 6` so ~6 consecutive beats must be missed before the
  dead-worker check fires.
- **`STUCK_TIMEOUT_MS` (60s)** is the *dead worker* check. It reads
  `lastHeartbeat`, never `startedAt`. A slow-but-alive worker keeps beating
  and is left alone, however long it has been open.
- **`MAX_JOB_DURATION_MS` (20s)** is the *hard ceiling*, and it reads
  `startedAt` and deliberately **never consults `lastHeartbeat`**. A fresh
  heartbeat cannot buy a hung job more time. A real successful Gmail SMTP
  send finishes well under 5s, so 20s is generous headroom for network
  slowness while still being meaningfully tighter than the 60s dead-worker
  timeout — the ceiling gets first refusal on a job that is both hung and
  stale.

**Enforced invariant, not a convention.** `config.ts` throws at load time if
`MAX_JOB_DURATION_MS > STUCK_TIMEOUT_MS`, naming both values and the required
ordering. The relation is load-bearing: if the ceiling were looser than the
dead-worker timeout, a hung-but-alive job would sit untouched until the far
longer heartbeat check, and the ceiling could never fire. Silently continuing
would produce a config that looks valid and behaves wrongly, so it fails loudly
at startup instead (verified: non-zero exit, real message).

**Why they are two mechanisms and not one condition.** The queries are
separate functions in separate modules (`worker/sweep.ts` and
`worker/overlong.ts`) with their own predicates and their own log lines, and
each is independently testable. Folding them into a single `OR` would be
wrong twice over: it would destroy the distinct log evidence for *which*
failure mode fired, and it would let one job satisfy both clauses at once,
hiding the fact that two independent problems existed. `npm run sweep` runs
the ceiling first, then the heartbeat check.

**Reclaim semantics, and why not straight to `dead`.** An overlong job goes
back to `pending` with `attempts` incremented once and a real `lastError`,
exactly as the dead-worker sweep does. A job that hung once because of a
transient network fault should get another attempt; one that hangs every time
exhausts `maxAttempts` and lands in `dead` for a human, bounded by the
existing backoff. Sending it straight to `dead` would discard a legitimately
transient failure.

**Known interaction.** `WORKER_TEST_SLEEP_MS` (default 300ms) deliberately holds
a claim open in test mode. Setting it above `MAX_JOB_DURATION_MS` will make
the ceiling reclaim that job — which is the cap working as designed, but worth
knowing before using a long sleep to simulate a slow send.


## 4c. `leaseVersion`: detecting work that lost its job
**The bug this replaces.** Both reclaim mechanisms above can take a job back
while the original worker is still running — that is the entire point of them.
Before the lease, that worker's completion write was an unconditional
`update({ where: { id } })`, so it landed *on top of* the new holder's row: the
loser overwrote the winner's `status`, and if the loser had already made a real
irreversible SMTP call, the duplicate was invisible. The system had no way to
tell a legitimate completion from a stale one, so it silently believed both.

**The mechanism.** Three columns, all real and migrated:

- `leaseVersion Int @default(0)` — incremented by the claim itself, in the same
  `UPDATE ... FOR UPDATE SKIP LOCKED` statement that transfers the job, so
  ownership transfer and version bump are one indivisible database operation.
  `RETURNING` hands the worker the exact version it now owns.
- `workerInstanceId String?` — a per-process UUID (`worker-<uuid>`, logged at
  startup) stamped by the same claim, naming *which* process holds the lease.
- `possibleDuplicateSend Boolean @default(false)` — durable evidence that a real
  send may have been duplicated, for a human to review.

Every completion write — success, retry, dead, and the `EmailLog`
`sending -> sent` flip — is an `updateMany` guarded on
`{ id, leaseVersion: <mine> }`. Matching 0 rows means the lease was lost. That
is a detection, not a retry: the write is discarded, never re-queued, because
re-queuing is exactly what could place a second real send.

**The reclaim invalidates the lease too.** Both `reclaimOverlongJobs` and
`sweepStuckJobs` bump `leaseVersion` and null `workerInstanceId` as part of the
reclaim. This is load-bearing and easy to miss: if only the claim bumped the
version, then in the window between a reclaim and the next claim the old
worker's lease would *still match*, and a late completion could resurrect a job
that had just been taken back. Invalidating at reclaim time means the stale
worker is caught immediately, even if nobody ever re-claims the job. The lease
rejection test asserts this window specifically.

**The audit event, and what it deliberately does not do.** A rejected write logs
one greppable line naming the `jobId`, the rejected worker's own
`workerInstanceId`, the expected and actual `leaseVersion`, the observed status,
and the write that was discarded, then sets `possibleDuplicateSend=true`. It
writes only that boolean — deliberately *not* `status` and *not* `lastError`,
because the loser has no right to overwrite the current holder's real state.
The write is unconditional precisely because the worker that lost the race is
the only one holding the evidence.

**No compensation, on purpose.** There is no retraction email and no attempt to
un-send. A duplicate may genuinely have been delivered, and pretending to fix it
would be worse than saying so. `possibleDuplicateSend=true` is the honest
record. Note the flag is *possible* duplicate, not *confirmed* duplicate: the
lease proves a send may have been duplicated, not that the provider delivered
it twice.

**`EmailLog` unique violations take the same path.** `sendEmailJob` does
check-then-act (`findUnique`, then `create`), so two workers can both pass the
check. The real `EmailLog_jobId_key` unique index is the arbiter: the loser's
`P2002` is caught *specifically* (not as a generic error) so it is never
re-queued into a resent email.

**How bad was it, verified rather than asserted.** Two throwaway diagnostics
against real Postgres, real `sendEmailJob`, real `WORKER_TEST_DISABLE_SEND=1`:

1. Two concurrent `sendEmailJob` calls: **12 of 12 rounds** collided with a real
   unique violation, each round with exactly one send. The loser's violation
   propagated as a plain `Error` into `runJob`'s catch-all, which re-queued the
   job as `pending` with backoff.
2. With the row still in `sending` when the retry lands — i.e. the winner is
   still mid-SMTP, which is this system's normal failure mode — the retry
   **did place a second real send** (`send attempts made by the retry: 1`,
   returned `state: "sent"`).

An honest qualifier on severity: the duplicate did *not* appear in the 12-round
concurrent test, because the winner finished before the retry fired. It requires
the winner to still be mid-send. So this was a genuine but timing-dependent
duplicate, not a certainty — and it is invisible without the audit flag, which
is why the flag exists.


## 4d. Two arbiters, one outcome: the insert race vs the lease guard
**The gap the lease work introduced.** Adding the lease created a *second*
arbitrator. `EmailLog` is arbitrated by the unique index on `jobId`; `Job`
terminal state is arbitrated by `leaseVersion`. Nothing coupled them, and they
genuinely disagreed. Losing the insert race and holding the valid lease are
independent facts that can belong to different workers.

**How it diverged.** A worker slower than `MAX_JOB_DURATION_MS` gets reclaimed
by the duration cap while still mid-SMTP; B claims the job and holds the valid
lease; both then race the `EmailLog` insert. Nothing in `sendEmailJob` consults
the lease before that insert, so the race is decided purely by timing. Forced
into that interleaving, the stale worker won the insert in **7 of 12 rounds**.

When it did, the two arbiters pointed in opposite directions and *both workers
declined to act*:

- the stale worker owned the `EmailLog` row, but its `sending -> sent` flip was
  lease-guarded and therefore rejected — so a real, irreversible send was
  **silently discarded**, leaving the row at `sending`;
- the valid lease-holder had the sole authority to write terminal state, but
  lost the insert, so it returned `deferred` and wrote nothing.

`Job.status` stayed `processing`, `EmailLog` stayed `sending`, and the next
claimer read that stale row as an unconfirmed attempt and **sent a duplicate**.
The lease work did not prevent the duplicate here; it manufactured one. The
root cause is a category error: the `sending -> sent` flip was treated as a
scheduling decision when it is a record of a real-world fact.

**The fix, in three parts.**

1. **The flip is no longer lease-guarded.** A delivery that happened is a fact
   about the world, not a scheduling decision. The lease says who is
   responsible for the job right now; it says nothing about whether the email
   was sent. `EmailLog_jobId_key` already guarantees exactly one worker owns the
   row, so the lease adds nothing there. The flip is now a plain
   `updateMany({ jobId, state: 'sending' })`. If the lease has since been lost,
   the send is flagged as a possible duplicate *and still recorded* — discarding
   a real send to keep a clean log is precisely the bug.
2. **The insert-race loser no longer abandons the job.** It is usually the
   current lease-holder, and therefore the only worker allowed to write the
   terminal status. So instead of returning immediately, it waits up to
   `DUPLICATE_SEND_CONFIRM_MS` (default 2000) to see whether the peer really
   delivered. If the row reaches `sent`, it reports `alreadySent` and its
   lease-guarded completion write records `succeeded` — no second send. Only a
   row still `sending` after the budget is genuine uncertainty, and only then
   does it defer, writing nothing.
3. **The heartbeat is lease-guarded, and the flag stopped crying wolf.** Every
   other write in the system is lease-guarded; `withHeartbeat` was the one
   exception, guarding only on `status = 'processing'`. So a worker that had
   lost its lease kept beating on the *new* holder's job — its beats matched,
   because the new holder had set the row back to `processing` — masking a job
   nobody was working on from the liveness sweep. It is now guarded on
   `leaseVersion` too. Separately, a worker that lost the insert race provably
   never reached `sendRealEmail`, so it can never have caused a duplicate and no
   longer sets `possibleDuplicateSend`; that flag now fires only when a real
   send genuinely happened under a stale lease.

**Result, forced through the same 7/12 divergence scenario, 16 real rounds**
(`tests/send-race-divergence.test.ts`, real Postgres, real claim/reclaim/send):

| | before | after |
|---|---|---|
| divergent rounds | 7 of 12 | 11 of 16 (race still happens — it is not suppressed, only resolved correctly) |
| real sends per round | 1, plus **1 duplicate on the next claim** | **exactly 1, every round** |
| `EmailLog` at end | `sending` (send lost) or `sent` | **`sent`, every round** |
| `Job.status` at end | `processing`, `succeededBy=NOBODY` | **`succeeded`, every round** |
| who wrote `succeeded` | nobody; convergence required a *second send* | **the valid lease-holder, under its own valid lease** |
| duplicate flag, aligned race | fired (false positive) | **does not fire** |

The stale worker is still refused the right to write `Job` state in every round
(`writesA=0` throughout) — that part of the lease was correct and stays. The
change is that the *send* it performed is now recorded, and the worker actually
authorised to close the job is the one that closes it.

Genuine uncertainty is preserved, not papered over: with a stub peer that
inserts a row and never confirms a send, the lease-holder still defers, places
no send, writes nothing, leaves `EmailLog` honestly at `sending`, and sets no
duplicate flag (exercised 6 of 6).


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

**Test 6 — forced lease rejection, verified (`tests/lease-rejection.test.ts`).**
27 checks, all passing, against real Postgres using the real claim statement,
the real `reclaimOverlongJobs`, and the real guarded completion write. A job is
claimed by worker A, left to exceed `MAX_JOB_DURATION_MS`, reclaimed for real,
then re-claimed by worker B — and A is still told to complete:

- case 1 — the real reclaim bumped `leaseVersion` `1 -> 2` and nulled
  `workerInstanceId`; A's late write matched `0` rows **with no re-claim
  present**, and the job stayed `pending` rather than being resurrected. This
  is the reclaim-time invalidation window.
- case 2 — B's claim took the version to `3`; A's completion still matched
  `0` rows, left `status=processing` and `workerInstanceId=worker-B-instance`
  untouched, and the audit then set `possibleDuplicateSend=true` without
  overwriting B's `lastError`.
- case 3 — the warning was asserted field by field: `jobId`,
  `rejectedWorkerInstanceId=worker-A-instance`,
  `leaseVersionMismatch expected=1 actual=3`, `observedStatus=processing`, the
  `DISCARDED (lease lost)` companion line, and the explicit
  `NOT compensating` wording.
- case 4 — an uncontested job still completes normally
  (`count=1`, `status=succeeded`, no duplicate flag), so the guard is not
  simply blocking writes.

Also re-run and still passing after the lease landed:
`tests/overlong.test.ts` (15 checks) and `tests/sweep-heartbeat.test.ts`
(14 checks, including that `Job_idempotencyKey_key` and `EmailLog_jobId_key`
still exist and still reject duplicates). Project-code typecheck: 0 errors
outside generated `.next`. `npm run lint`: clean.

**Test 7 — send-race divergence, the fix for the bug the lease introduced
(`tests/send-race-divergence.test.ts`).** 118 checks, all passing, 16 forced
divergence rounds plus 6 genuine-uncertainty rounds, real Postgres. Reproduces
the exact interleaving that produced 7/12 duplicates before the fix: a job
claimed by A, left past `MAX_JOB_DURATION_MS`, reclaimed for real, re-claimed
by B, then raced through the real `sendEmailJob`.

- **16 of 16 rounds: exactly one real send.** `totalSends=16 over 16 rounds`.
- **16 of 16 rounds: `EmailLog=sent` and `Job=succeeded`**, with no second claim
  needed — convergence came from recording the existing send, not a new one.
- **16 of 16 rounds: `writesB=1, writesA=0`** — the terminal status was written
  by the valid lease-holder under its own lease, and the stale worker wrote
  nothing to the job row.
- The race still genuinely happens (**11 divergent / 5 aligned**). The fix does
  not suppress the race; it resolves both outcomes correctly.
- All 5 aligned rounds: `dupFlag=false` — the false positive is gone.
  All 11 divergent rounds: `dupFlag=true`, which is correct, because the stale
  worker really did place a send under a dead lease.
- Genuine uncertainty (stub peer inserts, never confirms): 6 of 6 deferred with
  `sends=0`, `writes=0`, `EmailLog=sending`, `Job=processing`, `dupFlag=false` —
  honest uncertainty preserved, no send, no retry, no false flag.

Also added: `tests/lease-rejection.test.ts` case 5 drives the real
`withHeartbeat` and proves a stale lease **cannot** refresh the heartbeat
(`lastHeartbeat` stayed at epoch 0) while the current lease can.