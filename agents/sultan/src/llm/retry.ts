/** HTTP statuses that will not succeed on retry. */
const NON_RETRYABLE = new Set([401, 403]);

export function isRetryableHttpStatus(status: number): boolean {
  if (!Number.isFinite(status) || status < 400) {
    return false;
  }
  if (NON_RETRYABLE.has(status)) {
    return false;
  }
  return true;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logRetry(data: Record<string, unknown>): void {
  const line = `[${new Date().toISOString()}] WARN llm_retry ${JSON.stringify(data)}`;
  console.warn(line);
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

export function createRetryFetch(opts: {
  maxRetries: number;
  intervalSec: number;
  requestTimeoutMs: number;
  baseFetch?: typeof fetch;
}): typeof fetch {
  const maxRetries = Math.max(0, Math.floor(opts.maxRetries));
  const intervalMs = Math.max(0, opts.intervalSec) * 1000;
  const requestTimeoutMs = Math.max(1, Math.floor(opts.requestTimeoutMs));
  const baseFetch = opts.baseFetch ?? globalThis.fetch;

  return async (input, init) => {
    let lastNetworkError: unknown;
    const externalSignal = init?.signal;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (externalSignal?.aborted) {
        const abortErr = new Error("The operation was aborted.");
        abortErr.name = "AbortError";
        throw abortErr;
      }

      const attemptController = new AbortController();
      const onExternalAbort = () => attemptController.abort();
      externalSignal?.addEventListener("abort", onExternalAbort);

      const timeoutId = setTimeout(() => {
        attemptController.abort();
      }, requestTimeoutMs);

      try {
        const res = await baseFetch(input, {
          ...init,
          signal: attemptController.signal,
        });
        if (!isRetryableHttpStatus(res.status) || attempt >= maxRetries) {
          return res;
        }

        await res.arrayBuffer().catch(() => undefined);

        logRetry({
          attempt: attempt + 1,
          maxRetries,
          status: res.status,
          waitSec: opts.intervalSec,
        });
        await sleep(intervalMs);
      } catch (err) {
        lastNetworkError = err;

        if (externalSignal?.aborted) {
          throw err;
        }

        const timedOut = isAbortError(err) && attemptController.signal.aborted;
        if ((!timedOut && isAbortError(err)) || attempt >= maxRetries) {
          throw err;
        }

        logRetry({
          attempt: attempt + 1,
          maxRetries,
          ...(timedOut
            ? { timeoutMs: requestTimeoutMs }
            : {
                networkError: err instanceof Error ? err.message : String(err),
              }),
          waitSec: opts.intervalSec,
        });
        await sleep(intervalMs);
      } finally {
        clearTimeout(timeoutId);
        externalSignal?.removeEventListener("abort", onExternalAbort);
      }
    }

    throw lastNetworkError ?? new Error("LLM retry exhausted");
  };
}

export function llmRetryBudgetMs(opts: {
  requestTimeoutMs: number;
  maxRetries: number;
  intervalSec: number;
}): number {
  const perAttempt = Math.max(1_000, opts.requestTimeoutMs);
  const retries = Math.max(0, Math.floor(opts.maxRetries));
  const intervalMs = Math.max(0, opts.intervalSec) * 1000;
  return (retries + 1) * perAttempt + retries * intervalMs;
}
