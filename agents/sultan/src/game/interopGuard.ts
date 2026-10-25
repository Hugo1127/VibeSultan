import type { HealthResponse } from "./types.js";

/**
 * A plugin compiled without `BepInEx/interop` (the compile-time stub build)
 * still answers `/health` with `ok: true`, but every game binding is compiled
 * out (`hasInterop: false`): state stays empty forever and the agent would just
 * poll until `boot_timeout`.
 *
 * Fail fast instead, and tell the operator the exact recovery order.
 */
export function assertObserverHasInterop(health: HealthResponse, gameBaseUrl?: string): void {
  if (health.hasInterop !== false) return;

  const where = gameBaseUrl ? ` (${gameBaseUrl})` : "";
  throw new Error(
    `Observer 是无 interop 的 stub 构建${where}：/health 里 hasInterop=false，游戏绑定没有编译进去，state 会一直为空。` +
      " 处理顺序：关闭游戏 → 确认游戏目录下 BepInEx\\interop 已生成（首次启动游戏时由 BepInEx 自动生成）" +
      " → 在 plugins/SultanObserver 下运行 deploy.ps1 重新构建并部署 → 重新启动游戏后再运行 agent。",
  );
}
