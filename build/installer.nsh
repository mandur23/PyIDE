; Included by electron-builder's NSIS script (package.json build.nsis.include).
; Registers Nano Studio under "Open with" for .py files without taking over the default program: a ProgID plus an
; OpenWithProgids value, both per-user, as VS Code does. The uninstaller removes exactly what was added here.

!macro customInstall
  WriteRegStr HKCU "Software\Classes\NanoStudio.py" "" "Python File"
  WriteRegStr HKCU "Software\Classes\NanoStudio.py\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\NanoStudio.py\shell\open" "" "Open with Nano Studio"
  WriteRegStr HKCU "Software\Classes\NanoStudio.py\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr HKCU "Software\Classes\.py\OpenWithProgids" "NanoStudio.py" ""
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "Nano Studio"
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".py" ""
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

; Deletes a key only when it holds no values and no subkeys, so other programs' entries under .py survive.
!macro deleteKeyIfEmpty KEY
  Push $0
  Push $1
  Push $2
  EnumRegKey $0 HKCU "${KEY}" 0
  EnumRegValue $1 HKCU "${KEY}" 0
  ReadRegStr $2 HKCU "${KEY}" ""
  ${If} $0 == ""
  ${AndIf} $1 == ""
  ${AndIf} $2 == ""
    DeleteRegKey HKCU "${KEY}"
  ${EndIf}
  ClearErrors
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro customUnInstall
  DeleteRegValue HKCU "Software\Classes\.py\OpenWithProgids" "NanoStudio.py"
  !insertmacro deleteKeyIfEmpty "Software\Classes\.py\OpenWithProgids"
  !insertmacro deleteKeyIfEmpty "Software\Classes\.py"
  DeleteRegKey HKCU "Software\Classes\NanoStudio.py"
  DeleteRegKey HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
