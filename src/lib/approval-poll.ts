/**
 * Shared browser-approval poll loop.
 *
 * The create→approve→poll shape used by both:
 *   - CP login (`login()` in auth.ts) — poll the CP for a session token + pod,
 *     gated by a pollSecret Bearer header.
 *   - Pod agent-key approval (`provisionAgentKey` in targets.ts) — poll the pod
 *     for key activation, gated by the human API key.
 *
 * No localhost server, no redirect back to the CLI — the browser only APPROVES
 * a pending record; the CLI holds a secret and polls for the outcome. Every
 * failure resolves to a clean rejected/timeout instead of a dead browser tab.
 */

export interface PollForApprovalOptions<T> {
  /** Endpoint to GET each tick. */
  url: string;
  /** Auth/other headers sent on every poll (e.g. Bearer pollSecret). */
  headers?: Record<string, string>;
  /** Delay between polls. Default 2000ms. */
  intervalMs?: number;
  /** Overall deadline. Default 120_000ms. */
  timeoutMs?: number;
  /** Per-request timeout. Default 30_000ms. */
  requestTimeoutMs?: number;
  /** True when the parsed response means "approved / done". */
  isApproved: (data: unknown) => boolean;
  /** True when the parsed response means "rejected / denied". */
  isRejected: (data: unknown) => boolean;
  /** Extract the result from an approved response. */
  onApproved: (data: unknown) => T;
  /** Error thrown when isRejected fires. */
  rejectedError?: string;
  /** Error thrown when the deadline elapses. */
  timeoutError?: string;
}

/**
 * Poll `url` until the response is approved (→ resolve with `onApproved`),
 * rejected (→ throw `rejectedError`), or the deadline elapses (→ throw
 * `timeoutError`). Transient network errors and non-2xx responses are ignored
 * and simply retried until the deadline.
 */
export async function pollForApproval<T>(
  opts: PollForApprovalOptions<T>,
): Promise<T> {
  const intervalMs = opts.intervalMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));

    let res: Response;
    try {
      res = await fetch(opts.url, {
        headers: opts.headers,
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      continue; // network blip — retry
    }
    if (!res.ok) continue; // transient (throttle/5xx) — retry

    const data = (await res.json().catch(() => null)) as unknown;
    if (data === null) continue;

    if (opts.isRejected(data)) {
      throw new Error(opts.rejectedError ?? "Request was rejected.");
    }
    if (opts.isApproved(data)) {
      return opts.onApproved(data);
    }
    // still pending — loop
  }

  throw new Error(opts.timeoutError ?? "Timed out waiting for approval.");
}
