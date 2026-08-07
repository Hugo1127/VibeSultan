/**
 * Fill decision bubbles on a ReplayDocument using LLM + historical HUD style.
 *
 * Usage (recommended on Windows/Git Bash):
 *   npm run annotate-replay -- --id 20260805-204138-848
 *   npm run annotate-replay -- --id 20260805-204138-848 --motive "救还书的少女需要石级奢靡，换卡是为了刷出它"
 *   npm run annotate-replay -- --id 20260805-204138-848 --prompt "用实况解说口吻"
 */
import { config } from "../src/config.js";
import { createLlmClient } from "../src/llm/client.js";
import { annotateReplayDocument } from "../src/replay/annotateBubbles.js";
import { argMotive, argPrompt, resolveReplayFilePath } from "../src/replay/cliArgs.js";
import { readReplayDocument, writeReplayDocument } from "../src/replay/io.js";
import { buildMotiveBrief } from "../src/replay/motiveBrief.js";
import { emptyDecision } from "../src/replay/types.js";

const DEFAULT_PROMPT = [
  "用《苏丹的游戏》实况 Agent 解说口吻写 HUD 气泡。",
  "每步必须服务 EPISODE MOTIVE（事件名、利他约束、目标苏丹卡），讲清 day/换卡次数/回档。",
  "语气像真正跑局时的 decision，不要写调试日志；thinking 一句玩家能懂的话；stats 逼真。",
].join("");

const DEFAULT_MOTIVE_FOR_GIRL = [
  "焦点事件：还书的少女（uid=65, riteId=5002009）。",
  "可用苏丹卡硬通但会伤害少女（利他负向）；完美拯救需要石级（rare=1）奢靡苏丹卡。",
  "本段操作链 open_rite → open_sudan_box → continue → exchange×N → prev_round：",
  "全程为刷出石奢靡；刷不到就回档重试，绝不拿少女换过关。",
].join("");

async function main(): Promise<void> {
  const filePath = resolveReplayFilePath();
  const prompt = argPrompt(process.argv, DEFAULT_PROMPT) ?? DEFAULT_PROMPT;
  const motiveArg = argMotive(process.argv);

  const doc = readReplayDocument(filePath);
  if (doc.steps.length === 0) {
    throw new Error(`Replay has no steps: ${filePath}`);
  }

  // Prefer CLI --motive, else doc.motive, else auto lore (还书的少女 etc.).
  // For this known rite, if auto brief is thin, seed the altruism motive.
  const hasGirlRite = doc.steps.some(
    (s) => s.action.op === "open_rite" && Number(s.action.riteId) === 5002009,
  );
  const motive =
    motiveArg?.trim() ||
    doc.motive?.trim() ||
    (hasGirlRite ? DEFAULT_MOTIVE_FOR_GIRL : undefined) ||
    buildMotiveBrief(doc);

  // Always regenerate bubbles (user re-runs annotate to enrich content).
  for (const step of doc.steps) {
    step.decision = emptyDecision();
  }

  console.log(`Annotating ${doc.steps.length} steps in ${filePath}`);
  console.log(`Motive:\n${motive}`);
  console.log(`Prompt: ${prompt}`);

  const client = createLlmClient(config);
  const annotated = await annotateReplayDocument({
    client,
    model: config.openaiModel,
    doc,
    prompt,
    motive,
    logsRoot: config.agentLogDir,
    onProgress: (index, total, decision) => {
      const tokens = decision.stats?.totalTokens;
      console.log(
        `[${index}/${total}] ${decision.title}` +
          (tokens != null ? ` (tokens≈${tokens})` : ""),
      );
    },
  });

  writeReplayDocument(annotated, filePath);
  console.log(`Wrote annotated replay: ${filePath}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
