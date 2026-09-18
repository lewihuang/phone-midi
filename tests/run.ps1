# Runs the offline verification suite. No phone, no DAW, no network.
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$fail = 0

Write-Host "`n=== vibrato.test.mjs (DSP) ===" -ForegroundColor Cyan
node "$here/vibrato.test.mjs"
if ($LASTEXITCODE -ne 0) { $fail++ }

Write-Host "`n=== bridge_protocol_check.py (Bridge protocol) ===" -ForegroundColor Cyan
python "$here/bridge_protocol_check.py"
if ($LASTEXITCODE -ne 0) { $fail++ }

Write-Host "`n=== bridge_boot_check.py (starts the real bridge) ===" -ForegroundColor Cyan
python "$here/bridge_boot_check.py"
if ($LASTEXITCODE -ne 0) { $fail++ }

Write-Host "`n=== pages_smoke.mjs (page wiring) ===" -ForegroundColor Cyan
node "$here/pages_smoke.mjs"
if ($LASTEXITCODE -ne 0) { $fail++ }

if ($fail) { Write-Host "`n$fail suite(s) FAILED" -ForegroundColor Red; exit 1 }
Write-Host "`nall suites passed" -ForegroundColor Green
