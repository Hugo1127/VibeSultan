#!/usr/bin/env bash
# Build VibeSultan.Sultan.Observer and copy into BepInEx plugins folders.
# Deploys to the repo copy AND the live Steam install when present.
#
# Cygwin / MSYS note:
#   Windows MSBuild treats args starting with "/" as switches (MSB1001).
#   Paths passed to dotnet.exe are converted with cygpath -w when available.
#
# Usage:
#   ./deploy.sh           # Release
#   ./deploy.sh --debug   # Debug
#   SULTAN_GAME_DIR=/cygdrive/d/SteamLibrary/steamapps/common/Sultan\'s\ Game ./deploy.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Convert a POSIX/Cygwin/WSL path to a Windows path for native Win32 tools (dotnet).
to_win() {
  local p="$1"
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w -- "$p"
    return
  fi
  # WSL: /mnt/z/foo -> Z:\foo
  if [[ "$p" =~ ^/mnt/([a-zA-Z])/(.*)$ ]]; then
    local drive="${BASH_REMATCH[1]}"
    local rest="${BASH_REMATCH[2]//\//\\}"
    printf '%s:\\%s\n' "${drive^^}" "$rest"
    return
  fi
  # Git Bash fallback
  if command -v pwd >/dev/null 2>&1; then
    local parent base wparent
    parent="$(dirname "$p")"
    base="$(basename "$p")"
    if [[ -d "$parent" ]] && wparent="$(cd "$parent" && pwd -W 2>/dev/null)"; then
      printf '%s\%s\n' "${wparent//\//\\}" "$base"
      return
    fi
  fi
  printf '%s\n' "$p"
}

# Prefer Linux/Cygwin PATH; fall back to Windows host SDK (common under WSL/Cursor).
resolve_dotnet() {
  if command -v dotnet >/dev/null 2>&1; then
    command -v dotnet
    return
  fi
  local candidates=(
    "/cygdrive/c/Program Files/dotnet/dotnet.exe"
    "/mnt/c/Program Files/dotnet/dotnet.exe"
    "/c/Program Files/dotnet/dotnet.exe"
    "C:/Program Files/dotnet/dotnet.exe"
  )
  local c
  for c in "${candidates[@]}"; do
    if [[ -x "$c" ]] || [[ -f "$c" ]]; then
      printf '%s\n' "$c"
      return
    fi
  done
  return 1
}

CONFIG="Release"
for arg in "$@"; do
  case "$arg" in
    -Debug|--debug|-d) CONFIG="Debug" ;;
  esac
done

DLL_NAME="VibeSultan.Sultan.Observer.dll"
BUILT_DLL="${SCRIPT_DIR}/bin/${CONFIG}/${DLL_NAME}"
JSON_DLL="${SCRIPT_DIR}/bin/${CONFIG}/Newtonsoft.Json.dll"
PROJECT_POSIX="${SCRIPT_DIR}/SultanObserver.csproj"

DEPLOY_DIRS=()
DEPLOY_DIRS+=("${REPO_ROOT}/game/Sultan's Game/BepInEx/plugins")

# Steam install candidates (Cygwin / Git Bash / WSL / native).
CANDIDATE_STEAM_GAMES=(
  "/cygdrive/d/SteamLibrary/steamapps/common/Sultan's Game"
  "/cygdrive/c/SteamLibrary/steamapps/common/Sultan's Game"
  "/d/SteamLibrary/steamapps/common/Sultan's Game"
  "/D/SteamLibrary/steamapps/common/Sultan's Game"
  "/mnt/d/SteamLibrary/steamapps/common/Sultan's Game"
  "D:/SteamLibrary/steamapps/common/Sultan's Game"
)

for steam_game in "${CANDIDATE_STEAM_GAMES[@]}"; do
  if [[ -d "$steam_game" ]]; then
    DEPLOY_DIRS+=("${steam_game}/BepInEx/plugins")
    break
  fi
done

if [[ -n "${SULTAN_GAME_DIR:-}" && -d "${SULTAN_GAME_DIR}" ]]; then
  DEPLOY_DIRS+=("${SULTAN_GAME_DIR}/BepInEx/plugins")
fi

# Deduplicate while preserving order.
UNIQUE_DIRS=()
for dir in "${DEPLOY_DIRS[@]}"; do
  seen=0
  for u in "${UNIQUE_DIRS[@]+"${UNIQUE_DIRS[@]}"}"; do
    if [[ "$u" == "$dir" ]]; then
      seen=1
      break
    fi
  done
  if [[ $seen -eq 0 ]]; then
    UNIQUE_DIRS+=("$dir")
  fi
done
DEPLOY_DIRS=("${UNIQUE_DIRS[@]}")

game_running() {
  if command -v tasklist >/dev/null 2>&1; then
    tasklist 2>/dev/null | grep -Fi "Sultan's Game" >/dev/null 2>&1 && return 0
  fi
  # Cygwin: //./ process listing via procps if present
  if command -v pgrep >/dev/null 2>&1; then
    pgrep -f "Sultan's Game" >/dev/null 2>&1 && return 0
  fi
  return 1
}

file_locked() {
  local path="$1"
  [[ -e "$path" ]] || return 1
  if command -v lsof >/dev/null 2>&1; then
    lsof "$path" >/dev/null 2>&1 && return 0
  fi
  # Rename round-trip: fails when Windows holds the DLL open.
  local tmp="${path}.deploy-lock-check.$$"
  if mv "$path" "$tmp" 2>/dev/null; then
    mv "$tmp" "$path" 2>/dev/null || true
    return 1
  fi
  return 0
}

any_target_locked() {
  local dir dll
  for dir in "${DEPLOY_DIRS[@]}"; do
    dll="${dir}/${DLL_NAME}"
    if file_locked "$dll"; then
      return 0
    fi
  done
  return 1
}

wait_until_game_closed() {
  while true; do
    if ! game_running && ! any_target_locked; then
      return 0
    fi
    echo ""
    echo "Cannot replace plugin DLL — game is running or file is locked."
    echo "Quit Sultan's Game, then press Enter. Press Q to cancel."
    read -r answer || exit 1
    if [[ "$answer" =~ ^[Qq]$ ]]; then
      exit 1
    fi
  done
}

echo "==> Building SultanObserver (${CONFIG}) ..."

DOTNET_BIN="$(resolve_dotnet)" || {
  echo "dotnet not found on PATH. Install .NET SDK or add it to PATH." >&2
  exit 1
}

if [[ ! -f "$PROJECT_POSIX" ]]; then
  echo "Missing project: ${PROJECT_POSIX}" >&2
  exit 1
fi

PROJECT_WIN="$(to_win "$PROJECT_POSIX")"
echo "    project: ${PROJECT_WIN}"
echo "    dotnet:  ${DOTNET_BIN}"

# Pass a Windows path so MSBuild does not see a leading "/" switch.
# CYGWIN=nodosfilewarning: quiet cygwin DOS-path warnings if set by user env.
# Under WSL, Windows dotnet.exe still needs a Windows project path (to_win).
"$DOTNET_BIN" build "$PROJECT_WIN" -c "$CONFIG" -p:SkipPluginCopy=true

if [[ ! -f "$BUILT_DLL" ]]; then
  echo "Missing build output: ${BUILT_DLL}" >&2
  exit 1
fi

wait_until_game_closed

for plugin_out_dir in "${DEPLOY_DIRS[@]}"; do
  parent="$(dirname "$plugin_out_dir")"
  if [[ ! -d "$parent" ]]; then
    echo "Skip (no BepInEx yet): ${plugin_out_dir}"
    continue
  fi
  mkdir -p "$plugin_out_dir"
  cp -f "$BUILT_DLL" "${plugin_out_dir}/${DLL_NAME}"
  if [[ -f "$JSON_DLL" ]]; then
    cp -f "$JSON_DLL" "${plugin_out_dir}/Newtonsoft.Json.dll"
  fi
  echo "Deployed: ${plugin_out_dir}/${DLL_NAME}"
done

echo ""
echo "IMPORTANT: Steam launches the Steam install, not necessarily the repo copy."
echo "Start the game from Steam, then: curl http://127.0.0.1:17890/health"
