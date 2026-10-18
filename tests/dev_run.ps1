# Tests only: rebuild the debug app and start it on a fresh test profile with DevTools on port 9333.
param([string]$Home2 = "$env:TEMP\sl_ui_dev")
$ErrorActionPreference = 'Continue'
Get-Process stitchline -ErrorAction SilentlyContinue | Stop-Process -Force
Set-Location (Split-Path $PSScriptRoot)
$winlibs = (Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Directory -Filter 'BrechtSanders.WinLibs*' | Select-Object -First 1).FullName + '\mingw64\bin'
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH;$winlibs"
$env:CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = "$env:USERPROFILE\.rustup\toolchains\stable-x86_64-pc-windows-gnu\lib\rustlib\x86_64-pc-windows-gnu\bin\self-contained\x86_64-w64-mingw32-gcc.exe"
cargo build -p stitchline 2>&1 | Select-String -Pattern '^error|Finished' | Select-Object -Last 3
Remove-Item -Recurse -Force $Home2 -ErrorAction SilentlyContinue
$env:STITCHLINE_HOME = $Home2; $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9333'
Start-Process (Join-Path (Get-Location) 'target\debug\stitchline.exe')
Start-Sleep 6
"running: $((Get-Process stitchline -ErrorAction SilentlyContinue).Count)"
