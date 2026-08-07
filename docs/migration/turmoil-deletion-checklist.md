# Turmoil → Sultan Migration Deletion Checklist

Generated during the Sultan migration. Old Turmoil trees are **read-only references** until this checklist is green, then they may be deleted.

## Delete threshold

- [x] New dirs exist: `plugins/SultanObserver`, `agents/sultan`, `packages/agent-learning-core`
- [x] Root npm workspaces cover `agents/*` and `packages/*`
- [x] Learning-core has game-agnostic models + tests (no Turmoil/Sultan domain terms in package src)
- [x] Sultan Agent/plugin do not import from `agents/turmoil` or `plugins/TurmoilObserver`
- [x] Docs / env template migrated to Sultan naming
- [x] After delete: full workspace build/test still passes

## Plugin file disposition (`plugins/TurmoilObserver`)

| Path | Disposition | New home |
|------|-------------|---------|
| `Plugin.cs` | sultan-rewrite | `plugins/SultanObserver/Plugin.cs` |
| `Export/HttpStateServer.cs` | sultan-rewrite | `plugins/SultanObserver/Export/HttpStateServer.cs` |
| `Export/StateFileWriter.cs` | migrated (pattern) | `plugins/SultanObserver/Export/StateFileWriter.cs` |
| `State/GameState.cs` | sultan-rewrite | `plugins/SultanObserver/State/GameState.cs` |
| `State/StateHub.cs` | migrated (pattern) | `plugins/SultanObserver/State/StateHub.cs` |
| `State/StateSerializer.cs` | migrated (pattern) | `plugins/SultanObserver/State/StateSerializer.cs` |
| `State/CompactProjector.cs` | sultan-rewrite | `plugins/SultanObserver/State/CompactProjector.cs` |
| `State/StateReader.cs` + `Readers/*` | obsolete / rewrite | `plugins/SultanObserver/State/StateReader.cs` + Sultan readers |
| `State/SeedIdentity.cs` | obsolete | — |
| `Action/ActionQueue.cs` | migrated (pattern) | `plugins/SultanObserver/Action/ActionQueue.cs` |
| `Action/ActionModels.cs` | migrated (pattern) | `plugins/SultanObserver/Action/ActionModels.cs` |
| `Action/ActionExecutor.cs` | sultan-rewrite | `plugins/SultanObserver/Action/ActionExecutor.cs` |
| `Action/UiActionExecutor.cs` | obsolete | — |
| `Action/ControlActionExecutor.cs` | sultan-rewrite (noop/time) | `plugins/SultanObserver/Action/ActionExecutor.cs` |
| `Action/PlanScheduler.cs` | sultan-rewrite (later) | deferred past MVP |
| `Hud/*` | migrated (pattern) | `plugins/SultanObserver/Hud/*` |
| `Scenario/*` | obsolete for MVP | deferred |
| `Record/*` | obsolete for MVP | deferred (probe later) |
| `*.csproj` / `Directory.Build.props` / `deploy.*` | sultan-rewrite | BepInEx 6 IL2CPP paths |

## Agent file disposition (`agents/turmoil/src`)

| Path | Disposition | New home |
|------|-------------|---------|
| `game/GameOps.ts` | migrated (pattern) | `agents/sultan/src/game/GameOps.ts` |
| `game/HttpGameOps.ts` | sultan-rewrite | `agents/sultan/src/game/HttpGameOps.ts` |
| `game/types.ts` | sultan-rewrite | `agents/sultan/src/game/types.ts` |
| `agent/loop.ts` | sultan-rewrite | `agents/sultan/src/agent/loop.ts` |
| `agent/tools.ts` / `systemPrompt.ts` / `boot.ts` | sultan-rewrite | `agents/sultan/src/agent/*` |
| `agent/contextCompress.ts` / `backgroundCompress.ts` | migrated | `agents/sultan/src/agent/*` |
| `llm/*` | migrated | `agents/sultan/src/llm/*` |
| `log/AgentLogger.ts` | migrated | `agents/sultan/src/log/AgentLogger.ts` |
| `config.ts` / `index.ts` | sultan-rewrite | `agents/sultan/src/*` |
| `orchestrator.ts` | sultan-rewrite | `agents/sultan/src/orchestrator.ts` |
| `memory/hypothesisStore.ts` | migrated → core | `packages/agent-learning-core` (generic) |
| `memory/tipStore.ts` | migrated → core | `packages/agent-learning-core` |
| `memory/experimentLedger.ts` | migrated → core | `packages/agent-learning-core` |
| `memory/dedupe.ts` | migrated → core | `packages/agent-learning-core` (domain concepts injected) |
| `memory/memoryAudit.ts` | migrated → core | `packages/agent-learning-core` |
| `memory/researchAgenda.ts` / `retryReview.ts` | migrated → core | `packages/agent-learning-core` |
| `memory/session.ts` / `inject.ts` | sultan-rewrite | `agents/sultan/src/memory/*` |
| `memory/boot.ts` / `gameLog.ts` / `seedRegistry.ts` / `antiCheat.ts` / `review.ts` | obsolete / rewrite | Sultan adapters |
| `validation/*` domain categories | obsolete | `agents/sultan/src/validation/*` |
| `validation/attribution.ts` / `comparability.ts` / `headroom.ts` | migrated → core | `packages/agent-learning-core` |
| `skillopt/*` | migrated → core (framework) | `packages/agent-learning-core` + sultan adapter |
| `metrics/*` | migrated (generic) / rewrite | `packages/agent-learning-core` + sultan metrics |
| Turmoil verify scripts (terrain/seed/oil) | obsolete | Sultan verify scripts |
| Generic verify (ledger/dedupe/retry/tips) | migrated | `packages/agent-learning-core` tests + sultan scripts |

## Behavior baseline (legacy commands)

```bash
# Legacy (before delete) — for reference only
cd agents/turmoil && npm run build
cd agents/turmoil && npm run verify:dedupe
cd agents/turmoil && npm run verify:ledger
cd agents/turmoil && npm run verify:retry-policy
```

## New workspace commands

```bash
npm install
npm run build -w @vibesultan/agent-learning-core
npm test -w @vibesultan/agent-learning-core
npm run build -w @vibesultan/sultan-agent
npm run verify:http-contract -w @vibesultan/sultan-agent
dotnet build plugins/SultanObserver/SultanObserver.csproj -c Release -p:SkipPluginCopy=true
```

## Safe to delete when green

```text
agents/turmoil/
plugins/TurmoilObserver/
```
