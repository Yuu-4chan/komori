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
; sets the .epub default, so it has nothing to put back. And it registers Komori's Explorer
; thumbnail handler; see KomoriRegisterThumbnails.

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
  ; This file is read before VERSION is defined; a macro's body only where it is inserted.
  StrCpy $KomoriThumbnailDll "${VERSION}"
  Call KomoriRegisterThumbnails
!macroend

; An update keeps the association and the thumbnail handler; uninstalling removes Komori's file
; class and its Open with entry, and leaves other apps' entries and the .epub default as they are.
!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Classes\.epub\OpenWithProgids" "${KOMORI_EPUB_CLASS}"
    DeleteRegKey HKCU "Software\Classes\${KOMORI_EPUB_CLASS}"
    Call un.KomoriUnregisterThumbnails
  ${EndIf}
!macroend

; Explorer shows an EPUB's cover as its thumbnail through komori-thumbnails.dll, registered for
; the current user. Windows takes one thumbnail handler per extension: another app's handler is
; kept beside Komori's class and put back when Komori is uninstalled, unless that app has since
; taken the extension back itself. Explorer's thumbnail process keeps the DLL it loaded open, so
; each install puts the DLL under a name of its own (version and install time) and never has to
; replace or keep a file in use; earlier ones no longer loaded are removed, and uninstalling has
; Windows remove a loaded one when it restarts.

!define KOMORI_THUMBNAIL_CLASS "{926c88c4-506e-429b-808f-17c2be6eea16}"
!define KOMORI_THUMBNAIL_CLASS_KEY "Software\Classes\CLSID\${KOMORI_THUMBNAIL_CLASS}"
!define KOMORI_THUMBNAIL_HANDLER_KEY "Software\Classes\.epub\ShellEx\{e357fccd-a995-4576-b01f-234630154e96}"
Var KomoriThumbnailDll

Function KomoriRegisterThumbnails
  Push $0
  Push $1
  Push $2
  ; $KomoriThumbnailDll holds the version; the install time makes the name this install's own.
  System::Call 'kernel32::GetTickCount() i .r0'
  StrCpy $KomoriThumbnailDll "komori-thumbnails-$KomoriThumbnailDll-$0.dll"
  ClearErrors
  Rename "$INSTDIR\komori-thumbnails.dll" "$INSTDIR\$KomoriThumbnailDll"
  ${If} ${Errors}
    StrCpy $KomoriThumbnailDll "komori-thumbnails.dll"
  ${EndIf}
  FindFirst $0 $1 "$INSTDIR\komori-thumbnails-*.dll"
  ${DoWhile} $1 != ""
    ${If} $1 != "$KomoriThumbnailDll"
      Delete "$INSTDIR\$1"
    ${EndIf}
    FindNext $0 $1
  ${Loop}
  FindClose $0

  ReadRegStr $2 HKCU "${KOMORI_THUMBNAIL_CLASS_KEY}" "PreviousHandler"
  WriteRegStr HKCU "${KOMORI_THUMBNAIL_CLASS_KEY}" "" "Komori EPUB thumbnails"
  WriteRegStr HKCU "${KOMORI_THUMBNAIL_CLASS_KEY}\InprocServer32" "" "$INSTDIR\$KomoriThumbnailDll"
  WriteRegStr HKCU "${KOMORI_THUMBNAIL_CLASS_KEY}\InprocServer32" "ThreadingModel" "Apartment"
  ReadRegStr $0 HKCU "${KOMORI_THUMBNAIL_HANDLER_KEY}" ""
  ${If} $0 != ""
  ${AndIf} $0 != "${KOMORI_THUMBNAIL_CLASS}"
    StrCpy $2 $0
  ${EndIf}
  ${If} $2 != ""
    WriteRegStr HKCU "${KOMORI_THUMBNAIL_CLASS_KEY}" "PreviousHandler" $2
  ${EndIf}
  WriteRegStr HKCU "${KOMORI_THUMBNAIL_HANDLER_KEY}" "" "${KOMORI_THUMBNAIL_CLASS}"
  ; SHCNE_ASSOCCHANGED: Explorer reads the handlers again.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function un.KomoriUnregisterThumbnails
  Push $0
  Push $1
  ReadRegStr $0 HKCU "${KOMORI_THUMBNAIL_HANDLER_KEY}" ""
  ${If} $0 == "${KOMORI_THUMBNAIL_CLASS}"
    ReadRegStr $1 HKCU "${KOMORI_THUMBNAIL_CLASS_KEY}" "PreviousHandler"
    ${If} $1 != ""
      WriteRegStr HKCU "${KOMORI_THUMBNAIL_HANDLER_KEY}" "" $1
    ${Else}
      DeleteRegKey HKCU "${KOMORI_THUMBNAIL_HANDLER_KEY}"
      DeleteRegKey /ifempty HKCU "Software\Classes\.epub\ShellEx"
    ${EndIf}
  ${EndIf}
  DeleteRegKey HKCU "${KOMORI_THUMBNAIL_CLASS_KEY}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ; A DLL Explorer still holds goes when Windows restarts; no later install reuses its name.
  Delete /REBOOTOK "$INSTDIR\komori-thumbnails-*.dll"
  Delete /REBOOTOK "$INSTDIR\komori-thumbnails.dll"
  Pop $1
  Pop $0
FunctionEnd
