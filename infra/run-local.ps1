# Foresight Security — start the local LiveKit dev server (Windows).
#
# Prereq (no Docker needed): download the native binary from
#   https://github.com/livekit/livekit/releases  (livekit_<ver>_windows_amd64.zip)
# unzip it, and put livekit-server.exe on your PATH (or in this folder).

$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Get-Command livekit-server -ErrorAction SilentlyContinue)) {
    Write-Error "livekit-server.exe not found. Download it from https://github.com/livekit/livekit/releases and add it to your PATH."
    exit 1
}

Write-Host "Point your iPhones / clients at:  ws://<LAN-IP>:7880"
Write-Host "  This machine's LAN IPv4 address(es):"
Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
    Select-Object -ExpandProperty IPAddress |
    ForEach-Object { Write-Host "    $_" }
Write-Host ""

livekit-server --config "$dir\livekit.yaml"
