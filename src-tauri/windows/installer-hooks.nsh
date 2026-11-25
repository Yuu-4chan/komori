; Komori's hooks into Tauri's NSIS installer.
;
; Up to 2.1.0 the publisher was "Yuu-4chan", and the installer keeps the install folder under
; HKCU\Software\<publisher>\Komori. Under the publisher "Komori" an installer would no longer find
; an earlier install's folder: it would install a second copy in the default folder, and its
; "uninstall before installing" step would run the old uninstaller without a folder. Before any
; page shows, the earlier folder is carried over to the new key; after installing, the old key goes.
;
; It also offers Komori in Explorer's Open with for EPUBs (the Komori.EPUB file class, listed under
; .epub\OpenWithProgids). Which app opens an EPUB stays the reader's choice: the installer never
; sets the .epub default, so it has nothing to put back.

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

!define KOMORI_EPUB_CLASS "Komori.EPUB"

!macro NSIS_HOOK_POSTINSTALL
  DeleteRegKey HKCU "Software\Yuu-4chan\Komori"
  DeleteRegKey /ifempty HKCU "Software\Yuu-4chan"
  WriteRegStr HKCU "Software\Classes\${KOMORI_EPUB_CLASS}" "" "EPUB book"
  WriteRegStr HKCU "Software\Classes\${KOMORI_EPUB_CLASS}\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr HKCU "Software\Classes\${KOMORI_EPUB_CLASS}\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\.epub\OpenWithProgids" "${KOMORI_EPUB_CLASS}" ""
  ; SHCNE_ASSOCCHANGED: Explorer reads the associations again.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

; An update keeps the association; uninstalling removes Komori's file class and its Open with
; entry, and leaves other apps' entries and the .epub default as they are.
!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Classes\.epub\OpenWithProgids" "${KOMORI_EPUB_CLASS}"
    DeleteRegKey HKCU "Software\Classes\${KOMORI_EPUB_CLASS}"
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${EndIf}
!macroend
