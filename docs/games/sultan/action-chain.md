# Sultan Agent 行动链（Action Chain）

> 日期：2026-07-26  
> 适用范围：`agents/sultan` 宏观日流程编排；不替代实时 `observe_scene` / enabled affordances。

## 目标

把“正式进入游戏后的尤文步骤”固定成可观测、可中断、按日重置的阶段约束，使 AI 以类似思维链的方式稳定推进，同时强制利用可复用正收益卡牌，并允许在过天前反复调整到局部最优。

## 阶段顺序

1. **entry_setup**：开局难度/加点/剧情选项
2. **sudan_draw**：抽取苏丹卡（正式进入每日循环）
3. **daily_news**：仅处理已弹出的 StoryNotify 今日消息；无弹层则跳过。**不要**打开「一千零一夜」故事书 / 成就面板（`StoryEntry` / `QuestEnter`）
4. **hand_review**：盘点手牌；未知用途 → `inspect_card`（查摘要）；书籍/苏丹卡/情报等 → `think_card`（拖进俺寻思发现事件）；需要属性加成时可 `equip_item` / `unequip_item`（读角色 `equipSlotTypes` / `equipped[]`，执行 `semantic:equip_*`）
5. **map_review**：逐个 `open_rite` 检查地图点变化；**`think_card` 新生点 / 新苏丹卡 / 新 event 触发 `sudan_route_probe`（advisory）**——打开 event 后读取合法 `place_card_on_rite` affordance（不提交即可写入 `sudan-routes.json`）。忽略临时仪式「俺寻思」(`id=5000002`)。已占槽直接读 `cardSummary`。`mapChanges` **优先展示 `added:`**
6. **synthesis**：汇总并提交 Top3（含路线覆盖 / 换卡预算）
7. **allocation**：按滚动苏丹策略准备/试验/提交销卡路线，并分配其它卡牌（同点可多卡）；必要时先换装再放人
8. **local_improve**：移动 / 交换 / 增配 / 换装 / `open_sudan_box`+`exchange_sudan_card` / `prev_round` / `reset` 重配
9. **end_day_gate**：完成局部优化后，宿主做 **日终分配快速检定**，通过后再显式 **`next_day`** 过天
10. 回到 **daily_news**

装备换装是可选收益优化，**不是**强制过天门禁。同类槽已占用必须先 `unequip_item` 再 `equip_item`；仪式面板打开时禁止装备。穿戴关系以运行时 `equipped[]` 为准，不要用物品静态 `tags.已装备` 推断归属。加成看 `equipped[].attrBonus` / 角色 `equipBonus`（及 `equipped[].text`）。

`continue` 只确认/关闭当前浮层（prompt / rite_result / guide 等）；主界面无浮层时 `continue` 无效。过天必须显式 `next_day`（`next_round` 同义）。

引导、阻塞弹层、异步结算、终局可随时打断当前阶段。

失败终局（`terminal` 且非胜利）**不要**结束 Agent：优先 `prev_round` 回退上一天重试销卡；若无法回退或回退后仍无解，则 `start_new_game` 重开。只有胜利结局、或既不能回退也不能重开时才停止。

仪式结果 / 骰子页（`phase=rite_result`）也是阻塞打断：读 `values.riteResult.tip` / `needTags` / `goldDiceAvailable`；`continue` 优先点空白/面板根推进（与人手点画面一致），再点正文；`stage=result_page` 时还会回退调用面板 `OnNext/Close`，避免正文 `Button.onClick` 假成功导致卡死。在 `gold_select` 点空白跳过金骰，或在 Next 就绪后推进，**不会**自动花金骰。金骰可选：默认跳过；仅门槛需要时用 `select_gold_dice` → `confirm_gold_dice`（可用 `cancel_gold_dice` 取消）。

## 每日记忆节奏（约 60 天总局长）

默认 `AGENT_REVIEW_INTERVAL_DAYS=1`：**每一游戏日**都写 experiences / `day-evidence.jsonl` / outcome 日行，并做轻量复盘。  
有活跃假设时优先结算与累积 tip 证据；topic 含 early_explore / map_scout_added / rite_efficiency / execution_timing / tier_match / sudan_pressure 等，并由 validated 实体蒸馏 tip（不占 hyp 单槽）。  
跨局慢环可将 `validated` 假设压成 `skills/best_skill.md` 注入。

### 续跑同一 memory session

评审与清洗后的主 session：`20260726-210553`。

```bash
npm run autoplay -- --memory-session 20260726-210553
# 或
npm run start -- --memory-session 20260726-210553
```

清洗（先 dry-run，再 `--apply`）：

```bash
npm run scrub:session-memory -- --session 20260726-210553
npm run scrub:session-memory -- --session 20260726-210553 --apply
```

备份目录形如 `memory/sessions/_backup-20260726-210553-<timestamp>/`。

## 卡牌与事件实体记忆

行动级 `experiences.json` 保留原始证据；实体层把重复遭遇聚合到：

- `cards.json`：稳定 `cardId` 对应的说明、用途、反模式与未知项；
- `events.json`：地图仪式/剧情选项的槽位、路线与失败方式；
- `interactions.json`：卡牌 × 事件 × 槽位/选项的条件化结果；
- `pending-episodes.json`：把 `place_card → execute → rite_result → continue` 串成同一归因链。

首次看到稳定实体时建档，之后只更新同一 key。地图实例 `uid` 不跨局复用。放置时先记
`inconclusive`。仪式经验按「输入组合 → 反馈」归因：`execute` 时冻结槽位输入（含空槽）；
骰点检定可当场结算；剧情类仪式（如权力的游戏）进入跨天验证，次日用卡牌变化（猜忌卡/
赏赐卡等硬证据）与计数器/资源辅助信号共同判定。有输入且次日未获惩罚卡，记为正反馈
（对应「上朝压猜忌」）；空槽导致猜忌卡记为负反馈。结算同时写入 event / interaction /
card 的 sample 与 usages。Choice 点击成功不等于策略收益为正。

后台 Enrichment Worker 异步整理 usages / best practices 等 soft facts，主 Agent 不等待；
失败不影响对局。冷启动与完整 catalog 的 `configFingerprint` 通过 `fingerprint-aliases.json`
互认，避免同卡分裂。可用 `scripts/backfill-entity-outcomes.ts` 对旧会话做 dry-run 回填。

在 `hand_review`、`map_review`、`synthesis`、`allocation`、`local_improve` 阶段，宿主按当前
手牌与地图检索 Top-K 实体知识并增量注入；摘要不变时不重复发送。`provisional/observed`
仅作探索线索，`contradicted` 不参与评分。Planner 的实体加权位于生存、处刑期限、合法性和
卡牌利用硬约束之后。

品阶是分配核心信号：`rare=1/2/3/4` 映射石/铜/银/金。map review 必须读取槽位门槛和
内置/预置卡的 `cardSummary`（如【权力的游戏】里的【苏丹｜金(4)】）。其中 `tags` 是按键稳定排序、
仅保留非零值的运行时属性/身份标签；allocation 优先
同阶匹配，低阶人物承担跑腿日常，高阶卡向下兼容仅作软惩罚。金币/金骰等通货不走战略品阶
珍藏规则，仍按 `costMin` 使用最小数量。

宿主按稳定 `cardId` 跟踪已见卡牌，并在跨日结算或同日流程获得新类型时将其列入 `newCards`。
没有可靠 `description` 或仍含 `usage_unknown` 的手牌会进入 `mustInspect`。这类卡必须执行
成功的 `inspect_card`，且刷新后的 scene/result 中存在卡牌专属 `cardSummary`，才能完成
`hand_review`；失败、空详情、HUD 文本以及 `report_action_chain` 自报均不能解除门禁。
同类型卡仅更换运行时 `uid` 时复用既有知识，不重复强制检查。

## 优先级

1. 终局 / 阻塞流 / 引导  
2. 生存与硬期限  
3. 当前行动链阶段  
4. 策略引擎候选（仅在 synthesis/allocation/local_improve/end_day_gate）

## 结构化报告

工具：`report_action_chain`

必填语义：

- `newsChecked` / `newsPresent` / `newsSummary`
- `top3`（最多 3 项）
- `reviewedCardUids` / `inspectedCardUids`
- `reviewedRiteUids`
- `allocations[]`：`{ cardUid, riteUid, slotIndex, why? }`
- `idleCards[]`：未分配卡必须给 `reserved` 或 `no_positive_slot`
- `localImproveDone`
- `sudanBreakDone`（处刑最后一天销卡完成后设为 true）

所有 UID 必须来自最新 state/scene。

## 卡牌利用约束

- **必须安排**：当前可用、非一次性、且存在**已验证**合法正收益槽位的卡（来自 map_review 打开仪式时缓存的 `place_card_on_rite` affordance）
- 典型持续收益：【治理家业】（金币）、【权力的游戏】（抑制怀疑）
- **可保留**：一次性/稀有消耗、为硬期限或关键剧情预留的卡（需写明原因）
- **堆叠拆分**：【金币】等 item 可拆分。槽位 `cost.金币:1` / text「置入1金币」时只放 1；`place_card_on_rite` 可读 `costMin` 或传 `count`。插件会调用 `CardSplit` 自动按 cost 拆分，禁止整堆塞入导致其他仪式无金币

## 处刑日滚动策略

苏丹卡带处刑倒计时（`executionDaysLeft`，由 `day` 与 `sudan.initLife` 推导）。**不再**使用固定「提前销卡 -18/-12/-8」惩罚。

| 剩余天数 | policy | 策略 |
|---------|--------|------|
| `> 2`（通常 7–3） | `discover_routes` / `accumulate_prepare` | 探测全部可见 event 的兼容路线；积累资源与前置。路线稳定且不过期时可继续准备；即将过期的优质机会可提前执行 |
| `= 2` | `branch_test` | 试验非支配分支（最佳/次优路线、随机换卡）；相同 anchor+action 签名只试一次；最多约 5 个候选 |
| `= 1` | `commit_best` | 执行已验证最佳分支 |
| `<= 0` | `emergency` | 必须先销卡；简单模式可 `prev_round` 回退重试 |

换卡：`open_sudan_box` 打开左上角卡盒 → `exchange_sudan_card`（精确点击「交换手上的苏丹卡」，禁止「再来一张」）。`redrawRemaining = redrawPerRound - redrawTimes`；**换卡不重置倒计时**。

回退：`prev_round` 整局状态回档，但灵视 `counters["7100005"]` +1。灵视作轻度机会成本，不硬限制回退。试验证据写入 `sudan-branches.json`；`rewound` 分支不污染 canonical experience/entity/episode。

报告字段：`sudanBreakDone=true` 表示当日已完成销卡。路线账本：`sudan-routes.json`；分支账本：`sudan-branches.json`。

## 局部优化邻域

以完整可行方案为起点，有界迭代：

1. 空槽增配  
2. 单卡移动到其他槽位  
3. 两卡交换  
4. 撤销低价值分配后重配  

仅接受分层评分严格改善且不破坏硬约束的方案。实际执行仍单步进行，动作后重观察并允许 `reset`。

## 地图变化判定

比较相邻两日（或检查前后）地图点签名：

- `riteUid` 新增 / 消失
- `life` / `started` / `slotsFilled` / 槽位占用签名变化

变化会写入行动链 brief 的 `mapChanges`。

## 日终分配快速检定（Day-Close Review）

在 Agent 提交显式 `next_day` **之前**，宿主用确定性规划器做快速检定（`planner/dayCloseReview.ts`）：

```
map_review 打开事件 → 缓存合法放置候选（当日账本）
→ 对账实际分配 / 清理 reset 陈旧记录
→ 跨事件 beam + local search 对比当前 vs 最佳已知方案
→ next_day 前检定 → 调整或 override → 插件 next_day
```

| 等级 | 条件 | 行为 |
|------|------|------|
| **硬问题** | 可复用余牌有已验证正收益槽；分配漂移/陈旧 | 拒绝 `next_day`，返回 `day_close_hard_issue` + 建议首步 |
| **软改进 / advisory** | 评分可提升；苏丹路线未探测完；末日可销未销；换卡机会 | 返回建议；**不硬拦** `next_day`（末日警告级别最高仍可显式过天） |
| **放行** | 无硬问题且无待处理软改进（或已 override） | 调用独立插件 `next_day` |

证据不完整（未打开全部仪式）时降低置信度，不把推测升级为硬拒。`localImproveDone` / `sudan_route_probe` 仅为流程提示。  
禁止 `click_element` 映射到 `next_day` 绕过检定（返回 `use_explicit_next_day`）。

评分词典序：生存/期限 → 路线可行性与最晚启动 → 即将过期销卡机会 → 已验证收益/代价 → 路线准备度 → 灵视增量（轻度负）→ 持续收益 → 品阶匹配 → 利用率/普通资源 → 机会成本。

## 过天条件

过天**只**通过显式 `next_day`（或同义 `next_round`）：

- 插件：`phase=play`、无硬遮罩、无引导、无打开的仪式面板（物理门禁）
- Agent：日终分配快速检定（上节）；行动链 checklist（消息/手牌/地图/Top3/利用率自报）仍为流程建议

`continue` 永不表示过天；无浮层时返回 `nothing_to_continue`。

## 相关文件

- Controller: `agents/sultan/src/agent/actionChain.ts`
- Loop 注入: `agents/sultan/src/agent/loop.ts`
- Tools: `agents/sultan/src/agent/tools.ts`
- Sudan routes: `agents/sultan/src/memory/sudanRouteStore.ts`
- Sudan branches: `agents/sultan/src/memory/sudanBranchStore.ts`
- Day-close review: `agents/sultan/src/planner/dayCloseReview.ts`
- Planner: `agents/sultan/src/planner/*`
- Observer: `open_sudan_box` / `exchange_sudan_card` / `dailyNews` / `open_daily_news` / `inspect_card` / `think_card`
- 人类攻略（不灌入 prompt）: [strategy-guide.md](./strategy-guide.md)
