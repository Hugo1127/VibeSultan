# VibeSultan

![cover](./assets/images/cover.jpg)

如果AI拥有良知, 能在《苏丹的游戏》（Sultan's Game）中活下来吗?

**注意：项目处于早期迁移阶段，有 Bug 请随意 issue！**

---

核心分三层：

1. **Sultan Agent（TypeScript）**：调用大模型，通过 Observer API 观察卡牌/仪式/事件，下发操作，并在多局之间积累可验证的策略记忆。
2. **Sultan Observer（BepInEx 6 IL2CPP 插件）**：挂在游戏进程内，读取状态、执行动作，通过本机 HTTP 暴露给外部程序。
3. **agent-learning-core（workspace package）**：游戏无关的记忆、实验、验证与经验迭代库，供后续其它游戏 Agent 复用。

```text
┌──────────────────────┐       HTTP 127.0.0.1:17890       ┌──────────────────────┐
│  Sultan's Game.exe   │◄────────────────────────────────►│  agents/sultan       │
│  └─ BepInEx 6 IL2CPP │   GET /state  ·  POST /actions   │  (LLM Agent)         │
│      └─ Observer     │   GET /health ·  decision HUD    │         │            │
└──────────────────────┘                                  └─────────┼────────────┘
                                                                    ▼
                                                         packages/agent-learning-core
```

### 良知框架（Social Capital / Moral Alignment）

在 Agent 层我们加了一套**可开关的良知框架**（`AGENT_SOCIAL_CAPITAL_ENABLED`，默认开启）：不只追求「过关销苏丹卡」，还把**结党、保全清流、拒绝无谓伤害**写成不可否决的决策约束，并落到选项评分、策略候选与经验结算——这是本项目相对「只会效率通关」的 Agent 的核心差异。

```text
┌─ 道德公理（system prompt，不可否决）─────────────────────────────┐
│  苏丹=终局 Boss，非盟友；安全窗口内优先结交/保全追随者与清流资产 │
└───────────────────────────────┬─────────────────────────────────┘
                                ▼
┌─ 选项利他分类（agents/sultan/src/moral/）────────────────────────┐
│  choiceHeuristics        关键词启发式（救助/结交 vs 杀害/取悦）  │
│  choiceAltruismClassify  LLM 补充分类，分数缓存到事件 facts       │
│  keyFollowers            具名追随者（梅姬/奈费勒/鲁梅拉…）社会资本 │
└───────────────────────────────┬─────────────────────────────────┘
                                ▼
┌─ 决策注入 & 记忆结算 ────────────────────────────────────────────┐
│  strategyEngine / episode：偏好利他选项，抑制「硬通害人」捷径     │
│  pending_strategic：短期资源亏损可记为战略投资，延后验证结算       │
│  dayReview / entity memory：把道德后果写回可复用经验               │
└──────────────────────────────────────────────────────────────────┘
```

典型故事（如「还书的少女」）：硬用苏丹卡能过关但会伤害少女；框架会推动 Agent **刷石级奢靡完美救援**，刷不到就回档重试，而不是拿 NPC 换进度。关闭开关可退回旧版纯效率评分。(实际测试没有良知框架应该是没办法过关的哈哈哈哈)

## 仓库结构

```text
VibeSultan/
├── plugins/SultanObserver/      # C# BepInEx 6 IL2CPP 插件
├── agents/sultan/               # TypeScript Agent / autoplay
├── packages/agent-learning-core # 通用记忆与经验迭代库
├── env/                         # 共享环境变量模板
├── game/Sultan's Game/          # 游戏安装目录 + BepInEx（本地）
├── refs/                        # BepInEx 6 / Unity stubs 等参考
├── docs/                        # 设计文档、迁移清单、探针笔记
└── assets/                      # 资源与素材
```

## 快速开始

### 1. 部署 Observer

```powershell
# 游戏放到 game/Sultan's Game/，并安装 BepInEx 6 Unity.IL2CPP
cd plugins/SultanObserver
.\deploy.ps1
```

(也有shell版本)

启动游戏（建议 Steam 在线），确认：

```bash
curl http://127.0.0.1:17890/health
```

### 2. 配置 Agent

```bash
cp env/.env.example env/.env
# 编辑 OPENAI_API_KEY
```

### 3. 安装并运行

```bash
npm install
npm run build
npm start -w @vibesultan/sultan-agent -- "观察当前界面，合法推进一局"
npm run autoplay -w @vibesultan/sultan-agent -- --fresh
```

### 测试

```bash
npm test
dotnet test plugins/SultanObserver.Tests/SultanObserver.Tests.csproj -c Release
```

## 许可证

[MIT License](./LICENSE) 

