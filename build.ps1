# Build the Stitchline installer (NSIS, per-user, no admin needed).
#   powershell -ExecutionPolicy Bypass -File build.ps1          -> target\release\bundle\nsis\Stitchline_<version>_x64-setup.exe
#   powershell -ExecutionPolicy Bypass -File build.ps1 -Test    -> run the engine tests and the Python comparison first
#
# Toolchain: Rust stable-x86_64-pc-windows-gnu (rustup) and Node.js. The GNU toolchain needs MinGW binutils
# (as, dlltool, windres) on PATH: winget install BrechtSanders.WinLibs.POSIX.MSVCRT --scope user
# Linking uses Rust's own bundled gcc, so MinGW's default manifest does not replace Tauri's.
param([switch]$Test)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$cargo = Join-Path $env:USERPROFILE '.cargo\bin'
$selfContained = Join-Path $env:USERPROFILE '.rustup\toolchains\stable-x86_64-pc-windows-gnu\lib\rustlib\x86_64-pc-windows-gnu\bin\self-contained'
$winlibs = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages') -Directory -Filter 'BrechtSanders.WinLibs*' -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName 'mingw64\bin' } | Where-Object { Test-Path (Join-Path $_ 'windres.exe') } | Select-Object -First 1
if (-not $winlibs) { throw 'MinGW binutils not found: winget install BrechtSanders.WinLibs.POSIX.MSVCRT --scope user' }

$env:PATH = "$cargo;$env:PATH;$winlibs"
$env:CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = Join-Path $selfContained 'x86_64-w64-mingw32-gcc.exe'

if ($Test) {
    $env:CARGO_TARGET_DIR = Join-Path $PSScriptRoot 'target\engine'
    cargo test -p stitchline-engine; if ($LASTEXITCODE) { throw 'engine tests failed' }
    cargo build -p stitchline-engine --bin stitchline-cli; if ($LASTEXITCODE) { throw 'cli build failed' }
    python tests\compare_with_python.py; if ($LASTEXITCODE) { throw 'Rust and Python differ' }
    Remove-Item Env:\CARGO_TARGET_DIR
}

if (-not (Test-Path node_modules)) { npm install --no-audit --no-fund }
npx tauri build
if ($LASTEXITCODE) { throw 'tauri build failed' }
Get-ChildItem target\release\bundle\nsis\*.exe | ForEach-Object { '{0}  {1:N1} MB' -f $_.FullName, ($_.Length / 1MB) }
