# Reference packages

Local cache of third-party packages used while developing the Observer. Most of
this tree is gitignored because of size; the loader archive, the compile-time
Unity stubs and the maintenance notes are committed because the build and the
next maintainer need them.

```text
refs/
├── PITFALLS.md                              # 踩坑与维护记录（committed）
├── BepInEx-Unity.IL2CPP-6.0.0-be.785.zip    # loader archive, ~34 MB（committed）
└── unity-stubs/UnityEngine.CoreModule/      # compile-only Unity stubs（committed）
```

## Notes

- **Read [`PITFALLS.md`](./PITFALLS.md) before changing the build, the loader or
  the agent loop.** It records every failure mode hit so far (missing stubs,
  loader/interop setup, stub builds that only compile, the LLM 400 tool-call
  ordering bug) with symptoms, causes and fixes.
- The bundled archive is the **Unity.IL2CPP** build of BepInEx 6. Extract it into
  the game folder; `BepInEx/core/BepInEx.Unity.IL2CPP.dll` must appear. The first
  launch generates `BepInEx/interop/*.dll`; after that, deploy once more so the
  plugin compiles with `GAME_INTEROP`.
- If Steam launches its own install instead of the repo copy, mirror the same
  loader files into that install and deploy with `$env:SULTAN_GAME_DIR`
  (see `PITFALLS.md` section 6).
- Newer bleeding-edge builds: <https://builds.bepinex.dev/projects/bepinex_be/785>.
- `refs/unity-stubs` is compiled only until the first game launch generates
  `BepInEx/interop/*.dll`; keep it checked in so a fresh clone can build.
