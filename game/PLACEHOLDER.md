# Game install (not committed)

Put a local **Sultan's Game** install here:

```text
game/Sultan's Game/
  Sultan's Game.exe
  Sultan's Game_Data/
  GameAssembly.dll              # IL2CPP
  BepInEx/                      # BepInEx 6 Unity.IL2CPP
  BepInEx/plugins/              # deploy VibeSultan.Sultan.Observer.dll (+ Newtonsoft.Json.dll)
  BepInEx/interop/              # generated on first launch
```

## How to set up

1. Copy your Steam (or other) Sultan's Game folder to `game/Sultan's Game/`.
2. Install **BepInEx 6 Unity.IL2CPP win-x64** (Bleeding Edge). A reference copy lives in `refs/BepInEx-Unity.IL2CPP-6.0.0-be.785/`.
3. Build and deploy the Observer:

```powershell
cd plugins/SultanObserver
.\deploy.ps1
```

4. **Critical:** Steam usually runs the real install under  
   `D:\SteamLibrary\steamapps\common\Sultan's Game\`  
   (not this repo `game/` copy). BepInEx must exist in **that** folder, or `/health` will be `ECONNREFUSED`.
5. `plugins/SultanObserver/deploy.ps1` deploys the plugin DLL to both the repo copy and the Steam path when present.
6. Launch from Steam, then verify: `curl http://127.0.0.1:17890/health`

See also: [`docs/games/sultan/il2cpp-probe.md`](../docs/games/sultan/il2cpp-probe.md).

Do **not** commit the game binaries — they are gitignored.
