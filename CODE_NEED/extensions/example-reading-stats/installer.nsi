; ============================================================================
; reading-stats extension installer
; Usage: makensis installer.nsi
; ============================================================================

!define EXT_NAME          "reading-stats"
!define EXT_DISPLAY_NAME  "Reading Stats"
!define EXT_VERSION       "1.0.0"
!define EXT_PUBLISHER     "Moke"

!define MOKE_APP_ID       "com.moke.client"
!define MOKE_REG_KEY      "Software\Microsoft\Windows\CurrentVersion\Uninstall\Moke"
!define EXT_REG_KEY       "Software\Moke\Extensions\${EXT_NAME}"

Name "${EXT_DISPLAY_NAME} v${EXT_VERSION}"
OutFile "${EXT_NAME}-setup.exe"
InstallDir "$APPDATA\${MOKE_APP_ID}\extensions\${EXT_NAME}"
RequestExecutionLevel user

; ---- Pre-install check ----
Function .onInit
    ; Check Moke is installed
    ReadRegStr $0 HKCU "${MOKE_REG_KEY}" "DisplayName"
    StrCmp $0 "" 0 moke_found
    IfFileExists "$APPDATA\${MOKE_APP_ID}\*" moke_found
    MessageBox MB_OK|MB_ICONSTOP "Moke is not installed. Please install Moke first."
    Abort
moke_found:
    ; Overwrite check
    ReadRegStr $0 HKCU "${EXT_REG_KEY}" "Version"
    StrCmp $0 "" done
    MessageBox MB_YESNO|MB_ICONQUESTION "${EXT_DISPLAY_NAME} v$0 is already installed. Overwrite?" IDYES done
    Abort
done:
FunctionEnd

; ---- Install ----
Section "Install"
    RMDir /r "$INSTDIR"
    CreateDirectory "$INSTDIR"
    SetOutPath "$INSTDIR"
    File /r "dist\*"

    WriteRegStr HKCU "${EXT_REG_KEY}" "DisplayName" "${EXT_DISPLAY_NAME}"
    WriteRegStr HKCU "${EXT_REG_KEY}" "Version"     "${EXT_VERSION}"
    WriteRegStr HKCU "${EXT_REG_KEY}" "Publisher"   "${EXT_PUBLISHER}"
    WriteRegStr HKCU "${EXT_REG_KEY}" "Path"        "$INSTDIR"
    WriteRegStr HKCU "${EXT_REG_KEY}" "Installed"   "1"

    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${EXT_NAME}" \
        "DisplayName" "${EXT_DISPLAY_NAME}"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${EXT_NAME}" \
        "UninstallString" '"$INSTDIR\uninstall.exe"'
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${EXT_NAME}" \
        "Publisher" "${EXT_PUBLISHER}"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${EXT_NAME}" \
        "DisplayVersion" "${EXT_VERSION}"
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${EXT_NAME}" \
        "NoModify" 1
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${EXT_NAME}" \
        "NoRepair" 1

    WriteUninstaller "$INSTDIR\uninstall.exe"
SectionEnd

; ---- Uninstall ----
Section "Uninstall"
    DeleteRegKey HKCU "${EXT_REG_KEY}"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${EXT_NAME}"
    RMDir /r "$INSTDIR"
SectionEnd
