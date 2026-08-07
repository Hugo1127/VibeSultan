import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSystemPrompt, MORAL_AXIOM_BLOCK, SYSTEM_PROMPT_BASE } from "../src/agent/systemPrompt.js";
import type { CardFeature, StrategySnapshot } from "../src/game/strategyTypes.js";
import {
  formatChoiceRecommendation,
  hasPersonCue,
  isAltruisticChoiceLabel,
  isAltruisticOption,
  keywordsAreInconclusive,
  recommendChoiceOption,
  scoreChoiceOptionLabel,
  shouldDeferChoiceAsStrategic,
} from "../src/moral/choiceHeuristics.js";
import {
  ensureChoiceAltruismResolved,
  parseAltruismClassification,
} from "../src/moral/choiceAltruismClassify.js";
import { scoreSocialCapital } from "../src/moral/keyFollowers.js";
import {
  scoreStrategicSettlement,
  type EpisodeStateSnapshot,
} from "../src/memory/episodeOutcome.js";
import { createSultanEntityStores } from "../src/memory/entityMemory.js";
import { scorePlanVector } from "../src/planner/scorer.js";
import { isHostSideActionError } from "../src/memory/hostActionErrors.js";
import { SUDAN_BREAK_DEFERRED_ERROR } from "../src/planner/executionTiming.js";

function emptySnapshot(cards: CardFeature[] = []): StrategySnapshot {
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    day: 1,
    turn: 1,
    phase: "play",
    terminal: false,
    executionDaysLeft: 5,
    resources: {},
    counters: {},
    cards,
    events: [],
    deadlines: [],
    enabledOps: ["next_day", "open_rite"],
    unknowns: [],
    version: { gameFingerprint: "test", configFingerprint: "test" },
  };
}

function testSocialCapitalClamp(): void {
  const none = scoreSocialCapital([]);
  assert.equal(none.score, 0);

  const nefel: CardFeature[] = [
    { cardId: 2000312, name: "奈费勒", rare: 3, type: "char", tags: ["反对:3"] },
  ];
  assert.equal(scoreSocialCapital(nefel).score, 2);

  const both: CardFeature[] = [
    { cardId: 2000006, name: "梅姬", rare: 2, type: "char", tags: ["adherent:1", "支持:1"] },
    { cardId: 2000312, name: "奈费勒", rare: 3, type: "char" },
    { cardId: 999, name: "鲁梅拉", rare: 1, type: "char" },
  ];
  const detail = scoreSocialCapital(both);
  assert.equal(detail.score, 2);
  assert.ok(detail.followers.length >= 2);
}

function testScorerFlag(): void {
  const cards: CardFeature[] = [
    { cardId: 2000312, name: "奈费勒", rare: 3, type: "char", inHand: true },
  ];
  const snapshot = emptySnapshot(cards);
  const off = scorePlanVector({
    snapshot,
    configurations: [],
    experiences: [],
    socialCapitalEnabled: false,
  });
  const on = scorePlanVector({
    snapshot,
    configurations: [],
    experiences: [],
    socialCapitalEnabled: true,
  });
  assert.equal(off.length, 10, "flag off keeps legacy 10-dim vector");
  assert.equal(on.length, 11, "flag on inserts social capital dim");
  assert.equal(on[4], 2, "social capital sits at index 4");
  assert.deepEqual(off.slice(0, 4), on.slice(0, 4));
  assert.deepEqual(off.slice(4), on.slice(5));
}

function testAxiomPrompt(): void {
  const off = buildSystemPrompt(false);
  const on = buildSystemPrompt(true);
  assert.equal(off, SYSTEM_PROMPT_BASE);
  assert.ok(!off.includes("终局 Boss"));
  assert.ok(on.includes(MORAL_AXIOM_BLOCK));
  assert.ok(on.includes("终局 Boss"));
  assert.ok(on.includes("sudan_break_deferred") || SYSTEM_PROMPT_BASE.includes("sudan_break_deferred"));
  assert.ok(isHostSideActionError(SUDAN_BREAK_DEFERRED_ERROR));
}

function testChoiceHeuristics(): void {
  assert.ok(isAltruisticChoiceLabel("收留这个乞丐女孩"));
  assert.ok(isAltruisticChoiceLabel("买下她带回府中"));
  assert.ok(!isAltruisticChoiceLabel("拒绝并走开"));
  assert.ok(scoreChoiceOptionLabel({ index: 0, label: "花5金币收留她" }) > 0);
  assert.ok(scoreChoiceOptionLabel({ index: 1, label: "献给苏丹取悦" }) < 0);
  assert.ok(hasPersonCue("把这个女孩带走"));
  assert.ok(
    shouldDeferChoiceAsStrategic(
      { index: 0, label: "给这个女孩一块面包" },
      { immediateNegative: true },
    ),
  );

  const rec = recommendChoiceOption([
    { index: 0, label: "拒绝帮助" },
    { index: 1, label: "收留并帮助她" },
  ]);
  assert.ok(rec);
  assert.equal(rec!.optionIndex, 1);
  const line = formatChoiceRecommendation([
    { index: 0, label: "杀害" },
    { index: 2, label: "结交清流" },
  ]);
  assert.ok(line?.includes("optionIndex=2"));
}

async function testChoiceAltruismClassifyCache(): Promise<void> {
  const ambiguous = [
    { index: 0, label: "把书留给她" },
    { index: 1, label: "独自离开" },
  ];
  assert.ok(keywordsAreInconclusive(ambiguous));

  const parsed = parseAltruismClassification(
    JSON.stringify({
      options: [
        { index: 0, altruismScore: 2, reason: "leave_book" },
        { index: 1, altruismScore: -1, reason: "leave" },
      ],
    }),
    ambiguous,
  );
  assert.ok(parsed);
  assert.equal(parsed![0]!.altruismScore, 2);
  assert.ok(isAltruisticOption(ambiguous[0]!, parsed));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sultan-altruism-"));
  try {
    const stores = createSultanEntityStores(dir);
    const version = { gameFingerprint: "g", configFingerprint: "cfg" };
    const eventKey = "cfg:choice:test_girl";
    let llmCalls = 0;
    const first = await ensureChoiceAltruismResolved({
      stores,
      eventKey,
      version,
      prompt: "路边遇到一个女孩",
      options: ambiguous,
      llmComplete: async () => {
        llmCalls += 1;
        return JSON.stringify({
          options: [
            { index: 0, altruismScore: 2, reason: "help" },
            { index: 1, altruismScore: -1, reason: "ignore" },
          ],
        });
      },
    });
    assert.equal(first.source, "llm");
    assert.equal(llmCalls, 1);
    assert.ok(first.scores);
    assert.ok(formatChoiceRecommendation(ambiguous, first.scores)?.includes("optionIndex=0"));

    const second = await ensureChoiceAltruismResolved({
      stores,
      eventKey,
      version,
      options: ambiguous,
      llmComplete: async () => {
        llmCalls += 1;
        throw new Error("should not call");
      },
    });
    assert.equal(second.source, "cache");
    assert.equal(llmCalls, 1);

    const failed = await ensureChoiceAltruismResolved({
      stores,
      eventKey: "cfg:choice:fail",
      version,
      options: ambiguous,
      llmComplete: async () => {
        throw new Error("boom");
      },
    });
    assert.equal(failed.source, "keyword");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testStrategicSettlement(): void {
  const baseline: EpisodeStateSnapshot = {
    day: 3,
    cardIds: [1],
    cardLabels: ["1:金币|item"],
    resources: { gold: 10 },
    counters: {},
  };
  const pending = scoreStrategicSettlement(
    baseline,
    { ...baseline, day: 5, cardIds: [1], cardLabels: baseline.cardLabels },
    { namePatterns: ["鲁梅拉"] },
    { openedDay: 3, horizonDays: 30 },
  );
  assert.equal(pending.outcome, null);

  const gained = scoreStrategicSettlement(
    baseline,
    {
      day: 10,
      cardIds: [1, 2000999],
      cardLabels: ["1:金币|item", "2000999:鲁梅拉|char"],
      resources: {},
      counters: {},
    },
    { namePatterns: ["鲁梅拉"] },
    { openedDay: 3, horizonDays: 30 },
  );
  assert.equal(gained.outcome, "positive");
  assert.ok(gained.summary.includes("long_term_positive"));

  const timeout = scoreStrategicSettlement(
    baseline,
    { ...baseline, day: 40 },
    { namePatterns: ["鲁梅拉"] },
    { openedDay: 3, horizonDays: 30 },
  );
  assert.equal(timeout.outcome, "inconclusive");
}

async function main(): Promise<void> {
  testSocialCapitalClamp();
  testScorerFlag();
  testAxiomPrompt();
  testChoiceHeuristics();
  await testChoiceAltruismClassifyCache();
  testStrategicSettlement();
  console.log("verify:social-capital OK");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
