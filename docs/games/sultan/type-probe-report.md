# Runtime Type Probe Report

Captured from BepInEx log on 2026-07-25 during first IL2CPP boot.

## Environment

- Unity `2022.3.62f2`
- BepInEx `6.0.0-be.785`
- Plugin `VibeSultan Sultan Observer 0.1.0`
- `TypeProbe hitCount=15`
- Fingerprint `2022.3.62f2|Sultan's Game|43017216` (`versionSafe=true`)

## Interop

First launch generated `game/Sultan's Game/BepInEx/interop/` (113 assemblies), including:

- `Game.dll`, `Core.dll`, `Common.dll`, `Base.dll`, `Assembly-CSharp.dll`
- `UnityEngine.CoreModule.dll`, `UnityEngine.IMGUIModule.dll`, …
- `Il2Cppmscorlib.dll`

## Plugin load sequence (success)

1. Chainloader loads plugin
2. `ObserverHost` + `AgentDecisionHud` registered in IL2CPP domain
3. HTTP listens on `http://127.0.0.1:17890/`
4. Host/HUD components attached
5. Type probe completes with 15 hits

## HTTP smoke (headless / Steam-short session)

| Endpoint | Result |
|----------|--------|
| `GET /health` | OK — plugin/game/unity/fingerprint fields present |
| `GET /state` | Returns schema; full scene/values need a living Unity main loop |
| `POST /actions` (`noop`/`probe_types`) | Thread-safe fast path supported |

Note: launching without an active Steam session may exit the process shortly after Chainloader startup. Keep Steam running for sustained Observer use.

## Next binding targets

Prefer these names from StreamingAssets + probe hits:

- `GameController`
- `CardController` / `CardDragManager` / `CardDropManager`
- `RitePanelController` / `RitePanelShowController`
- `GlobalState` / global counters
- `StoryNotifyController`
- `SystemMainMenu` / `ActivePanelManager`
