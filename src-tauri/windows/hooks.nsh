; Stitchline installer hooks (tauri.conf.json > bundle.windows.nsis.installerHooks).
; The file association itself comes from bundle.fileAssociations; Tauri gives it the app's own icon, so the
; project files get their document icon (project.ico, installed next to the exe) here.

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\Stitchline.Project\DefaultIcon" "" "$INSTDIR\project.ico"
  ; an earlier "Open with > Stitchline" choice keeps the app icon: drop it so the project icon shows
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.stitchline\UserChoice" "ProgId"
  StrCmp $R0 "Applications\stitchline.exe" 0 +2
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.stitchline\UserChoice"
  StrCmp $R0 "stitchline_auto_file" 0 +2
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.stitchline\UserChoice"
  ; Explorer redraws the file icons
  System::Call "shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)"
!macroend
