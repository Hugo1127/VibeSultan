# Sultan IL2CPP Probe Notes

## Stack

| Item | Value |
|------|-------|
| Unity | 2022.3.62f2 |
| Backend | IL2CPP (`GameAssembly.dll` + `global-metadata.dat`) |
| Mod loader | BepInEx 6.0.0-be.785 Unity.IL2CPP win-x64 |
| Plugin | `VibeSultan.Sultan.Observer` (`com.vibesultan.sultan.observer`) |
| HTTP | `http://127.0.0.1:17890` |

## Install status

- BepInEx extracted into [`game/Sultan's Game`](../../../game/Sultan's%20Game)
- Reference copy: [`refs/BepInEx-Unity.IL2CPP-6.0.0-be.785`](../../../refs/BepInEx-Unity.IL2CPP-6.0.0-be.785)
- Plugin deploy: `plugins/SultanObserver/deploy.ps1`

## First launch (required for real interop)

1. Close any previous game process.
2. Build + deploy:

```powershell
cd plugins/SultanObserver
.\deploy.ps1
```

3. Launch `Sultan's Game.exe` once. First IL2CPP boot generates `BepInEx/interop/*.dll` and may take several minutes.
4. Confirm logs: `game/Sultan's Game/BepInEx/LogOutput.txt` contains `Sultan Observer Load`.
5. Smoke:

```powershell
curl http://127.0.0.1:17890/health
curl "http://127.0.0.1:17890/state?views=diagnostics"
curl -Method POST http://127.0.0.1:17890/actions -ContentType application/json -Body '{"actions":[{"op":"probe_types"}]}'
```

## Probe targets

`TypeProbe` looks for: `GameController`, `CardController`, `RitePanelController`, `GlobalState`, `SystemMainMenu`, `StoryNotifyController`, `ActivePanelManager`, `HandBagPanelController`, `CardDragManager`, `SteamManager`.

Results appear in `/state?views=diagnostics` under `raw.typeProbe`.

## Version fingerprint

`GameVersionGuard` encodes `unity|product|GameAssemblySize`. Dangerous ops are refused when Unity version drifts away from `2022.3.62*`.

## Compile-time stubs

When `BepInEx/interop` is missing, the plugin builds against [`refs/unity-stubs`](../../../refs/unity-stubs). After first launch, rebuild so the project prefers real interop assemblies.
