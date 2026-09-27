# job-queue

Task 2 of the Five Engineering Tasks: **Background Jobs Done Properly.**

A real background job system. A user triggers sending an email (real,
via Gmail SMTP, reusing the pattern already proven across prior
projects). That work is taken off the request path entirely, processed
by a separate worker process, survives real failure, and every job's
real outcome can be proven, not assumed.

Stack: **Next.js + Prisma + PostgreSQL (local Docker)** — matching every
other project built tonight.

- Full documentation: [DOCUMENTATION.md](./DOCUMENTATION.md)
- Governing spec (PRD + AGENT_RULES + SKILL): [JOB-QUEUE-COMBINED.md](./JOB-QUEUE-COMBINED.md)

---

## The Job Record — design, agreed before writing any code

Two tables. The job table owns the work lifecycle. A second, separate
table (`EmailLog`) tracks which jobs have genuinely, successfully sent
an email — this is what the idempotent-work check reads *before* ever
calling the real email provider. It belongs in the real schema from the
start, not added as an afterthought once worker code exists.

### `Job`

| column          | type                | notes                                                              |
| --------------- | ------------------- | ------------------------------------------------------------------ |
| `id`            | text (cuid)         | generated, never sequential                                        |
| `type`          | text                | what kind of work this is (e.g. `email`)                           |
| `payload`       | jsonb               | the input, stored as JSON                                          |
| `status`        | enum (`JobStatus`)  | exactly one of `pending`, `processing`, `succeeded`, `failed`, `dead` |
| `attempts`      | integer             | how many times it has run                                          |
| `maxAttempts`   | integer             | from configuration, snapshotted onto the row at enqueue            |
| `lastError`     | text, nullable      | the most recent real error message                                 |
| `runAt`         | timestamptz         | when it should next be attempted                                   |
| `startedAt`     | timestamptz, nullable | set once, atomically, at claim time                               |
| `finishedAt`    | timestamptz, nullable | set when the job reaches a terminal state (`succeeded`/`dead`)    |
| `idempotencyKey`| text, **UNIQUE**    | the same logical job can never be created twice                    |
| `createdAt`     | timestamptz         |                                                                     |

Notes on the states: `failed` = will retry. `dead` = retries exhausted,
needs a human. These are **not** the same state.

### `EmailLog`

| column      | type                 | notes                                                                                        |
| ----------- | -------------------- | -------------------------------------------------------------------------------------------- |
| `id`        | text (cuid)          | generated                                                                                    |
| `jobId`     | text, **UNIQUE**, FK → `Job.id` | one row per job; this is the idempotent-work check's key                                 |
| `state`     | enum (`EmailSendState`) | `sending` \| `sent` — the stronger fix from the combined file (row written *before* the provider is called, flipped to `sent` only after the email genuinely went out) |
| `sentAt`    | timestamptz, nullable | when the email genuinely went out                                                            |
| `createdAt` | timestamptz          |                                                                                               |

### Idempotency

- `Job.idempotencyKey` is enforced as a database-level **unique
  constraint**, never by application-level checking alone. The same key
  arriving twice returns the existing job (`202`); a second row is
  never created.
- `EmailLog.jobId` is unique, so a job can never produce two "sent"
  records in the real schema.

---

## Quick setup

1. `docker compose up -d` — Postgres 16 (port `5434`, see
   [`docker-compose.yml`](./docker-compose.yml) and note: the default
   local ports were already taken by tonight's sibling projects).
2. Copy `.env.example` to `.env` and fill in the real values **by hand**
   — see note on secrets below.
3. `npm install`
4. `npx prisma migrate dev` — create the schema.
5. `npm run dev` — Next.js app (enqueue + status + dead-letter).
6. `npm run worker` — the worker process.
7. `npm run sweep` — the stuck-job recovery sweep.

### Secrets — non-negotiable

Real credentials (Gmail app password, `DATABASE_URL`) are written into
`.env` by hand, never by any tooling, and never committed. `.env` is
gitignored. `.env.example` contains commented placeholders only. If a
real credential were ever exposed anywhere, that would be reported
immediately.