#Requires -Version 5.1
<#
.SYNOPSIS
    Svatantra CT Dashboard — Windows Deployment Script

.DESCRIPTION
    Sets up and runs the CT Dashboard as a persistent Windows Service using NSSM.
    Works on Windows 10 / Windows 11 / Windows Server 2016+.
    Run once for fresh install; re-run to update/redeploy.

.PARAMETER Port
    Port the app will listen on. Default: 3000

.PARAMETER ServiceName
    Windows service name. Default: CTDashboard

.PARAMETER InstallDir
    Where to install the app. Default: same directory as this script.

.EXAMPLE
    # Run from an elevated PowerShell prompt:
    Set-ExecutionPolicy Bypass -Scope Process -Force
    .\deploy.ps1

    # Custom port:
    .\deploy.ps1 -Port 8080
#>

param(
    [int]    $Port        = 3000,
    [string] $ServiceName = "CTDashboard",
    [string] $InstallDir  = $PSScriptRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Colour helpers ─────────────────────────────────────────────────────────────
function Write-Header { param($msg) Write-Host "`n▶  $msg" -ForegroundColor Cyan }
function Write-Info   { param($msg) Write-Host "[INFO]  $msg" -ForegroundColor Blue }
function Write-Ok     { param($msg) Write-Host "[OK]    $msg" -ForegroundColor Green }
function Write-Warn   { param($msg) Write-Host "[WARN]  $msg" -ForegroundColor Yellow }
function Write-Fail   { param($msg) Write-Host "[ERROR] $msg" -ForegroundColor Red; exit 1 }

# ── Admin check ────────────────────────────────────────────────────────────────
$currentPrincipal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Fail "Please run this script from an elevated (Administrator) PowerShell prompt."
}

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║   Svatantra CT Dashboard — Windows Deployment Script     ║" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Info "App directory : $InstallDir"
Write-Info "Port          : $Port"
Write-Info "Service name  : $ServiceName"

# ── Helpers ────────────────────────────────────────────────────────────────────
function Test-CommandExists { param($cmd) return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

function Invoke-Step {
    param([string]$title, [scriptblock]$block)
    Write-Header $title
    try { & $block } catch { Write-Fail "Step failed: $_" }
}

# ── Step 1: Node.js ────────────────────────────────────────────────────────────
Invoke-Step "Step 1 — Node.js" {
    if (Test-CommandExists node) {
        $ver = (node -e "console.log(process.versions.node)")
        $major = [int]($ver.Split('.')[0])
        if ($major -ge 18) {
            Write-Ok "Node.js v$ver already installed — skipping."
        } else {
            Write-Warn "Node.js v$ver is too old (need >=18). Attempting upgrade…"
            throw "Please install Node.js 20 LTS from https://nodejs.org and re-run this script."
        }
    } else {
        Write-Info "Node.js not found. Attempting install via winget…"
        if (Test-CommandExists winget) {
            winget install --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent
            # Refresh PATH in the current session
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                        [System.Environment]::GetEnvironmentVariable("Path","User")
            if (Test-CommandExists node) {
                Write-Ok "Node.js $(node -v) installed via winget."
            } else {
                throw "winget install succeeded but node.exe not found in PATH. Please open a new PowerShell window and re-run."
            }
        } else {
            Write-Warn "winget not available."
            throw "Please install Node.js 20 LTS manually from https://nodejs.org/en/download/ then re-run this script."
        }
    }
}

# ── Step 2: npm install ────────────────────────────────────────────────────────
Invoke-Step "Step 2 — npm install" {
    Push-Location $InstallDir
    try {
        Write-Info "Running npm install…"
        npm install --omit=dev --no-audit --no-fund 2>&1 | Where-Object { $_ -notmatch "^npm warn" } | Write-Host
        Write-Ok "Dependencies installed."
    } finally {
        Pop-Location
    }
}

# ── Step 3: data + logs directories ───────────────────────────────────────────
Invoke-Step "Step 3 — Directories" {
    $dirs = @("$InstallDir\data", "$InstallDir\logs")
    foreach ($d in $dirs) {
        if (-not (Test-Path $d)) {
            New-Item -ItemType Directory -Path $d | Out-Null
            Write-Ok "Created: $d"
        } else {
            Write-Info "Exists: $d"
        }
    }
}

# ── Step 4: Get / install NSSM ────────────────────────────────────────────────
Invoke-Step "Step 4 — NSSM (service manager)" {
    $NssmDir  = "$InstallDir\tools\nssm"
    $NssmExe  = "$NssmDir\nssm.exe"
    $NssmZip  = "$env:TEMP\nssm.zip"
    $NssmUrl  = "https://nssm.cc/release/nssm-2.24.zip"

    if (Test-Path $NssmExe) {
        Write-Ok "NSSM already present at $NssmExe — skipping download."
    } else {
        Write-Info "Downloading NSSM from $NssmUrl …"
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -Uri $NssmUrl -OutFile $NssmZip -UseBasicParsing -TimeoutSec 30
        } catch {
            Write-Warn "Could not download NSSM: $_"
            Write-Warn "Falling back to Task Scheduler method (less reliable restart-on-crash)."
            $script:UseTaskScheduler = $true
            return
        }

        Write-Info "Extracting NSSM…"
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $zip = [System.IO.Compression.ZipFile]::OpenRead($NssmZip)
        New-Item -ItemType Directory -Force -Path $NssmDir | Out-Null

        # Extract the win64 nssm.exe
        $entry = $zip.Entries | Where-Object { $_.FullName -match "win64.nssm\.exe$" } | Select-Object -First 1
        if (-not $entry) {
            $entry = $zip.Entries | Where-Object { $_.Name -eq "nssm.exe" } | Select-Object -First 1
        }
        if (-not $entry) { $zip.Dispose(); throw "nssm.exe not found inside the zip." }

        $dest = [System.IO.File]::Open($NssmExe, [System.IO.FileMode]::Create)
        $stream = $entry.Open()
        $stream.CopyTo($dest)
        $dest.Close(); $stream.Close(); $zip.Dispose()
        Remove-Item $NssmZip -Force -ErrorAction SilentlyContinue

        Write-Ok "NSSM extracted to $NssmExe"
    }
    $script:NssmExe = $NssmExe
}

# ── Step 5: Stop existing service ─────────────────────────────────────────────
Invoke-Step "Step 5 — Stop existing service (if any)" {
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svc) {
        if ($svc.Status -eq 'Running') {
            Stop-Service -Name $ServiceName -Force
            Write-Ok "Stopped existing service '$ServiceName'."
        } else {
            Write-Info "Service '$ServiceName' exists but is not running."
        }
    } else {
        Write-Info "No existing service '$ServiceName' found."
    }
}

# ── Step 6: Register service ───────────────────────────────────────────────────
Invoke-Step "Step 6 — Register Windows service" {
    $NodeExe  = (Get-Command node).Source
    $AppArgs  = "server\index.js"
    $LogOut   = "$InstallDir\logs\stdout.log"
    $LogErr   = "$InstallDir\logs\stderr.log"

    if (-not $script:UseTaskScheduler) {
        # ── NSSM path ──
        $nssm = $script:NssmExe

        # Remove stale registration if exists
        $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($svc) {
            & $nssm remove $ServiceName confirm | Out-Null
            Start-Sleep -Seconds 2
        }

        & $nssm install      $ServiceName $NodeExe $AppArgs
        & $nssm set          $ServiceName AppDirectory  $InstallDir
        & $nssm set          $ServiceName AppStdout     $LogOut
        & $nssm set          $ServiceName AppStderr     $LogErr
        & $nssm set          $ServiceName AppRotateFiles 1
        & $nssm set          $ServiceName AppRotateBytes 10485760   # 10 MB
        & $nssm set          $ServiceName AppEnvironmentExtra "PORT=$Port" "NODE_ENV=production"
        & $nssm set          $ServiceName Start          SERVICE_AUTO_START
        & $nssm set          $ServiceName ObjectName     LocalSystem
        & $nssm set          $ServiceName DisplayName    "Svatantra CT Dashboard"
        & $nssm set          $ServiceName Description    "Center Quality daily summary dashboard"
        # Restart on failure: after 30s, 60s, 120s
        & $nssm set          $ServiceName AppThrottle    1500
        & $nssm set          $ServiceName AppExit        Default Restart

        Write-Ok "NSSM service '$ServiceName' registered."

    } else {
        # ── Task Scheduler fallback ──
        Write-Warn "Using Task Scheduler (NSSM unavailable)."

        $action    = New-ScheduledTaskAction `
                        -Execute $NodeExe `
                        -Argument $AppArgs `
                        -WorkingDirectory $InstallDir
        $trigger   = New-ScheduledTaskTrigger -AtStartup
        $settings  = New-ScheduledTaskSettingsSet `
                        -RestartCount 5 `
                        -RestartInterval (New-TimeSpan -Minutes 1) `
                        -ExecutionTimeLimit ([TimeSpan]::Zero)
        $principal = New-ScheduledTaskPrincipal `
                        -UserId "SYSTEM" `
                        -LogonType ServiceAccount `
                        -RunLevel Highest

        $env_block = [scriptblock]::Create("
            `$env:PORT = '$Port'
            `$env:NODE_ENV = 'production'
        ")

        Unregister-ScheduledTask -TaskName $ServiceName -Confirm:$false -ErrorAction SilentlyContinue
        Register-ScheduledTask `
            -TaskName  $ServiceName `
            -Action    $action `
            -Trigger   $trigger `
            -Settings  $settings `
            -Principal $principal `
            -Force | Out-Null

        Write-Ok "Task Scheduler task '$ServiceName' registered."
    }
}

# ── Step 7: Firewall rule ──────────────────────────────────────────────────────
Invoke-Step "Step 7 — Windows Firewall" {
    $ruleName = "CTDashboard-Port-$Port"
    $existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Info "Firewall rule '$ruleName' already exists — skipping."
    } else {
        New-NetFirewallRule `
            -DisplayName $ruleName `
            -Direction   Inbound `
            -Protocol    TCP `
            -LocalPort   $Port `
            -Action      Allow | Out-Null
        Write-Ok "Firewall rule created: allow inbound TCP $Port"
    }
}

# ── Step 8: Start service ──────────────────────────────────────────────────────
Invoke-Step "Step 8 — Start service" {
    if (-not $script:UseTaskScheduler) {
        Start-Service -Name $ServiceName
        Start-Sleep -Seconds 4
        $svc = Get-Service -Name $ServiceName
        if ($svc.Status -eq 'Running') {
            Write-Ok "Service '$ServiceName' is running."
        } else {
            Write-Warn "Service status: $($svc.Status). Check logs at $InstallDir\logs\"
        }
    } else {
        Start-ScheduledTask -TaskName $ServiceName
        Start-Sleep -Seconds 4
        $task = Get-ScheduledTask -TaskName $ServiceName
        Write-Ok "Task '$ServiceName' state: $($task.State)"
    }
}

# ── Step 9: Health check ───────────────────────────────────────────────────────
Invoke-Step "Step 9 — Health check" {
    Start-Sleep -Seconds 3
    try {
        $resp = Invoke-WebRequest -Uri "http://localhost:$Port/api/health" -UseBasicParsing -TimeoutSec 10
        if ($resp.StatusCode -eq 200) {
            Write-Ok "Health check passed — app is responding on port $Port."
        }
    } catch {
        Write-Warn "Health check failed. The service may still be starting."
        Write-Warn "Logs: $InstallDir\logs\stdout.log"
    }
}

# ── Done ───────────────────────────────────────────────────────────────────────
$ServerIP = (Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias '*Ethernet*','*Wi-Fi*' `
    -ErrorAction SilentlyContinue | Select-Object -First 1).IPAddress
if (-not $ServerIP) { $ServerIP = "localhost" }

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║  Deployment complete!                                    ║" -ForegroundColor Green
Write-Host "╠══════════════════════════════════════════════════════════╣" -ForegroundColor Green
Write-Host "║  Dashboard URL   :  http://${ServerIP}:${Port}" -ForegroundColor Green
Write-Host "║  Default login   :  admin  /  admin@123" -ForegroundColor Green
Write-Host "║  Change password :  node scripts\add-user.js --password admin" -ForegroundColor Green
Write-Host "║" -ForegroundColor Green
Write-Host "║  Useful commands:" -ForegroundColor Green
if (-not $script:UseTaskScheduler) {
    Write-Host "║    Status  →  Get-Service $ServiceName" -ForegroundColor Green
    Write-Host "║    Logs    →  Get-Content $InstallDir\logs\stdout.log -Tail 50" -ForegroundColor Green
    Write-Host "║    Restart →  Restart-Service $ServiceName" -ForegroundColor Green
    Write-Host "║    Stop    →  Stop-Service $ServiceName" -ForegroundColor Green
} else {
    Write-Host "║    Status  →  Get-ScheduledTask $ServiceName" -ForegroundColor Green
    Write-Host "║    Restart →  Stop-ScheduledTask $ServiceName; Start-ScheduledTask $ServiceName" -ForegroundColor Green
}
Write-Host "╚══════════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
