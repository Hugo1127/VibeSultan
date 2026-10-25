# 踩坑与维护记录

Sultan Observer（C# BepInEx 插件）+ Sultan Agent（TypeScript）从部署到跑通这一路踩到的坑，
以及每个坑的判断方法和最终处置。fork 新仓库时先读这一份，可以省掉大部分试错。

> 本文件被 `.gitignore` 单独放行（`!refs/*.md`），会随仓库提交；
> `refs/` 下的 loader 压缩包、`game/` 下的游戏副本都不提交。

## 0. 环境指纹（当时跑通的版本）

| 项 | 值 |
|---|---|
| Unity | 2022.3.62f2（IL2CPP） |
| BepInEx | 6.0.0-be.785+6abdba47eeebe08552282e7a58ef0f4a9ab60b62（**Unity.IL2CPP-win-x64**） |
| Il2CppInterop | 1.5.3 |
| .NET target | net6.0（插件）/ net6.0（测试） |
| 本机 SDK | .NET 10.0.402，**没有装 .NET 6 运行时** |

## 1. 构建链路速查

```text
deploy.ps1
 └─ dotnet build plugins/SultanObserver
     ├─ 有 game/Sultan's Game/BepInEx/interop/UnityEngine.CoreModule.dll
     │    → 引用真实 interop，定义 GAME_INTEROP，HasGameInterop=true（完整插件）
     └─ 没有 interop
          → 自动构建 refs/unity-stubs/UnityEngine.CoreModule（编译桩）
          → 无 GAME_INTEROP：能编译、能起 HTTP，但游戏绑定全部编译掉
```

产物落到 `game/Sultan's Game/BepInEx/plugins/`。构建/部署**只写仓库副本**。

## 2. 坑：`refs/unity-stubs` 被 gitignore，全新 clone 必挂

**症状**：`deploy.ps1` 直接失败

```
error MSB3202: 未找到项目文件 "...\refs\unity-stubs\UnityEngine.CoreModule\UnityEngine.CoreModule.csproj"
```

**根因**：`SultanObserver.csproj` 在无 interop 时会 `MSBuild` 一个写死路径的桩工程，
但 `.gitignore` 把 `refs/**` 整棵树忽略了，仓库里只有 `refs/PLACEHOLDER.md`。
即"有 interop 的人能编译，没 interop 的人连 clone 都编不了"。

**处置**（已做）：

- 补回桩工程 `refs/unity-stubs/UnityEngine.CoreModule/`（csproj + Unity API stub）；
- `.gitignore` 放行 `!refs/unity-stubs/**`；
- csproj 的 `EnsureUnityStub` 目标加 `Exists('$(UnityStubProject)')` 条件，
  并改为 `Targets="Restore;Build"`（否则第一次没有 `obj/project.assets.json` 会报 `NETSDK1004`）；
- 加 `ReportMissingUnityReferences` 目标：两者都没有时报 `SULTAN001`，附带可执行的修复提示，
  取代难懂的 `MSB3202`。

## 3. 坑：loader 不是 IL2CPP 版 / 没跑过首次启动 → 没有 interop

**症状**：`deploy.ps1` 成功、DLL 也拷进去了，但游戏里始终没有 `http://127.0.0.1:17890/health`，
`BepInEx/interop` 目录根本不存在；`deploy.ps1` 会提示
`no BepInEx 6 IL2CPP runtime (BepInEx\core\BepInEx.Unity.IL2CPP.dll is missing)`。

**根因**：插件是 BepInEx 6 的 **Unity.IL2CPP** 插件。interop 程序集（`Game.dll` / `Core.dll` /
`Common.dll` / `UnityEngine.*.dll`）只由 IL2CPP 版 loader 在**首次启动时**生成
（Cpp2IL + Il2CppInterop）。loader 缺失或不是 IL2CPP 版，就永远没有 interop，
插件既加载不了，构建也只能一直走 stub 分支。

**仓库自带的包**（无需另外下载）：

```text
refs/BepInEx-Unity.IL2CPP-6.0.0-be.785.zip   # BepInEx 6 IL2CPP，win-x64，约 34 MB
# SHA256: 2A7CBF74D26ABE4765C3E662DB1721B923BAC39849EBFEF2CA5DC7DE7E2D9B7F
```

解压到游戏目录（以仓库副本为例）：

```powershell
# 在仓库根目录执行
Expand-Archive -Path refs\BepInEx-Unity.IL2CPP-6.0.0-be.785.zip `
               -DestinationPath "game\Sultan's Game" -Force
```

解压后确认这些存在：

- `BepInEx/core/BepInEx.Unity.IL2CPP.dll`（判断是不是 IL2CPP 版的唯一标准）
- `BepInEx/core/Il2CppInterop.Runtime.dll`
- `dotnet/`（loader 的 CoreCLR 运行时）
- `winhttp.dll` + `doorstop_config.ini`（`target_assembly = BepInEx\core\BepInEx.Unity.IL2CPP.dll`）

需要更新到其它 bleeding edge 版本时：<https://builds.bepinex.dev/projects/bepinex_be/785>
（文件名带 `+hash`，URL 里 `+` 要写成 `%2B`）。

**流程**：解压 loader → **先启动游戏一次**（生成 `BepInEx/interop/*.dll`；首次要跑 Cpp2IL，
通常十几秒到几分钟，日志里能看到 `Running Cpp2IL` 和 `Generating interop assemblies`，此时可以退出）
→ **再跑 `deploy.ps1`**，这次才会定义 `GAME_INTEROP`、编译出完整插件 → 重新启动游戏。

**最常见的顺序错误**：反过来"先 deploy 再启动"，于是拿到的是 stub 构建。表现为：

- 插件能加载、`/health` 返回 `ok:true`，但 **`hasInterop:false`**；
- `state` 里 `screen=unknown`、`initDone=false`、`inGame=false`，agent 启动阶段一直轮询；
- 以前会干等 60 秒后报 `boot_timeout`；现在 `index.ts` 在读到 `hasInterop:false` 时**立即报错**，
  提示"关游戏 → 确认 interop → 重新 deploy → 重启游戏"（`src/game/interopGuard.ts`）。

修法：启动过游戏（interop 已生成）后，在**关闭游戏**的状态下再跑一次 `deploy.ps1`。

## 4. 坑：无 interop 时源码本身也编译不过

补上桩工程后仍会报两类错，说明"fallback 编译"从来没被验证过：

- `PlayerActionRecorder.Install()` 无条件引用只在 `#if GAME_INTEROP` 里定义的 Harmony patch 类
  （`CardSlotDropCardPatch`、`Rite*Patch` 等）；
- `SemanticUiScanner` 的 `IsActionEnabled()` 只在 interop 分支定义，非 interop 分支却在调用。

**处置**：两处都加了 `#if` 守卫 / 非 interop 的降级实现（`return false`），
现在两条编译路径都能过。**fork 后新增代码要两边都能编译**，不能只在有 interop 时验证。

## 5. 坑：stub 构建"能编译"≠"能在游戏里跑"

即使 stub 构建通过，把它部署进游戏会看到（都是真实日志）：

```
[Warning] Il2Cpp AgentDecisionHud inject skipped (IMGUI interop):
          Could not load type 'UnityEngine.GUIStyle' from assembly 'UnityEngine.CoreModule'
[Error] Error loading [VibeSultan Sultan Observer 0.1.0]:
        System.MissingMethodException:
        Method not found: 'Void UnityEngine.Events.UnityAction`2..ctor(System.Object, IntPtr)'
```

原因：运行时解析的是 **interop 程序集**，而 stub 的形状和它不一致：

- `GUIStyle` 真实位置在 `UnityEngine.IMGUIModule`，stub 里放在 CoreModule；
- `UnityAction<T0,T1>` 在 interop 里是真正的 delegate，stub 版本的调用点按 stub 形状生成 IL；
- 这类 `MissingMethodException` 在 **方法 JIT 阶段**抛出，方法体里的 `try/catch` 兜不住。

**结论**：stub 构建只用于 CI / 没装游戏的机器做编译验证。
要验证运行时行为（HUD、`/health`、真实绑定），必须用 interop 构建。

**怎么区分部署的是哪种构建**：

| 构建 | DLL 大小 | `/health` | 程序集引用 | 日志特征 |
|---|---|---|---|---|
| stub | ~134 KB | `hasInterop:false` | 只有 `UnityEngine.CoreModule` | `PlayerActionRecorder: built without GAME_INTEROP` |
| interop | ~300 KB | `hasInterop:true` | 含 `UnityEngine.IMGUIModule` / `UnityEngine.UIModule` | `Hud.AgentDecisionHud` 注入成功、patch ok=25 |

## 6. 坑：Steam 会从自己目录启动，仓库副本里的插件不生效

**现象**：直接启动 `game/Sultan's Game/Sultan's Game.exe`，Steam 有时会接管，
实际跑的是 `D:\Steam\steamapps\common\Sultan's Game` 那份；那份没有 loader 和插件，
于是 `/health` 不通、日志也不更新。

**建议**：两条路都可用，按启动方式选：

1. **只用仓库副本**（开发/调试）：从 `game/Sultan's Game/` 启动；
   `deploy.ps1` 只写这里，最干净。
2. **要让 Steam 启动**（正常游玩、成就、云存档）：把同一套 loader **镜像**到 Steam 目录，
   只新增 loader 文件，不动游戏本体（先退出游戏，避免文件占用）：

   ```powershell
   $src = "game\Sultan's Game"
   $dst = "D:\Steam\steamapps\common\Sultan's Game"
   foreach ($item in @('BepInEx','dotnet','winhttp.dll','doorstop_config.ini','.doorstop_version')) {
     Copy-Item (Join-Path $src $item) -Destination $dst -Recurse -Force
   }
   ```

   镜像后 `BepInEx/interop` 和 `BepInEx/plugins` 会一起过去，插件立即可用。
   之后要同步新构建的插件，让 `deploy.ps1` 指到 Steam 目录：

   ```powershell
   $env:SULTAN_GAME_DIR = "D:\Steam\steamapps\common\Sultan's Game"
   cd plugins/SultanObserver; .\deploy.ps1
   ```

**边界**：镜像只新增 loader 目录/文件（`BepInEx/`、`dotnet/`、`winhttp.dll`、
`doorstop_config.ini`、`.doorstop_version`），不覆盖 `Sultan's Game.exe`、`GameAssembly.dll`、
`UnityPlayer.dll`、`*_Data/`；撤销时删掉这 5 项即可回到原版。
`deploy.ps1` 默认**不会**自动往 Steam 目录写，只在检测到那边也装了 BepInEx 时打印同步提示。

**存档**：`%USERPROFILE%\AppData\LocalLow\DoubleCross\SultansGame\SAVEDATA\<SteamID64>\`，
目录名带 SteamID —— 用 Steam 启动最稳，别用非 Steam 方式读进度。

## 7. 坑：LLM 400 —— `tool_calls` 后面必须紧跟 tool 消息

**症状**：跑了一段时间后 `llm_retry {"status":400}` 连刷 5 次，然后进程退出：

```
400 invalid_request_error
An assistant message with 'tool_calls' must be followed by tool messages
responding to each 'tool_call_id'. (insufficient tool messages following tool_calls message)
```

**根因**：`loop.ts` 在执行工具期间就把 `report_action_chain` 的"行动链 brief"以 **user 消息**
塞进历史，而该调用的 tool 结果要到工具循环末尾才 push，历史变成：

```
assistant(tool_calls) → user(brief) → tool(call_id)     ❌ 协议不允许
```

**为什么看起来"LLM 不返回"**：`retry.ts` 原来把所有 4xx 当可重试，
400 是确定性错误，重试 5 次 × 10s 全失败，表现为卡死。

**处置**：

- `loop.ts`：brief 改为进 `deferredBriefs` 队列，整批 tool 消息写完后才 append；
- `src/agent/messageOrder.ts`：新增 `sanitizeToolMessageOrder()`，每次请求前兜底重排
  （中间的 user 消息移到 tool 之后、缺失的 tool 结果补 `tool_result_missing`、孤儿 tool 丢弃）；
- `src/llm/retry.ts`：只重试 `408/409/425/429/5xx`，400 立即失败并抛出原文；
- `scripts/verify-message-order.ts`：回归用例，已加入根目录 `npm test` 链。

**写新代码时的硬约束**：

- `messages.push()` 不允许出现在 `assistant(tool_calls)` 与其 tool 结果之间；
- 一次返回 N 个 `tool_calls`，就必须有 N 条 `role:"tool"` 且 `tool_call_id` 一一对应；
- 想插 user 提示（brief / 提醒 / recovery），一律排到整批 tool 之后。

**复现校验**：失败 run 的 `agents/sultan/logs/runs/<run>/messages.json` 可以直接喂给
`sanitizeToolMessageOrder()`，看尾部是否从 `assistant,user,tool` 变成 `assistant,tool,user`。

## 8. 坑：工具链 / 环境

- **.NET 6 运行时缺失**：本机只有 .NET 10。`dotnet test plugins/SultanObserver.Tests` 会报
  `app-launch-failed`，加 `$env:DOTNET_ROLL_FORWARD='Major'` 后可跑（139 个用例通过）。
- **NU1603 警告无害**：`BepInEx.Unity.IL2CPP 6.0.0-be.785` 依赖的
  `Samboy063.Cpp2IL.Core 2022.1.0-development.1452` 已下架，解析到 `pre-release.13`。
- **NuGet 源**：插件依赖 BepInEx 的 feed（`https://nuget.bepinex.dev/v3/index.json`），
  离线机器需要预热 `~/.nuget/packages`；`NU1900` 只是漏洞数据源不可达。
- **interop 与游戏版本绑定**：游戏更新后 interop 可能失配，删掉 `BepInEx/interop/` 重开一次游戏重新生成。
