import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type OpenAI from "openai";
import { EntityEnrichmentWorker } from "../src/agent/backgroundEntityEnrich.js";
import {
  mergeSemanticFacts,
  parseEnrichmentPayload,
} from "../src/memory/entityEnrichment.js";
import { EnrichmentQueue } from "../src/memory/enrichmentQueue.js";
import { createSultanEntityStores } from "../src/memory/entityMemory.js";
import type { AgentLogger } from "../src/log/AgentLogger.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sultan-enrich-"));
}

function mockLog(): AgentLogger {
  return {
    runId: "run-test",
    runDir: tempDir(),
    info() {},
    warn() {},
    error() {},
    nextStep() {
      return 1;
    },
    writeText() {},
  } as unknown as AgentLogger;
}

function testParseAndWhitelist(): void {
  const payload = parseEnrichmentPayload(
    "card",
    '```json\n{"usages":["Govern estate"],"sampleCount":99,"confidence":1}\n```',
  );
  assert.ok(payload);
  assert.deepEqual(payload!.usages, ["Govern estate"]);
  assert.equal("sampleCount" in payload!, false);
  assert.equal("confidence" in payload!, false);

  const merged = mergeSemanticFacts(
    { usages: ["Old"], unknowns: ["usage_unknown"] },
    { usages: ["Govern estate"], unknowns: [] },
  );
  assert.deepEqual(merged.usages, ["Old", "Govern estate"]);
}

async function testQueueDedupRetryAndShutdown(): Promise<void> {
  const dir = tempDir();
  const stores = createSultanEntityStores(dir);
  const version = { gameFingerprint: "g1", configFingerprint: "cfg" };
  const key = "cfg:card:1";
  const touched = stores.cards.touch({
    key,
    kind: "card",
    version,
    facts: { cardId: 1, unknowns: ["usage_unknown"] },
  });

  const queue = new EnrichmentQueue(dir, 10);
  const first = queue.enqueue({
    entityKind: "card",
    key,
    version,
    generation: touched.updatedAt,
    evidenceSnapshot: { facts: touched.facts },
    maxAttempts: 2,
  });
  const second = queue.enqueue({
    entityKind: "card",
    key,
    version,
    generation: touched.updatedAt,
    evidenceSnapshot: { facts: { ...touched.facts, note: "newer" } },
    maxAttempts: 2,
  });
  assert.equal(first.id, second.id);
  assert.equal(queue.stats().pending, 1);

  const claimed = queue.claimNext();
  assert.ok(claimed);
  queue.fail(claimed!.id, "network", true);
  assert.equal(queue.stats().pending, 1);
  const claimed2 = queue.claimNext();
  queue.fail(claimed2!.id, "network", true);
  assert.equal(queue.stats().failed, 1);

  const worker = new EntityEnrichmentWorker({
    client: {} as OpenAI,
    model: "mock",
    stores,
    queue: new EnrichmentQueue(path.join(dir, "q2"), 10),
    log: mockLog(),
    enabled: true,
    timeoutMs: 2000,
    maxAttempts: 2,
    llmComplete: async () =>
      JSON.stringify({
        usages: ["Use in estate"],
        sampleCount: 5,
        confidence: 1,
      }),
  });

  const fresh = stores.cards.get(key, version)!;
  worker.enqueue({
    entityKind: "card",
    key,
    version,
    generation: fresh.updatedAt,
    evidenceSnapshot: { facts: fresh.facts },
  });
  // Allow the single-concurrency worker to finish before soft flush.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const stats = await worker.shutdown(3000);
  assert.equal(stats.done, 1);
  const updated = stores.cards.get(key, version)!;
  assert.deepEqual(updated.facts.usages, ["Use in estate"]);
  assert.equal(updated.sampleCount, fresh.sampleCount);
  assert.equal(updated.confidence, fresh.confidence);
}

async function main(): Promise<void> {
  testParseAndWhitelist();
  await testQueueDedupRetryAndShutdown();
  console.log("verify-entity-enrichment: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
