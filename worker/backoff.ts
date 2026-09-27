import { BASE_DELAY_MS, BACKOFF_JITTER_FRACTION } from "@/config";

export function nextRunAt(attempts: number): Date {
  const exponential = BASE_DELAY_MS * Math.pow(2, attempts);
  const jitter = Math.random() * exponential * BACKOFF_JITTER_FRACTION;
  return new Date(Date.now() + exponential + jitter);
}