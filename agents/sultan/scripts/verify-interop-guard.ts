import assert from "node:assert/strict";
import { assertObserverHasInterop } from "../src/game/interopGuard.js";

// Interop present (or unknown field): never throw.
assertObserverHasInterop({ ok: true, hasInterop: true });
assertObserverHasInterop({ ok: true });

// Stub build: fail fast with recovery instructions instead of boot_timeout.
assert.throws(
  () => assertObserverHasInterop({ ok: true, hasInterop: false }, "http://127.0.0.1:17890"),
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    assert.match(message, /hasInterop=false/);
    assert.match(message, /deploy\.ps1/);
    assert.match(message, /interop/);
    return true;
  },
);

console.log("Interop guard verification passed.");
