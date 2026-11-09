; Komori's hooks into Tauri's NSIS installer.
;
; Up to 2.1.0 the publisher was "Yuu-4chan", and the installer keeps the install folder under
; HKCU\Software\<publisher>\Komori. Under the publisher "Komori" an installer would no longer find
; an earlier install's folder: it would install a second copy in the default folder, and its
; "uninstall before installing" step would run the old uninstaller without a folder. Before any
; page shows, the earlier folder is carried over to the new key; after installing, the old key goes.

!include LogicLib.nsh

!define MUI_CUSTOMFUNCTION_GUIINIT KomoriAdoptLegacyInstall

Function KomoriAdoptLegacyInstall
  Push $0
  ReadRegStr $0 HKCU "Software\Komori\Komori" ""
  ${If} $0 == ""
    ReadRegStr $0 HKCU "Software\Yuu-4chan\Komori" ""
    ${If} $0 != ""
      WriteRegStr HKCU "Software\Komori\Komori" "" $0
      StrCpy $INSTDIR $0
    ${EndIf}
  ${EndIf}
  Pop $0
FunctionEnd

!macro NSIS_HOOK_POSTINSTALL
  DeleteRegKey HKCU "Software\Yuu-4chan\Komori"
  DeleteRegKey /ifempty HKCU "Software\Yuu-4chan"
!macroend
