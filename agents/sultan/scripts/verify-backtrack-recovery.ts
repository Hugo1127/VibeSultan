import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GameState } from "../src/game/types.js";
import { BacktrackStore, buildFailureSignature } from "../src/memory/backtrackStore.js";
import { buildPathSignature } from "../src/memory/riteComposition.js";
import { buildStrategySnapshot } from "../src/memory/experienceAdapter.js";
import {
  deepenRecoveryTarget,
  maxBacktrackDepth,
  planTerminalRecovery,
  recoveryPlanFromNode,
} from "../src/planner/recoveryPlanner.js";
import { ActionChainController } from "../src/agent/actionChain.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sultan-backtrack-"));
}

function stateAtDay(day: number, terminal = false): GameState {
  return {
    schemaVersion: 1,
    game: "sultan",
    terminal,
    screen: { id: terminal ? "terminal" : "play", phase: terminal ? "terminal" : "play" },
    values: {
      day,
      fingerprint: "cfg-bt",
      sudan: {
        initLife: 7,
        currentCard: { uid: 9, id: 9001, name: "石杀戮" },
      },
      questSummary: terminal ? { success: false, overReason: 1 } : undefined,
    },
    actions: terminal
      ? [
          { id: "prev_round", enabled: true },
          { id: "start_new_game", enabled: true },
        ]
      : [{ id: "prev_round", enabled: true }],
  };
}

function testFailedPathDayIndependent(): void {
  const a = buildPathSignature({
    sudanIdentity: "9001|9|石杀戮",
    routeLabel: "销卡",
    compositionSignature: "cfg:rite:1:s1:P:2001",
  });
  const b = buildPathSignature({
    sudanIdentity: "9001|9|石杀戮",
    routeLabel: "销卡",
    compositionSignature: "cfg:rite:1:s1:P:2001",
  });
  assert.equal(a, b);
  assert.ok(!a.includes("day"));
}

function testPlanAndDeepen(): void {
  const dir = tempDir();
  const store = new BacktrackStore(dir);
  const runId = "r1";
  store.beginRun(runId);
  store.recordAnchor({
    runId,
    day: 4,
    sudanIdentity: "9001|9|石杀戮",
    executedPathSignatures: ["sudan|route:销卡|comp:s1:P:2001"],
  });
  store.recordAnchor({
    runId,
    day: 6,
    sudanIdentity: "9001|9|石杀戮",
    executedPathSignatures: ["other"],
  });

  const snap = buildStrategySnapshot({ state: stateAtDay(8, true) });
  assert.equal(maxBacktrackDepth(snap), 7);

  const plan = planTerminalRecovery({
    store,
    runId,
    state: stateAtDay(8, true),
    snapshot: snap,
    recentPathSignatures: ["sudan|route:销卡|comp:s1:P:2001"],
    terminalReason: "fail",
    prevRoundEnabled: true,
  });
  assert.equal(plan.targetDay, 4);
  assert.equal(plan.nextAction, "prev_round");
  assert.ok(plan.failedPathSignatures.includes("sudan|route:销卡|comp:s1:P:2001"));

  // Same failure signature deepens.
  const again = planTerminalRecovery({
    store,
    runId,
    state: stateAtDay(8, true),
    snapshot: snap,
    recentPathSignatures: ["sudan|route:销卡|comp:s1:P:2001"],
    terminalReason: "fail",
    prevRoundEnabled: true,
  });
  assert.ok(again.depth >= 4);

  const failure = store.activeFailure(runId)!;
  const deepened = deepenRecoveryTarget({
    store,
    runId,
    failure,
    currentDay: 4,
    snapshot: snap,
  });
  assert.ok(deepened.targetDay <= 4);
  assert.ok(deepened.depth >= failure.depth);

  const atTarget = recoveryPlanFromNode(store.activeFailure(runId)!, {
    currentDay: store.activeFailure(runId)!.targetDay,
    prevRoundEnabled: true,
    maxDepth: 7,
  });
  assert.equal(atTarget.nextAction, "try_sibling");
}

function testRecoveryPhaseAndDayDecrementSimulation(): void {
  const dir = tempDir();
  const chain = new ActionChainController({ memoryDir: dir });
  chain.setRecoveryPlan({
    targetDay: 4,
    depth: 4,
    failedPathSignatures: ["path:a"],
    hint: "rewind to 4",
  });
  let brief = chain.observe(stateAtDay(8), null);
  assert.equal(brief.phase, "recovery_rewind");
  assert.ok(brief.allowedOps.includes("prev_round"));

  // Simulate stepping days down.
  let day = 8;
  while (day > 4) {
    day -= 1;
    brief = chain.observe(stateAtDay(day), null);
  }
  assert.equal(day, 4);
  // On target day recovery clears and normal phase resumes.
  assert.notEqual(brief.phase, "recovery_rewind");

  const failureSig = buildFailureSignature({
    sudanIdentity: "9001|9|石杀戮",
    pathSignatures: ["path:a"],
    terminalReason: "fail",
  });
  assert.ok(failureSig.includes("path:a"));
}

testFailedPathDayIndependent();
testPlanAndDeepen();
testRecoveryPhaseAndDayDecrementSimulation();
console.log("verify-backtrack-recovery: ok");
