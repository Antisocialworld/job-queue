"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function RetryButton({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function retry() {
    setBusy(true);
    try {
      await fetch(`/api/jobs/${encodeURIComponent(jobId)}/retry`, { method: "POST" });
    } finally {
      setBusy(false);
    }
    router.refresh();
  }

  return (
    <button type="button" onClick={retry} disabled={busy}>
      {busy ? "retrying…" : "retry"}
    </button>
  );
}