# Build VibeSultan.Sultan.Observer and copy into BepInEx plugins folders.
# Deploys to the repo copy AND the live Steam install when present.

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..\..")
$Project = Join-Path $ScriptDir "SultanObserver.csproj"
$Config = if ($args -contains "-Debug") { "Debug" } else { "Release" }

$DllName = "VibeSultan.Sultan.Observer.dll"
$BuiltDll = Join-Path $ScriptDir "bin\$Config\$DllName"
$JsonDll = Join-Path $ScriptDir "bin\$Config\Newtonsoft.Json.dll"

$DeployDirs = @(
  (Join-Path $RepoRoot "game\Sultan's Game\BepInEx\plugins")
)

$steamGame = "D:\SteamLibrary\steamapps\common\Sultan's Game"
if (Test-Path -LiteralPath $steamGame) {
  $DeployDirs += (Join-Path $steamGame "BepInEx\plugins")
}

# Optional override: $env:SULTAN_GAME_DIR = "C:\path\to\Sultan's Game"
if ($env:SULTAN_GAME_DIR -and (Test-Path -LiteralPath $env:SULTAN_GAME_DIR)) {
  $DeployDirs += (Join-Path $env:SULTAN_GAME_DIR "BepInEx\plugins")
}

$DeployDirs = $DeployDirs | Select-Object -Unique

# Read-only detection: if a Steam install already carries a loader, do NOT write
# to it automatically (repo copy stays the default target); print a sync hint.
$SteamMirror = $null
foreach ($steamRoot in @("D:\SteamLibrary", "D:\Steam", "C:\Program Files (x86)\Steam", "C:\Program Files\Steam")) {
  if ($SteamMirror) { break }
  $candidate = Join-Path $steamRoot "steamapps\common\Sultan's Game"
  if (-not (Test-Path -LiteralPath (Join-Path $candidate "BepInEx"))) { continue }
  $alreadyDeployed = $DeployDirs | Where-Object { $_ -like "$candidate*" }
  if (-not $alreadyDeployed) { $SteamMirror = $candidate }
}

function Get-GameProcesses {
  Get-Process -Name "Sultan's Game" -ErrorAction SilentlyContinue
}

function Test-FileLocked([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  try {
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    $stream.Close()
    return $false
  } catch {
    return $true
  }
}

function Wait-UntilGameClosed {
  while ($true) {
    $procs = @(Get-GameProcesses)
    $anyLocked = $false
    foreach ($dir in $DeployDirs) {
      $dll = Join-Path $dir $DllName
      if (Test-FileLocked $dll) { $anyLocked = $true }
    }
    if ($procs.Count -eq 0 -and -not $anyLocked) { return }

    Write-Host ""
    Write-Host "Cannot replace plugin DLL - game is running or file is locked." -ForegroundColor Yellow
    Write-Host "Quit Sultan's Game, then press Enter. Press Q to cancel." -ForegroundColor Cyan
    $answer = Read-Host
    if ($answer -match '^[Qq]$') { exit 1 }
  }
}

Write-Host "==> Building SultanObserver ($Config) ..." -ForegroundColor Cyan
dotnet build $Project -c $Config -p:SkipPluginCopy=true
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not (Test-Path -LiteralPath $BuiltDll)) {
  Write-Host "Missing build output: $BuiltDll" -ForegroundColor Red
  exit 1
}

Wait-UntilGameClosed

foreach ($PluginOutDir in $DeployDirs) {
  $GameRoot = Split-Path (Split-Path $PluginOutDir)
  if (-not (Test-Path -LiteralPath (Join-Path $GameRoot "BepInEx"))) {
    Write-Host "Skip (no BepInEx yet): $PluginOutDir" -ForegroundColor DarkYellow
    continue
  }
  if (-not (Test-Path -LiteralPath (Join-Path $GameRoot "BepInEx\core\BepInEx.Unity.IL2CPP.dll"))) {
    Write-Host "WARNING: $GameRoot has no BepInEx 6 IL2CPP runtime (BepInEx\core\BepInEx.Unity.IL2CPP.dll is missing)." -ForegroundColor Yellow
    Write-Host "         Extract the bundled loader into that folder first:" -ForegroundColor Yellow
    Write-Host "           Expand-Archive '$RepoRoot\refs\BepInEx-Unity.IL2CPP-6.0.0-be.785.zip' -DestinationPath '$GameRoot' -Force" -ForegroundColor Yellow
    Write-Host "         Then launch the game once (generates BepInEx\interop\*.dll) and run this script again." -ForegroundColor Yellow
  }
  New-Item -ItemType Directory -Force -Path $PluginOutDir | Out-Null
  Copy-Item -LiteralPath $BuiltDll -Destination (Join-Path $PluginOutDir $DllName) -Force
  if (Test-Path -LiteralPath $JsonDll) {
    Copy-Item -LiteralPath $JsonDll -Destination (Join-Path $PluginOutDir "Newtonsoft.Json.dll") -Force
  }
  Write-Host "Deployed: $(Join-Path $PluginOutDir $DllName)" -ForegroundColor Green
}

$HasInterop = $false
foreach ($PluginOutDir in $DeployDirs) {
  $GameRoot = Split-Path (Split-Path $PluginOutDir)
  if (Test-Path -LiteralPath (Join-Path $GameRoot "BepInEx\interop\UnityEngine.CoreModule.dll")) { $HasInterop = $true }
}
if (-not $HasInterop) {
  Write-Host ""
  Write-Host "NOTE: no BepInEx\interop found, so this build used the compile-time Unity stubs." -ForegroundColor Yellow
  Write-Host "      It loads and serves /health, but game bindings are compiled out (GAME_INTEROP=false)." -ForegroundColor Yellow
  Write-Host "      After the first game launch generates interop, run deploy.ps1 again for the full build." -ForegroundColor Yellow
}

Write-Host ""
if ($SteamMirror) {
  Write-Host "A Steam install already has a loader: $SteamMirror" -ForegroundColor Cyan
  Write-Host "  To sync this build there when you play via Steam:" -ForegroundColor Cyan
  Write-Host "    `$env:SULTAN_GAME_DIR='$SteamMirror'; .\deploy.ps1" -ForegroundColor Cyan
  Write-Host "  If Steam launches that install instead of the repo copy, mirror the loader files into it first (refs/PITFALLS.md section 6)." -ForegroundColor DarkCyan
}
Write-Host "Start the game, then: curl http://127.0.0.1:17890/health"
