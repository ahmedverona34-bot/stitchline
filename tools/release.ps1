# Publish a Stitchline update: build the signed installer and put it on GitHub Releases, where the app's
# Update button finds it (tauri.conf.json > plugins.updater reads releases/latest/download/latest.json).
#   powershell -ExecutionPolicy Bypass -File tools\release.ps1 -Version 1.0.2       1. set the new version, then commit and push
#   powershell -ExecutionPolicy Bypass -File tools\release.ps1 -Notes "What changed"  2. build and publish that version
# Add -Draft to step 2 to check the release on GitHub before publishing it there.
# Needs: gh (logged in) and the signing key %USERPROFILE%\.tauri\stitchline.key. Keep a copy of that key: without it no
# installed Stitchline accepts a new version.
param([string]$Version, [string]$Notes = '', [switch]$Draft)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
Set-Location $root
$repo = 'ahmedverona34-bot/stitchline'
$conf = Join-Path $root 'src-tauri\tauri.conf.json'
$utf8 = New-Object System.Text.UTF8Encoding $false

if ($Version) {
    if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version must look like 1.0.2, not $Version" }
    $edit = @{
        $conf                                   = '(?m)^(  "version": )"[^"]+"'
        (Join-Path $root 'package.json')        = '(?m)^(  "version": )"[^"]+"'
        (Join-Path $root 'src-tauri\Cargo.toml') = '(?m)^(version = )"[^"]+"'
    }
    foreach ($f in $edit.Keys) {
        $t = [IO.File]::ReadAllText($f)
        [IO.File]::WriteAllText($f, ([regex]$edit[$f]).Replace($t, "`$1`"$Version`"", 1), $utf8)
    }
    "Version set to ${Version}: commit and push, then run tools\release.ps1 -Notes `"What changed`""
    exit 0
}
$ver = (Get-Content $conf -Raw | ConvertFrom-Json).version
$tag = "v$ver"
# the release points at this commit, so it must be complete and on GitHub
if (git status --porcelain --untracked-files=no) { throw 'There are uncommitted changes: commit and git push first' }
cmd /c 'git fetch -q origin 2>&1' | Out-Null
if (-not (git branch -r --contains HEAD)) { throw 'This commit is not on GitHub yet: commit and git push first' }
# through cmd: Windows PowerShell turns a native command's stderr into errors
if ((cmd /c "gh release view $tag --repo $repo >nul 2>&1 && echo yes") -eq 'yes') { throw "Release $tag is already on GitHub: pick a new -Version" }

$key = Join-Path $env:USERPROFILE '.tauri\stitchline.key'
if (-not (Test-Path $key)) { throw "Signing key not found: $key" }
$env:TAURI_SIGNING_PRIVATE_KEY = [IO.File]::ReadAllText($key).Trim()
$env:CI = 'true'   # never stop to ask for the key's password (it has none)

Get-ChildItem (Join-Path $root 'target\release\bundle\nsis') -ErrorAction SilentlyContinue | Remove-Item -Force
& (Join-Path $root 'build.ps1')
$setup = Join-Path $root "target\release\bundle\nsis\Stitchline_${ver}_x64-setup.exe"
if (-not (Test-Path "$setup.sig")) { throw "The build made no signature ($setup.sig)" }

# what the app reads to know there is a new version
$latest = Join-Path $root 'target\release\bundle\nsis\latest.json'
$name = Split-Path $setup -Leaf
$manifest = [ordered]@{
    version   = $ver
    notes     = $Notes
    pub_date  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    platforms = [ordered]@{
        'windows-x86_64' = [ordered]@{
            signature = [IO.File]::ReadAllText("$setup.sig").Trim()
            url       = "https://github.com/$repo/releases/download/$tag/$name"
        }
    }
}
[IO.File]::WriteAllText($latest, ($manifest | ConvertTo-Json -Depth 5), $utf8)

$ghArgs = @($tag, $setup, $latest, '--repo', $repo, '--title', "Stitchline $ver", '--notes', $(if ($Notes) { $Notes } else { "Stitchline $ver" }), '--target', (git rev-parse HEAD).Trim())
if ($Draft) { $ghArgs += '--draft' }
gh release create @ghArgs
if ($LASTEXITCODE) { throw 'gh release create failed' }
"Published ${tag}: https://github.com/$repo/releases/tag/$tag"
