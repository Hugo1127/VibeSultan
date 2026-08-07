# Upstream reference packages (not committed)

Optional local cache of third-party packages used while developing the Observer.

Typical layout:

```text
refs/BepInEx-v5.4.23.5/    # BepInEx 5.4.23.5 zip/extracted package
```

## Notes

- Runtime BepInEx must be installed under `game/Turmoil/BepInEx/` (see `game/PLACEHOLDER.md`).
- This `refs/` tree is only a convenience backup of upstream archives; it is gitignored because of size.
- Download BepInEx from the official BepInEx releases if you need a fresh copy.
