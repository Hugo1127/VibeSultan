import type OpenAI from "openai";
import { streamChatText } from "../llm/timedChat.js";
import type { AgentLogger } from "../log/AgentLogger.js";
import {
  buildEnrichmentMessages,
  mergeSemanticFacts,
  parseEnrichmentPayload,
} from "../memory/entityEnrichment.js";
import {
  EnrichmentQueue,
  type EnrichmentEntityKind,
  type EnrichmentJob,
  type EnrichmentQueueStats,
} from "../memory/enrichmentQueue.js";
import type { SultanEntityStores } from "../memory/entityMemory.js";
import type { KnowledgeVersionKey } from "@vibesultan/agent-learning-core";

export type EnrichmentLlmComplete = (opts: {
  messages: Array<{ role: "system" | "user"; content: string }>;
  signal?: AbortSignal;
}) => Promise<string>;

export interface EntityEnrichmentWorkerOptions {
  client: OpenAI;
  model: string;
  stores: SultanEntityStores;
  queue: EnrichmentQueue;
  log: AgentLogger;
  enabled?: boolean;
  concurrency?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Test seam / custom transport. Defaults to streamChatText. */
  llmComplete?: EnrichmentLlmComplete;
}

/**
 * Non-blocking single-concurrency enrichment worker.
 * Main loop only enqueues; LLM work never joins the primary chat transcript.
 */
export class EntityEnrichmentWorker {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly stores: SultanEntityStores;
  private readonly queue: EnrichmentQueue;
  private readonly log: AgentLogger;
  private readonly enabled: boolean;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly llmComplete: EnrichmentLlmComplete;
  private accepting = true;
  private inFlight: Promise<void> | null = null;
  private controller: AbortController | null = null;

  constructor(opts: EntityEnrichmentWorkerOptions) {
    this.client = opts.client;
    this.model = opts.model;
    this.stores = opts.stores;
    this.queue = opts.queue;
    this.log = opts.log;
    this.enabled = opts.enabled !== false;
    this.timeoutMs = Math.max(1_000, opts.timeoutMs ?? 60_000);
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 2);
    this.llmComplete =
      opts.llmComplete ??
      (async ({ messages, signal }) => {
        const { text } = await streamChatText({
          client: this.client,
          model: this.model,
          messages,
          signal,
        });
        return text;
      });
  }

  stats(): EnrichmentQueueStats {
    return this.queue.stats();
  }

  enqueue(input: {
    entityKind: EnrichmentEntityKind;
    key: string;
    version: KnowledgeVersionKey;
    generation: string;
    evidenceSnapshot: Record<string, unknown>;
  }): EnrichmentJob | null {
    if (!this.enabled || !this.accepting) return null;
    const job = this.queue.enqueue({
      ...input,
      maxAttempts: this.maxAttempts,
    });
    this.log.info("entity_enrich_queued", {
      jobId: job.id,
      entityKind: job.entityKind,
      key: job.key,
    });
    this.pump();
    return job;
  }

  /** Kick the worker without blocking; safe to call each turn. */
  harvest(): EnrichmentQueueStats {
    this.pump();
    return this.stats();
  }

  async shutdown(flushTimeoutMs: number): Promise<EnrichmentQueueStats> {
    this.accepting = false;
    if (!this.inFlight) {
      this.queue.abortRunning("shutdown");
      return this.stats();
    }
    const timeout = Math.max(0, flushTimeoutMs);
    let timedOut = false;
    await Promise.race([
      this.inFlight,
      new Promise<void>((resolve) => {
        setTimeout(() => {
          timedOut = true;
          this.controller?.abort();
          resolve();
        }, timeout);
      }),
    ]);
    if (timedOut) {
      this.log.warn("entity_enrich_abort", { reason: "flush_timeout", timeoutMs: timeout });
      this.queue.abortRunning("flush_timeout");
    }
    return this.stats();
  }

  private pump(): void {
    if (!this.enabled || this.inFlight) return;
    const job = this.queue.claimNext();
    if (!job) return;
    this.controller = new AbortController();
    this.inFlight = this.runJob(job, this.controller)
      .catch((error) => {
        this.log.warn("entity_enrich_retry", {
          jobId: job.id,
          detail: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.inFlight = null;
        this.controller = null;
        if (this.accepting) this.pump();
      });
  }

  private async runJob(job: EnrichmentJob, controller: AbortController): Promise<void> {
    this.log.info("entity_enrich_start", {
      jobId: job.id,
      entityKind: job.entityKind,
      key: job.key,
      attempt: job.attempts,
    });
    const store = storeFor(this.stores, job.entityKind);
    const record = store.get(job.key, job.version);
    if (!record) {
      this.queue.fail(job.id, "entity_missing", false);
      return;
    }
    if (record.updatedAt !== job.generation) {
      // Stale generation: drop without writing; a newer enqueue may exist.
      this.queue.complete(job.id);
      this.log.info("entity_enrich_done", {
        jobId: job.id,
        skipped: "stale_generation",
      });
      return;
    }

    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const text = await this.llmComplete({
        messages: buildEnrichmentMessages({ job, record }),
        signal: controller.signal,
      });
      const payload = parseEnrichmentPayload(job.entityKind, text);
      if (!payload) {
        const failed = this.queue.fail(job.id, "invalid_json", true);
        if (failed?.status === "failed") {
          this.log.warn("entity_enrich_retry", {
            jobId: job.id,
            detail: "invalid_json_exhausted",
          });
        }
        return;
      }
      const latest = store.get(job.key, job.version);
      if (!latest || latest.updatedAt !== job.generation) {
        this.queue.complete(job.id);
        this.log.info("entity_enrich_done", {
          jobId: job.id,
          skipped: "generation_race",
        });
        return;
      }
      const facts = mergeSemanticFacts(latest.facts, payload);
      store.upsertFacts(job.key, job.version, facts, {
        actor: "entity_enrichment_llm",
        reason: "async_soft_facts",
        runId: latest.lastRunId,
      });
      this.queue.complete(job.id);
      this.log.info("entity_enrich_done", {
        jobId: job.id,
        entityKind: job.entityKind,
        key: job.key,
        fields: Object.keys(payload),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const failed = this.queue.fail(job.id, detail, true);
      this.log.warn("entity_enrich_retry", {
        jobId: job.id,
        detail,
        status: failed?.status,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

function storeFor(
  stores: SultanEntityStores,
  kind: EnrichmentEntityKind,
): SultanEntityStores["cards"] {
  if (kind === "card") return stores.cards;
  if (kind === "event") return stores.events;
  return stores.interactions;
}
