# Keep a desktop copy of Stitchline on the latest code.
#   powershell -ExecutionPolicy Bypass -File tools\update-desktop.ps1 -Install   once: desktop shortcut, then a first build
#   powershell -ExecutionPolicy Bypass -File tools\update-desktop.ps1            build now and replace the desktop copy
# It runs only when asked (there is no git hook): build the desktop copy by hand when you want it.
# The copy lives in target\desktop\Stitchline.exe; progress and errors go to target\desktop\update.log. A copy that is open while it updates keeps running; the new
# build starts the next time it is opened.
param([switch]$Install)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
Set-Location $root
$dir = Join-Path $root 'target\desktop'
$exe = Join-Path $dir 'Stitchline.exe'
$log = Join-Path $dir 'update.log'
$lock = Join-Path $dir 'update.lock'
New-Item -ItemType Directory -Force $dir | Out-Null
function Log($m) { Add-Content -Path $log -Value ('{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $m) -Encoding utf8 }

# .stitchline project files open in the desktop copy and show the project icon, like the installer does
# (src-tauri\windows\hooks.nsh); an installed Stitchline keeps them, and so does a copy built in a git worktree
function Register-Projects {
    if ((git rev-parse --git-dir) -ne (git rev-parse --git-common-dir)) { return }
    $cls = 'HKCU:\Software\Classes\Stitchline.Project'
    $cmd = (Get-ItemProperty "$cls\shell\open\command" -ErrorAction SilentlyContinue).'(default)'
    if ($cmd -and $cmd -notlike "*$exe*" -and $cmd -match '^"?([^"]+\.exe)' -and (Test-Path $Matches[1])) { return }
    New-Item -Force "$cls\DefaultIcon" | Out-Null
    New-Item -Force "$cls\shell\open\command" | Out-Null
    Set-ItemProperty $cls '(default)' 'Stitchline project'
    Set-ItemProperty "$cls\DefaultIcon" '(default)' (Join-Path $dir 'project.ico')
    Set-ItemProperty "$cls\shell\open\command" '(default)' "`"$exe`" `"%1`""
    New-Item -Force 'HKCU:\Software\Classes\.stitchline' | Out-Null
    Set-ItemProperty 'HKCU:\Software\Classes\.stitchline' '(default)' 'Stitchline.Project'
    # an earlier "Open with > Stitchline" choice keeps the app icon
    # (Windows denies setting values there, which makes Remove-Item fail; deleting the key itself is allowed)
    $uc = 'Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.stitchline\UserChoice'
    if ((Get-ItemProperty "HKCU:\$uc" -ErrorAction SilentlyContinue).ProgId -in 'Applications\Stitchline.exe', 'stitchline_auto_file') {
        try { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($uc, $false) } catch { Log "could not reset the Open with choice for .stitchline: $_" }
    }
    Add-Type -Namespace Win32 -Name Shell -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int e, int f, IntPtr a, IntPtr b);' -ErrorAction SilentlyContinue
    [Win32.Shell]::SHChangeNotify(0x08000000, 0x1000, [IntPtr]::Zero, [IntPtr]::Zero)
}

if ($Install) {
    # desktop shortcut to the copy (its icon comes from the exe)
    # WScript.Shell cannot save a shortcut with an Arabic name: save it with a plain name, then rename it
    $desk = [Environment]::GetFolderPath('Desktop')
    $lnk = Join-Path $desk 'Stitchline (أحدث نسخة).lnk'
    $tmp = Join-Path $desk 'Stitchline-latest.lnk'
    $s = (New-Object -ComObject WScript.Shell).CreateShortcut($tmp)
    $s.TargetPath = $exe; $s.WorkingDirectory = $dir; $s.Description = 'Stitchline: the latest build of this repository'
    $s.Save()
    Move-Item $tmp $lnk -Force
    Log "installed shortcut $lnk"
}

# one build at a time: a newer commit during a build is picked up by the loop below
if (Test-Path $lock) {
    $other = Get-Content $lock -ErrorAction SilentlyContinue
    if ($other -and (Get-Process -Id $other -ErrorAction SilentlyContinue)) { Log "a build is already running (pid $other); it will pick up this commit"; exit 0 }
}
Set-Content $lock $PID
try {
    # the same toolchain as build.ps1
    $cargo = Join-Path $env:USERPROFILE '.cargo\bin'
    $selfContained = Join-Path $env:USERPROFILE '.rustup\toolchains\stable-x86_64-pc-windows-gnu\lib\rustlib\x86_64-pc-windows-gnu\bin\self-contained'
    $winlibs = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages') -Directory -Filter 'BrechtSanders.WinLibs*' -ErrorAction SilentlyContinue |
        ForEach-Object { Join-Path $_.FullName 'mingw64\bin' } | Where-Object { Test-Path (Join-Path $_ 'windres.exe') } | Select-Object -First 1
    if (-not $winlibs) { throw 'MinGW binutils not found: winget install BrechtSanders.WinLibs.POSIX.MSVCRT --scope user' }
    $env:PATH = "$cargo;$env:PATH;$winlibs"
    $env:CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = Join-Path $selfContained 'x86_64-w64-mingw32-gcc.exe'
    if (-not (Test-Path node_modules/@ark-ui/react)) { npm install --no-audit --no-fund 2>&1 | Out-Null }

    $built = $null
    while ($true) {
        $head = (git rev-parse --short HEAD).Trim()
        if ($head -eq $built) { break }
        Log "building $head ($((git branch --show-current).Trim()))"
        # through cmd: cargo reports progress on stderr, which Windows PowerShell would turn into errors
        $buildLog = Join-Path $dir 'build.log'
        cmd /c "npx tauri build --no-bundle > `"$buildLog`" 2>&1"
        if ($LASTEXITCODE) { Log "BUILD FAILED for ${head} (see build.log):`n$((Get-Content $buildLog -Tail 15) -join "`n")"; throw "build failed for $head" }
        # a running exe cannot be overwritten but can be renamed: move it aside, then put the new one in place
        $old = "$exe.old"
        Remove-Item $old -Force -ErrorAction SilentlyContinue
        if (Test-Path $exe) { Move-Item $exe $old -Force }
        Copy-Item (Join-Path $root 'target\release\stitchline.exe') $exe -Force
        # the app loads WebView2Loader.dll from its own folder (the installer puts it there too)
        foreach ($dll in Get-ChildItem (Join-Path $root 'target\release') -File -Filter *.dll) {
            $to = Join-Path $dir $dll.Name
            if ((Test-Path $to) -and (Get-FileHash $to).Hash -eq (Get-FileHash $dll.FullName).Hash) { continue }
            Remove-Item "$to.old" -Force -ErrorAction SilentlyContinue
            if (Test-Path $to) { Move-Item $to "$to.old" -Force }
            Copy-Item $dll.FullName $to -Force
        }
        Copy-Item (Join-Path $root 'src-tauri\icons\project.ico') (Join-Path $dir 'project.ico') -Force
        Register-Projects
        Set-Content (Join-Path $dir 'version.txt') "$head  $(git log -1 --format='%ci  %s' $head)" -Encoding utf8
        Log "desktop copy updated to $head"
        $built = $head
    }
} catch {
    Log "ERROR: $_"
    exit 1
} finally {
    Remove-Item $lock -Force -ErrorAction SilentlyContinue
}
