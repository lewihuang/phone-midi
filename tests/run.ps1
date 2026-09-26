# Runs the offline verification suite. No phone, no DAW, no network.
$ErrorActionPreference = 'Continue'
# Some checks print Chinese; a GBK console would raise UnicodeEncodeError mid-run and look
# like a failure that never happened.
$env:PYTHONIOENCODING = 'utf-8'
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

Write-Host "`n=== bridge_ui_check.py (compact monitor window) ===" -ForegroundColor Cyan
python "$here/bridge_ui_check.py"
if ($LASTEXITCODE -ne 0) { $fail++ }

Write-Host "`n=== bridge_pad_check.py (shortcut pad) ===" -ForegroundColor Cyan
python "$here/bridge_pad_check.py"
if ($LASTEXITCODE -ne 0) { $fail++ }

Write-Host "`n=== bridge_xy_check.py (X/Y pad) ===" -ForegroundColor Cyan
python "$here/bridge_xy_check.py"
if ($LASTEXITCODE -ne 0) { $fail++ }

Write-Host "`n=== pages_smoke.mjs (page wiring) ===" -ForegroundColor Cyan
node "$here/pages_smoke.mjs"
if ($LASTEXITCODE -ne 0) { $fail++ }

Write-Host "`n=== mode_b_latency.test.mjs (Mode B has no lag) ===" -ForegroundColor Cyan
node "$here/mode_b_latency.test.mjs"
if ($LASTEXITCODE -ne 0) { $fail++ }

Write-Host "`n=== exe_web_check.py (packaged web/ snapshot) ===" -ForegroundColor Cyan
python "$here/exe_web_check.py"
if ($LASTEXITCODE -ne 0) { $fail++ }

if ($fail) { Write-Host "`n$fail suite(s) FAILED" -ForegroundColor Red; exit 1 }
Write-Host "`nall suites passed" -ForegroundColor Green
