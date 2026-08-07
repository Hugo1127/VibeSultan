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
    Write-Host "Cannot replace plugin DLL — game is running or file is locked." -ForegroundColor Yellow
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
  if (-not (Test-Path -LiteralPath (Split-Path $PluginOutDir))) {
    Write-Host "Skip (no BepInEx yet): $PluginOutDir" -ForegroundColor DarkYellow
    continue
  }
  New-Item -ItemType Directory -Force -Path $PluginOutDir | Out-Null
  Copy-Item -LiteralPath $BuiltDll -Destination (Join-Path $PluginOutDir $DllName) -Force
  if (Test-Path -LiteralPath $JsonDll) {
    Copy-Item -LiteralPath $JsonDll -Destination (Join-Path $PluginOutDir "Newtonsoft.Json.dll") -Force
  }
  Write-Host "Deployed: $(Join-Path $PluginOutDir $DllName)" -ForegroundColor Green
}

Write-Host ""
Write-Host "IMPORTANT: Steam launches D:\SteamLibrary\...\Sultan's Game, not the repo copy." -ForegroundColor Cyan
Write-Host "Start the game from Steam, then: curl http://127.0.0.1:17890/health"
