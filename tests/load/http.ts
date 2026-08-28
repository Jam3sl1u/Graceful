/**
 * Timed fetch + bounded-concurrency runner for the load-test harness (issue
 * #81). Uses the global `fetch` only — no server-only / Next / Clerk /
 * Supabase imports (see .pipeline/spec.md §2 constraints).
 */

export type RequestOutcome = {
  status: number; // 0 when the request threw / timed out
  durationMs: number;
  classification: "ok" | "rateLimited" | "unauthorized" | "error";
  retryAfter: string | null; // Retry-After header, 429s only
  errorCode: string | null; // parsed `code` from the ApiError JSON body, best effort
};

function classify(status: number): RequestOutcome["classification"] {
  if (status >= 200 && status < 400) return "ok";
  if (status === 429) return "rateLimited";
  if (status === 401 || status === 403) return "unauthorized";
  return "error";
}

export async function timedRequest(
  url: string,
  init: { method: string; token: string | null; timeoutMs: number },
): Promise<RequestOutcome> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), init.timeoutMs);

  const headers: Record<string, string> = {};
  if (init.token) {
    headers.Authorization = `Bearer ${init.token}`;
  }

  const start = performance.now();
  try {
    const response = await fetch(url, { method: init.method, headers, signal: controller.signal });
    const bodyText = await response.text().catch(() => "");
    const durationMs = performance.now() - start;

    let errorCode: string | null = null;
    if (response.status >= 400 && bodyText.length > 0) {
      try {
        const parsed: unknown = JSON.parse(bodyText);
        if (parsed !== null && typeof parsed === "object" && "code" in parsed) {
          const code = (parsed as { code?: unknown }).code;
          if (typeof code === "string") errorCode = code;
        }
      } catch {
        // Best effort — non-JSON body, leave errorCode null.
      }
    }

    return {
      status: response.status,
      durationMs,
      classification: classify(response.status),
      retryAfter: response.status === 429 ? response.headers.get("Retry-After") : null,
      errorCode,
    };
  } catch {
    const durationMs = performance.now() - start;
    return { status: 0, durationMs, classification: "error", retryAfter: null, errorCode: null };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export type ConcurrentOptions = {
  concurrency: number;
  rampUpMs?: number;
  durationMs?: number; // exactly one of durationMs / iterationsPerWorker
  iterationsPerWorker?: number;
  thinkTimeMs?: number; // pacing delay between a worker's iterations (duration mode only)
  now?: () => number; // injectable for tests; defaults to performance.now
  sleep?: (ms: number) => Promise<void>; // injectable for tests
};

/**
 * Runs `task(workerIndex, iteration)` with at most `concurrency` in flight —
 * each of `concurrency` workers runs its own sequential loop, so no more
 * than one request per worker (and therefore never more than `concurrency`
 * total) is ever in flight at once. Ramp-up staggers worker start times
 * evenly across `rampUpMs`. `thinkTimeMs` (duration mode only) paces each
 * worker with a fixed delay between iterations, so `concurrency` in-flight
 * requests doesn't also mean an unbounded steady-state request rate.
 */
export async function runConcurrent<T>(
  task: (workerIndex: number, iteration: number) => Promise<T>,
  options: ConcurrentOptions,
): Promise<T[]> {
  const { concurrency, rampUpMs = 0, durationMs, iterationsPerWorker, thinkTimeMs = 0 } = options;
  const now = options.now ?? (() => performance.now());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  if ((durationMs === undefined) === (iterationsPerWorker === undefined)) {
    throw new Error("runConcurrent requires exactly one of durationMs or iterationsPerWorker");
  }

  const staggerMs = concurrency > 1 && rampUpMs > 0 ? rampUpMs / (concurrency - 1) : 0;
  const results: T[] = [];

  const workers = Array.from({ length: concurrency }, async (_unused, workerIndex) => {
    const delay = staggerMs * workerIndex;
    if (delay > 0) {
      await sleep(delay);
    }

    let iteration = 0;

    if (durationMs !== undefined) {
      const deadline = now() + durationMs;
      while (now() < deadline) {
        const result = await task(workerIndex, iteration);
        results.push(result);
        iteration += 1;
        if (thinkTimeMs > 0) {
          await sleep(thinkTimeMs);
        }
      }
    } else {
      const total = iterationsPerWorker ?? 0;
      while (iteration < total) {
        const result = await task(workerIndex, iteration);
        results.push(result);
        iteration += 1;
      }
    }
  });

  await Promise.all(workers);
  return results;
}
