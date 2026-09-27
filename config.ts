export function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return fallback;
  return parsed;
}

export const MAX_ATTEMPTS = intFromEnv("MAX_ATTEMPTS", 5);
export const WORKER_CONCURRENCY = intFromEnv("WORKER_CONCURRENCY", 3);
export const POLL_INTERVAL_MS = intFromEnv("POLL_INTERVAL_MS", 1000);
export const BASE_DELAY_MS = intFromEnv("BASE_DELAY_MS", 5000);
export const STUCK_TIMEOUT_MS = intFromEnv("STUCK_TIMEOUT_MS", 60000);
export const BACKOFF_JITTER_FRACTION = 0.3;