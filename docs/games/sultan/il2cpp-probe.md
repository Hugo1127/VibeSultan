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
- Loader bundled in the repo: [`refs/BepInEx-Unity.IL2CPP-6.0.0-be.785.zip`](../../../refs/BepInEx-Unity.IL2CPP-6.0.0-be.785.zip)
  (BepInEx 6 **Unity.IL2CPP**, win-x64, ~34 MB — no separate download needed)
- Plugin deploy: `plugins/SultanObserver/deploy.ps1`

Extract the bundled loader into the game folder:

```powershell
# run from the repository root
Expand-Archive -Path refs\BepInEx-Unity.IL2CPP-6.0.0-be.785.zip `
               -DestinationPath "game\Sultan's Game" -Force
```

After extraction `BepInEx\core\BepInEx.Unity.IL2CPP.dll` must exist — that is the
only reliable marker that the loader is the IL2CPP flavour.

> **Launch location matters.** Steam sometimes takes over the launch and runs its
> own install (`D:\Steam\steamapps\common\Sultan's Game`), which has no loader and
> therefore no plugin. To play through Steam, mirror the same loader files there
> (`BepInEx/`, `dotnet/`, `winhttp.dll`, `doorstop_config.ini`, `.doorstop_version`)
> without touching the game binaries, then point `deploy.ps1` at it with
> `$env:SULTAN_GAME_DIR`. Details and the copy command are in
> [`refs/PITFALLS.md`](../../../refs/PITFALLS.md) section 6.

## First launch (required for real interop)

Interop assemblies only exist after the game has booted once with the loader.
Do that **before** the first deploy — the reverse order produces a stub build
(`/health` reports `hasInterop:false`, state stays empty, and the agent now fails
fast with the recovery steps):

1. Close any previous game process.
2. Launch `Sultan's Game.exe` once. BepInEx runs Cpp2IL and writes
   `BepInEx/interop/*.dll` (may take minutes on the first run). Quit after
   `Generating interop assemblies` shows up in `BepInEx/LogOutput.log`.
3. Build + deploy — with `BepInEx/interop` present the plugin compiles against
   the generated assemblies (`GAME_INTEROP` defined) and has the real bindings:

```powershell
cd plugins/SultanObserver
.\deploy.ps1
```

4. Launch the game again and confirm the plugin log contains `Sultan Observer Load`.
5. Smoke (`/health` should report `"hasInterop":true`):

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

`refs/unity-stubs/UnityEngine.CoreModule` is a checked-in stub of the slice of
the Unity API this plugin touches. `SultanObserver.csproj` builds it
automatically while `BepInEx/interop/UnityEngine.CoreModule.dll` is missing, so
a fresh clone can run `dotnet build` (and CI / `dotnet test`) without the game.
The stubs contain no game types: `HasGameInterop` stays false, so binding calls
compile to `binding_missing` until the first launch generates real interop.
