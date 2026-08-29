# ARIA engine installer - Windows.
#
# Usage (PowerShell):
#   irm https://aria-telegram-bot-app-production.up.railway.app/install.ps1 | iex
#
# Downloads the current released aria-engine bundle from this exact
# host (never a third-party mirror), verifies its sha256 against the
# published manifest, and installs it as a global `aria` command via
# `npm install -g` - no git clone, no manual npm/tsx setup, no .env
# editing. Requires Node.js >= 22.13.0 to already be present; this
# script does not install Node itself (silently modifying a user's
# system Node installation is out of scope for an engine installer).

$ErrorActionPreference = "Stop"
$BaseUrl = "https://aria-telegram-bot-app-production.up.railway.app"

Write-Host "ARIA engine installer"
Write-Host ""

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Error "Node.js was not found on PATH. Install Node.js 22.13.0 or newer from https://nodejs.org/ and re-run this installer."
    exit 1
}

$nodeVersion = (& node -e "console.log(process.versions.node)").Trim()
$parts = $nodeVersion.Split(".")
$major = [int]$parts[0]
$minor = [int]$parts[1]
if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 13)) {
    Write-Error "Node.js $nodeVersion was found, but ARIA requires >= 22.13.0. Install a newer Node.js from https://nodejs.org/ and re-run this installer."
    exit 1
}
Write-Host "Node.js $nodeVersion found - OK"

$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) {
    Write-Error "npm was not found on PATH (it normally ships with Node.js). Reinstall Node.js from https://nodejs.org/ and re-run."
    exit 1
}

$workDir = Join-Path $env:TEMP ("aria-install-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $workDir | Out-Null
try {
    Write-Host "Fetching release manifest..."
    $manifestPath = Join-Path $workDir "latest.json"
    Invoke-WebRequest -Uri "$BaseUrl/downloads/latest.json" -OutFile $manifestPath -UseBasicParsing
    $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
    Write-Host "Latest version: $($manifest.version)"

    $tarballPath = Join-Path $workDir $manifest.filename
    Write-Host "Downloading $($manifest.filename)..."
    Invoke-WebRequest -Uri "$BaseUrl/downloads/$($manifest.filename)" -OutFile $tarballPath -UseBasicParsing

    Write-Host "Verifying checksum..."
    $actualHash = (Get-FileHash -Path $tarballPath -Algorithm SHA256).Hash.ToLower()
    $expectedHash = $manifest.sha256.ToLower()
    if ($actualHash -ne $expectedHash) {
        Write-Error "Checksum mismatch! Expected $expectedHash, got $actualHash. The download may be corrupted or tampered with. Aborting - nothing was installed."
        exit 1
    }
    Write-Host "Checksum verified - OK"

    Write-Host "Installing ARIA globally (npm install -g)..."
    & npm install -g $tarballPath
    if ($LASTEXITCODE -ne 0) {
        Write-Error "npm install -g failed with exit code $LASTEXITCODE."
        exit 1
    }

    Write-Host ""
    Write-Host "ARIA $($manifest.version) installed."
    Write-Host "Next steps:"
    Write-Host "  aria doctor           # check your setup"
    Write-Host "  aria pair <CODE>      # pair with your Telegram account (get a code from the ARIA Mini App)"
    Write-Host "  aria paper start      # start the paper trading engine"
} finally {
    Remove-Item -Recurse -Force $workDir -ErrorAction SilentlyContinue
}
