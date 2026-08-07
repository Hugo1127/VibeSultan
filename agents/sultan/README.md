# Sultan Agent

《苏丹的游戏》TypeScript Agent，通过 Sultan Observer HTTP 接口读状态、提交动作，并接入 `@vibesultan/agent-learning-core` 做跨局记忆与实验队列。

## 前置

1. 复制 `env/.env.example` → `env/.env`，配置 `OPENAI_API_KEY` 等
2. 启动游戏并加载 `plugins/SultanObserver`（默认 `GAME_BASE_URL=http://127.0.0.1:17890`）
3. 在仓库根目录执行 `npm install`

## 命令

```bash
# 构建
npm run build -w @vibesultan/sultan-agent

# 单局
npm run start -w @vibesultan/sultan-agent

# 自动探索 + 复盘 + 验证队列
npm run autoplay -w @vibesultan/sultan-agent

# 录制一次人工操作供AI分析&学习（回到终端按 Enter 停止）
npm run record -w @vibesultan/sultan-agent

# 离线校验
npm run verify:http-contract -w @vibesultan/sultan-agent
npm run verify:learning -w @vibesultan/sultan-agent
npm run verify:entity-memory -w @vibesultan/sultan-agent
npm run verify:episode-tracker -w @vibesultan/sultan-agent
npm run verify:entity-enrichment -w @vibesultan/sultan-agent
npm run verify:day-boundary -w @vibesultan/sultan-agent
npm run verify:strategy -w @vibesultan/sultan-agent
npm run verify:action-chain -w @vibesultan/sultan-agent
npm run verify:minimal-loop:mock -w @vibesultan/sultan-agent
```

## 行动链

Agent 使用固定的日流程约束（行动链）：开局加点 → 抽苏丹卡 → 今日消息 → 手牌盘点 → 地图检查 → Top3 规划 → 卡牌分配与局部优化 → 过天。详见 [docs/games/sultan/action-chain.md](../../docs/games/sultan/action-chain.md)。

人类向机制攻略见 [docs/games/sultan/strategy-guide.md](../../docs/games/sultan/strategy-guide.md)（不整包灌入 prompt）。

## Autoplay 记忆会话

```bash
npm run autoplay -w @vibesultan/sultan-agent -- --fresh [name]
npm run autoplay -w @vibesultan/sultan-agent -- --memory <session-id>
npm run autoplay -w @vibesultan/sultan-agent -- --list
```

会话数据写入 `agents/sultan/memory/sessions/<id>/`：

- `experiences.json`：逐动作原始证据。
- `cards.json`：按 `configFingerprint:card:cardId` 聚合的卡牌知识。
- `events.json`：地图仪式和剧情选项事件知识。
- `interactions.json`：卡牌 × 事件 × 槽位/选项的组合经验。
- `pending-episodes.json`：跨 `place → execute → rite_result` 的待结算仪式链。
- `enrichment-queue.jsonl`：后台 soft-fact 富化任务队列。
- `fingerprint-aliases.json`：冷启动 fingerprint → 完整 catalog fingerprint 映射。
- `hypotheses.json` / `tips.json`：跨实体宏观策略。

实体知识由 `observed → provisional → validated` 晋升；冲突证据会降低置信度或标为
`contradicted`。`uid` 仅用于当前局交互，跨局匹配只使用 `cardId`、`riteId` 或剧情事件
内容身份。旧会话打开时会惰性创建实体文件，并从 `experiences.json` 回填不带推断的实体骨架。

卡牌 `rare=1/2/3/4` 分别显示为石/铜/银/金。打开仪式后，事件记忆会保留槽位门槛以及
内置/预置占位卡（例如【权力的游戏】中的【苏丹｜金(4)】），并同步建立对应卡牌实体。
分配器用软评分优先同阶匹配、让低阶人物承担日常跑腿；合法向下兼容不会被硬拦截。
【金币】和金骰等通货按数量成本处理，不因 `rare=4` 被误当作应珍藏的战略金卡。

跨日结算或同日流程中新出现的卡会写入行动链 `newCards`。若该 `cardId` 尚无可靠说明或仍有
`usage_unknown`，它会进入 `mustInspect`；只有成功的 `inspect_card` 且 Observer 返回可靠
`cardSummary` 后才解除 `hand_review` 门禁。模型通过 `report_action_chain` 自报 reviewed /
inspected 不能绕过该门禁；已掌握的同类卡即使换了运行时 `uid`，仍按稳定 `cardId` 复用知识。

仪式结果采用异步 episode 结算：主循环只做确定性证据写入，不阻塞等待 LLM。骰点检定可当场
结算；剧情类仪式在 `execute` 时冻结输入组合，并在过天后用卡牌变化（硬证据）与计数器/资源
（辅助）跨天验证。有卡输入且次日未获猜忌等惩罚卡，记为正样本；结算同时回写
`events` / `interactions` / `cards` 的 sample 与 usages。`place_card` 也会给卡牌留下
awaiting evidence。后台 Enrichment Worker（默认单并发）只更新 usages / bestPractices 等语义
字段，不改 sampleCount。相关开关见 `env/.env.example` 的 `AGENT_ENTITY_ENRICH_*` 与
`AGENT_EPISODE_TTL_STEPS`。

历史会话可审计回填（默认 dry-run）：

```bash
npm run backfill:entity-outcomes -w @vibesultan/sultan-agent -- --memory <session-id>
npm run backfill:entity-outcomes -w @vibesultan/sultan-agent -- --apply --memory <session-id>
```

Agent 在 `hand_review`、`map_review` 和分配阶段，仅按当前手牌与事件检索 Top-K 相关知识。
已验证记录可参与 Planner 的低优先级加权；生存、期限与合法性硬约束始终优先。

## 日志

运行日志在 `agents/sultan/logs/runs/<timestamp>/`（events.jsonl、messages.json、decision-traces.jsonl）。

## 人工操作录制

录制用于定位真实游戏调用链、指导 Observer/Agent 开发，方便 debug Agent/Plugin 没有覆盖到的游戏操作，或提供给AI学习操作流程。运行 `npm run record -w @vibesultan/sultan-agent`，在游戏中完成一次操作，然后回到终端按 Enter。文件保存在游戏目录的 `BepInEx/recordings/sultan/`。

HTTP 接口：`POST /record/start`、`GET /record/status`、`POST /record/stop`、`GET /record/latest`。
