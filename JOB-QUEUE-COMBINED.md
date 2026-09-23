# JOB-QUEUE — Combined PRD + AGENT_RULES + SKILL

## Task
Task 2 of the Five Engineering Tasks brief: Background Jobs Done
Properly. Time budget: 14–18 hours.

---

## PART 1 — PRD

### What This Is
A real background job system. A user triggers sending an email
(real, via Gmail SMTP, reusing the exact pattern already proven
across three prior projects tonight). That work is taken off the
request path entirely, processed by a separate worker, survives
real failure, and every job's real outcome can be proven, not
assumed.

### What This Is Not
No interface beyond a minimal trigger and a status view. No
authentication beyond identifying a user (a simple userId is enough,
no real login system). No landing page.

### The Job Record
- `id` — generated (cuid/uuid), never sequential.
- `type` — what kind of work this is.
- `payload` — the input, stored as JSON.
- `status` — exactly one of: `pending`, `processing`, `succeeded`,
  `failed`, `dead`. `failed` = will retry. `dead` = exhausted
  retries, needs a human. These are NOT the same state.
- `attempts` — integer, how many times it has run.
- `maxAttempts` — from configuration.
- `lastError` — the most recent real error message.
- `runAt` — when it should next be attempted.
- `startedAt`, `finishedAt`.
- `idempotencyKey` — unique. The same logical job can never be
  created twice.

### A Second Table: EmailLog
Separate from the job table itself, worth deciding and documenting
explicitly: a small `EmailLog` table (`jobId` unique, `sentAt`) is
needed to track which jobs have genuinely, successfully sent an
email, since this is what the idempotent-work check in Part 3 reads
before ever calling the real email provider. This belongs in the
real schema from the start, not added as an afterthought once the
worker code is written.

### Behaviour
1. Enqueue: the request handler writes a `pending` row and returns
   `202` with the job id immediately. It never does the work. It
   never waits.
2. Idempotency: the same idempotency key arriving twice returns the
   existing job, never creates a second one.
3. Worker: a separate process, loops, atomically claims one
   `pending` job whose `runAt` has passed, does the work, marks it
   `succeeded` or `failed`. Two workers must never claim the same
   job — this is enforced by the database, not by application logic
   hoping it works.
4. Concurrency cap: the worker processes at most N jobs at once, N
   in configuration.
5. Failure handling: `attempts` is incremented once, atomically, at
   claim time (see Part 3), never again on failure. On a real
   failure, store the real error in `lastError` and check the
   already-incremented `attempts` against `maxAttempts`. If below,
   set back to `pending` with `runAt` = now + exponential backoff +
   jitter. If at or above, set `dead`.
6. Idempotent work: the actual email-sending logic must tolerate
   running twice safely (e.g. check whether this job id already sent
   successfully before sending again).
7. Stuck-job recovery: a sweep resets any job stuck in `processing`
   past a configured timeout back to `pending`, with attempts
   incremented.
8. Dead-letter view: lists dead jobs with payload + lastError, with
   a manual retry button.
9. Status endpoint: `GET /api/jobs/:id` returns status, attempts,
   error.

### The Five Required "Break It" Tests
1. Enqueue 50 jobs at once, confirm the concurrency cap genuinely
   holds (log real concurrent count).
2. Force 100% failure, watch one job progress through attempts to
   `dead`, with real, growing backoff visible in real timestamps.
3. Kill the worker process mid-job, restart it, confirm the stuck
   job is genuinely recovered.
4. Submit the same idempotency key twice, confirm exactly one job
   exists.
5. Run two workers at once against the same queue, confirm no job is
   ever claimed twice.

### Evidence Required
- Screenshot of the jobs table showing jobs in every status.
- Real timestamps showing backoff delays genuinely growing between
  attempts.
- Real log output showing the concurrency cap holding under 50 jobs.
- Stuck-job recovery: real screenshots before the kill, after the
  kill, after recovery.
- The dead-letter view with at least one real dead job in it.

---

## PART 2 — AGENT_RULES

These are the same, strict, proven rules used across every project
tonight (APE-P-I, Daily Meal, the Four Build Assessments), plus
rules specific to the real risks this task introduces.

### Git — non-negotiable
- NEVER commit, stage, or push without my explicit authorization for
  that specific commit. Read-only git commands (status, diff, log)
  are always fine, unprompted.
- Before any commit, run `git status` and report it honestly. Do not
  assume what's staged.
- Commit messages describe what actually changed. Never "update",
  "fix", "changes".
- Never squash unrelated changes into one commit — a schema change,
  a worker fix, and a documentation update are three commits, not
  one.
- Check for stray files (log files, test artifacts, debug output)
  before every commit. Delete them or add them to .gitignore. Do not
  commit them.

### Naming — learned the hard way tonight
- This project is named `job-queue`, lowercase, hyphenated. NEVER
  suggest or create a folder, file, or npm package name with capital
  letters — this broke `create-next-app` once already tonight.

### Secrets — non-negotiable
- Real credentials (Gmail app password, DATABASE_URL, any API key)
  are written into `.env` by hand, by ME, never by you.
- `.env.example` gets placeholders only, never real values.
- Confirm `.env` is gitignored BEFORE the first commit, not after.
- Before any commit, re-read the actual diff and confirm no real
  secret, password, or connection string is present anywhere, in
  code, in documentation, or in log output pasted into a file.
- If a real credential is ever accidentally exposed anywhere
  (screenshot, committed file, chat), say so immediately and
  plainly, don't wait to be asked.

### Concurrency — this task's core risk
- The worker's job-claiming query MUST be a single, atomic database
  operation (e.g. an UPDATE with a WHERE status = 'pending' clause
  that returns the claimed row). A SELECT followed by a separate
  UPDATE is a race condition and is NOT acceptable, even if it
  "usually" works in testing.
- Do not rely on in-memory state (a Map, a variable, a counter) to
  enforce anything that must hold true across multiple, potentially
  separate, worker processes. If this ever gets deployed to a
  serverless environment, in-memory state will NOT be shared across
  instances — this exact class of bug took three real, layered fixes
  to solve correctly in a prior project tonight. Design as if
  multiple processes are always possible, from the start.

### Evidence — non-negotiable
- Every piece of "Evidence Required" needs a REAL screenshot, REAL
  terminal output, or REAL log output. Never a description of
  expected behaviour presented as if it were observed. Never
  fabricated or synthetic-looking output.
- If a "break it" test doesn't produce the expected result on the
  first try, report the REAL result honestly and re-diagnose, don't
  quietly adjust the test until it passes.

### Documentation — required, same standard as every project tonight
- README.md: short entry point. What this is, quick setup, pointer
  to DOCUMENTATION.md.
- DOCUMENTATION.md: full, 8-section document (What This Is, How To
  Run It, The Flow Step By Step, The Data Model, The Concepts, What
  Went Wrong, What This Slice Does Not Handle, If I Built This
  Again), same pattern as every other project tonight. Section 6
  (What Went Wrong) must include every REAL bug found while building
  this, with real symptom/investigation/cause/fix, not sanitized.
- Both files updated progressively as work happens, not written once
  at the end from memory.

### Scope discipline
- Build only what's in this PRD. Treat "What This Is Not" as a hard
  boundary.
- If genuinely unsure whether something is in scope, ask, don't
  guess and don't silently expand scope.

### Sequencing
Build in this order, verify each step before moving to the next:
job record schema → enqueue path → atomic worker claim → failure
handling with backoff/jitter → idempotent work → stuck-job recovery
→ dead-letter view → status endpoint → the five break-it tests, in
order, each with real evidence before moving to the next.

---

## PART 3 — SKILL (technical how-to)

### Atomic job claiming (the core, non-negotiable pattern)
```typescript
// CORRECT: one atomic statement, database enforces exclusivity
const claimed = await prisma.$queryRaw`
  UPDATE "Job"
  SET status = 'processing', "startedAt" = NOW(), attempts = attempts + 1
  WHERE id = (
    SELECT id FROM "Job"
    WHERE status = 'pending' AND "runAt" <= NOW()
    ORDER BY "runAt" ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
`;
```
`FOR UPDATE SKIP LOCKED` is what makes this genuinely safe under real
concurrency — it lets multiple workers each grab a different row
simultaneously without ever colliding, without needing an
application-level lock.

### Exponential backoff with jitter
```typescript
function nextRunAt(attempts: number): Date {
  const baseDelayMs = 5000; // 5s
  const exponential = baseDelayMs * Math.pow(2, attempts);
  const jitter = Math.random() * exponential * 0.3; // up to 30% jitter
  return new Date(Date.now() + exponential + jitter);
}
```

### Idempotent email sending
```typescript
async function sendEmailJob(job: Job) {
  // Check first: has this exact job id already sent successfully?
  const existing = await prisma.emailLog.findUnique({ where: { jobId: job.id } });
  if (existing) return; // already sent, safe no-op on a second run
  await sendRealEmail(job.payload);
  await prisma.emailLog.create({ data: { jobId: job.id, sentAt: new Date() } });
}
```
**Honest, known limitation, worth documenting rather than hiding:**
this check-then-act pattern still has a narrow window — if the
process crashes after `sendRealEmail` genuinely succeeds but before
`emailLog.create` finishes, a retry will send a second, real email.
This is a real, residual risk, not fully eliminated by this pattern
alone. A stronger fix, worth using if the real time budget allows:
create the `emailLog` row in a `sending` state *before* calling
`sendRealEmail`, then update it to `sent` only after. A resumed job
finding a `sending` row (rather than no row at all) signals genuine
uncertainty about whether the email actually went out, which is
honest information worth surfacing rather than silently guessing
either way. Document whichever approach is actually built, plainly,
in DOCUMENTATION.md's own What Went Wrong or Concepts section.

### Stuck-job sweep
```typescript
import { STUCK_TIMEOUT_MS } from './config'; // real config module, not a local constant
await prisma.job.updateMany({
  where: { status: 'processing', startedAt: { lt: new Date(Date.now() - STUCK_TIMEOUT_MS) } },
  data: { status: 'pending', attempts: { increment: 1 } },
});
```

### Testing two workers without colliding (break-it test 5)
Run two separate `node worker.js` processes in two separate
terminals against the same database, enqueue several jobs, and
confirm via the real job table afterward that `attempts` never
exceeds what a single, correct claim per job would produce, and no
job shows signs of having been processed twice.
