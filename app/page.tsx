"use client";

import { useState } from "react";
import Link from "next/link";

export default function Home() {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("job-queue test email");
  const [body, setBody] = useState("Sent by the job-queue worker.");
  const [userId, setUserId] = useState("user-1");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [result, setResult] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    const res = await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: idempotencyKey || `demo-${Date.now()}`,
        type: "email",
        userId,
        payload: { to, subject, body },
      }),
    });
    const data = await res.json();
    setResult(JSON.stringify({ status: res.status, ...data }, null, 2));
  }

  return (
    <main style={{ padding: 24, fontFamily: "system-ui, sans-serif", maxWidth: 640 }}>
      <h1>job-queue — trigger</h1>
      <p>
        Enqueues a background email job. The API returns{" "}
        <code>202 Accepted</code> immediately; the worker actually sends it.
      </p>

      <form onSubmit={submit} style={{ display: "grid", gap: 8 }}>
        <label>
          to
          <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="recipient@example.com" required style={{ display: "block", width: "100%" }} />
        </label>
        <label>
          subject
          <input value={subject} onChange={(e) => setSubject(e.target.value)} required style={{ display: "block", width: "100%" }} />
        </label>
        <label>
          body
          <textarea value={body} onChange={(e) => setBody(e.target.value)} required style={{ display: "block", width: "100%" }} />
        </label>
        <label>
          userId
          <input value={userId} onChange={(e) => setUserId(e.target.value)} style={{ display: "block", width: "100%" }} />
        </label>
        <label>
          idempotencyKey (same key twice = same job, never a duplicate)
          <input value={idempotencyKey} onChange={(e) => setIdempotencyKey(e.target.value)} placeholder="auto-generated if empty" style={{ display: "block", width: "100%" }} />
        </label>
        <button type="submit">enqueue job</button>
      </form>

      {result && <pre style={{ background: "#f2f2f2", padding: 12 }}>{result}</pre>}
      <p>
        <Link href="/dead-letter">dead-letter view</Link>
      </p>
    </main>
  );
}