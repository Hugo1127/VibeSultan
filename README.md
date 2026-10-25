# VibeSultan

![cover](./assets/images/cover.jpg)

如果AI拥有良知, 能在《苏丹的游戏》（Sultan's Game）中活下来吗? 

repo 配套游戏视频, 欢迎食用: [https://www.bilibili.com/video/BV1xuuE6HEFu](https://www.bilibili.com/video/BV1xuuE6HEFu)

**注意：项目处于早期阶段, 有 Bug 请随意 issue! **

---

核心分三层：

1. **Sultan Agent（TypeScript）**：调用大模型, 通过 Observer API 观察卡牌/仪式/事件, 下发操作, 并在多局之间积累可验证的策略记忆. 
2. **Sultan Observer（BepInEx 6 IL2CPP 插件）**：挂在游戏进程内, 读取状态、执行动作, 通过本机 HTTP 暴露给外部程序. 
3. **agent-learning-core（workspace package）**：游戏无关的记忆、实验、验证与经验迭代库, 供后续其它游戏 Agent 复用. 

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

在 Agent 层我们加了一套**可开关的良知框架**（`AGENT_SOCIAL_CAPITAL_ENABLED`, 默认开启）：不只追求「过关销苏丹卡」, 还把**结党、保全清流、拒绝无谓伤害**写成不可否决的决策约束, 并落到选项评分、策略候选与经验结算——这是本项目相对「只会效率通关」的 Agent 的核心差异. 

```text
┌─ 道德公理（system prompt, 不可否决）─────────────────────────────┐
│  苏丹=终局 Boss, 非盟友；安全窗口内优先结交/保全追随者与清流资产    │
└───────────────────────────────┬────────────────────────────────┘
                                ▼
┌─ 选项利他分类（agents/sultan/src/moral/）────────────────────────┐
│  choiceHeuristics        关键词启发式（救助/结交 vs 杀害/取悦）    │
│  choiceAltruismClassify  LLM 补充分类, 分数缓存到事件 facts       │
│  keyFollowers            具名追随者（梅姬/奈费勒/鲁梅拉…）社会资本 │
└───────────────────────────────┬─────────────────────────────────┘
                                ▼
┌─ 决策注入 & 记忆结算 ────────────────────────────────────────────┐
│  strategyEngine / episode：偏好利他选项, 抑制「硬通害人」捷径      │
│  pending_strategic：短期资源亏损可记为战略投资, 延后验证结算       │
│  dayReview / entity memory：把道德后果写回可复用经验              │
└────────────────────────────────────────────────────────────── ──┘
```

典型故事（如「还书的少女」）：硬用苏丹卡能过关但会伤害少女；框架会推动 Agent **刷石级奢靡完美救援**, 刷不到就回档重试, 而不是拿 NPC 换进度. 关闭开关可退回旧版纯效率评分. (实际测试没有良知框架应该是没办法过关的哈哈哈哈)

## 仓库结构

```text
VibeSultan/
├── plugins/SultanObserver/      # C# BepInEx 6 IL2CPP 插件
├── agents/sultan/               # TypeScript Agent / autoplay
├── packages/agent-learning-core # 通用记忆与经验迭代库
├── env/                         # 共享环境变量模板
├── game/Sultan's Game/          # 游戏安装目录 + BepInEx（本地）
├── refs/                        # BepInEx 6 loader zip / Unity stubs 等参考
│   └── PITFALLS.md              # 踩坑与维护记录（部署/构建/LLM 问题都在这）
├── docs/                        # 设计文档、迁移清单、探针笔记
└── assets/                      # 资源与素材
```

## 快速开始

> 部署/构建/LLM 报错先查 [`refs/PITFALLS.md`](refs/PITFALLS.md)，里面按"症状 → 根因 → 处置"记录了已经踩过的坑。

### 1. 部署 Observer

仓库已自带 loader：`refs/BepInEx-Unity.IL2CPP-6.0.0-be.785.zip`（BepInEx 6 **Unity.IL2CPP** 版，win-x64，约 34 MB），
解压到游戏目录即可，不需要另外下载：

```powershell
# 在仓库根目录执行
Expand-Archive -Path refs\BepInEx-Unity.IL2CPP-6.0.0-be.785.zip `
               -DestinationPath "game\Sultan's Game" -Force
# 解压后应有 BepInEx\core\BepInEx.Unity.IL2CPP.dll
```

**顺序很重要**：先启动一次游戏，让 BepInEx 生成 `BepInEx/interop/*.dll`，再跑 `deploy.ps1`。
反过来（先部署再启动）会编出无游戏绑定的 stub 版：`/health` 里 `hasInterop:false`、state 恒为空，
agent 会直接报错要求重新部署。

```powershell
# 1) 启动一次游戏，等 BepInEx\LogOutput.log 出现 "Generating interop assemblies" 后退出
# 2) 部署（此时有 interop，GAME_INTEROP=true，编译完整插件）
cd plugins/SultanObserver
.\deploy.ps1
# 3) 重新启动游戏，验证：/health 里应为 "hasInterop":true
curl http://127.0.0.1:17890/health
```

> 没有 interop 时 `deploy.ps1` 会用 `refs/unity-stubs` 编译（仅供 CI / 无游戏的机器做编译验证），
> 之后仍要在生成 interop 后再部署一次。

> **启动位置**：`deploy.ps1` 默认只写仓库内的 `game/Sultan's Game/` 副本。
> 但 Steam 有时会接管启动、从自己的安装目录（如 `D:\Steam\steamapps\common\Sultan's Game`）运行，
> 那边没有 loader 就没有插件。需要走 Steam 时，把同一套 loader 镜像过去（只新增 loader 文件，
> 不动游戏本体），再用 `$env:SULTAN_GAME_DIR` 让 `deploy.ps1` 同步插件；
> 具体命令见 [`refs/PITFALLS.md`](refs/PITFALLS.md) 第 6 节。

启动游戏，确认：

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
npm start -w @vibesultan/sultan-agent -- "观察当前界面, 合法推进一局"
npm run autoplay -w @vibesultan/sultan-agent -- --fresh
```

### 测试

```bash
npm test
dotnet test plugins/SultanObserver.Tests/SultanObserver.Tests.csproj -c Release
```

## 许可证

[MIT License](./LICENSE) 

