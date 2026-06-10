; Custom NSIS hooks for Markdown Viewer
; - Adds a custom "Additional Options" page after Welcome with a
;   "Create desktop shortcut" checkbox.
; - Adds an opt-in "Associate Markdown files" checkbox to the Finish page.
; - Cleans up all of the above on uninstall.

!include "nsDialogs.nsh"
!include "LogicLib.nsh"

!define MD_PROGID         "MarkdownViewer.MarkdownFile"
!define MD_PROGID_DESC    "Markdown Document"
!define MD_APP_REG_NAME   "Markdown Viewer"
!define MD_APP_DESC       "Live-preview Markdown viewer with GFM, syntax highlighting, math, and Mermaid"

; Only declared during the install pass; uninstaller doesn't need these and
; would otherwise warn about unused variables.
!ifndef BUILD_UNINSTALLER
  Var ShortcutCheckbox
  Var ShortcutChoice
!endif

; ============================================================================
; Welcome page + custom "Additional Options" page
; ============================================================================

!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME

  ; Define the page callbacks INSIDE this macro so NSIS sees the static
  ; reference from `Page custom` to the functions (same pattern as the
  ; finish-page SHOWREADME callback further down).
  Function ShortcutPagePre
    ; perMachine: false + allowToChangeInstallationDirectory: true causes
    ; the installer to elevate and re-launch as an inner instance when the
    ; user picks "all users". Any custom pages declared here would render
    ; twice. Detect the inner instance, restore the choice the user made in
    ; the outer pass, and skip the page (Abort in a Pre function skips it).
    ${If} ${UAC_IsInnerInstance}
      ClearErrors
      ReadRegStr $ShortcutChoice HKCU "Software\${MD_APP_REG_NAME}" "InstallerShortcutChoice"
      ${If} ${Errors}
        StrCpy $ShortcutChoice ${BST_CHECKED}
      ${EndIf}
      Abort
    ${EndIf}

    nsDialogs::Create 1018
    Pop $0
    StrCmp $0 "error" 0 +2
      Abort

    ${NSD_CreateLabel} 0 0 100% 24u "Choose extra setup actions to perform. Uncheck any you don't want."
    Pop $1

    ${NSD_CreateCheckbox} 0 32u 100% 12u "Create a desktop shortcut for ${PRODUCT_NAME}"
    Pop $ShortcutCheckbox
    ${NSD_SetState} $ShortcutCheckbox ${BST_CHECKED}

    nsDialogs::Show
  FunctionEnd

  Function ShortcutPageLeave
    ${NSD_GetState} $ShortcutCheckbox $ShortcutChoice
    ; Bridge the choice across the UAC elevation: the inner instance reads
    ; this back in ShortcutPagePre and skips the page. HKCU is the same user
    ; in both passes for normal UAC-consent elevations.
    WriteRegStr HKCU "Software\${MD_APP_REG_NAME}" "InstallerShortcutChoice" "$ShortcutChoice"
  FunctionEnd

  Page custom ShortcutPagePre ShortcutPageLeave
!macroend

; ============================================================================
; Finish page — Launch + Associate Markdown files (existing functionality)
; ============================================================================

!macro customFinishPage
  Function RegisterMarkdownAssociation
    WriteRegStr SHCTX "Software\Classes\${MD_PROGID}" "" "${MD_PROGID_DESC}"
    WriteRegStr SHCTX "Software\Classes\${MD_PROGID}\DefaultIcon" "" '"$INSTDIR\${APP_FILENAME}.exe",0'
    WriteRegStr SHCTX "Software\Classes\${MD_PROGID}\shell\open\command" "" '"$INSTDIR\${APP_FILENAME}.exe" "%1"'
    WriteRegStr SHCTX "Software\Classes\${MD_PROGID}\shell\open\FriendlyAppName" "" "${PRODUCT_NAME}"

    WriteRegStr SHCTX "Software\Classes\.md\OpenWithProgids" "${MD_PROGID}" ""
    WriteRegStr SHCTX "Software\Classes\.markdown\OpenWithProgids" "${MD_PROGID}" ""
    WriteRegStr SHCTX "Software\Classes\.mdown\OpenWithProgids" "${MD_PROGID}" ""
    WriteRegStr SHCTX "Software\Classes\.mdx\OpenWithProgids" "${MD_PROGID}" ""

    WriteRegStr SHCTX "Software\${MD_APP_REG_NAME}\Capabilities" "ApplicationName" "${PRODUCT_NAME}"
    WriteRegStr SHCTX "Software\${MD_APP_REG_NAME}\Capabilities" "ApplicationDescription" "${MD_APP_DESC}"
    WriteRegStr SHCTX "Software\${MD_APP_REG_NAME}\Capabilities\FileAssociations" ".md"       "${MD_PROGID}"
    WriteRegStr SHCTX "Software\${MD_APP_REG_NAME}\Capabilities\FileAssociations" ".markdown" "${MD_PROGID}"
    WriteRegStr SHCTX "Software\${MD_APP_REG_NAME}\Capabilities\FileAssociations" ".mdown"    "${MD_PROGID}"
    WriteRegStr SHCTX "Software\${MD_APP_REG_NAME}\Capabilities\FileAssociations" ".mdx"      "${MD_PROGID}"
    WriteRegStr SHCTX "Software\RegisteredApplications" "${MD_APP_REG_NAME}" "Software\${MD_APP_REG_NAME}\Capabilities"

    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
  FunctionEnd

  !define MUI_FINISHPAGE_NOAUTOCLOSE
  !define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_FILENAME}.exe"
  !define MUI_FINISHPAGE_RUN_TEXT "Launch ${PRODUCT_NAME}"

  !define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\${APP_FILENAME}.exe"
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "Associate Markdown files with ${PRODUCT_NAME}"
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION RegisterMarkdownAssociation

  !insertmacro MUI_PAGE_FINISH
!macroend

; ============================================================================
; customInstall — runs inside the install Section after file extraction.
; Creates the desktop shortcut iff the checkbox on the custom page was checked.
; ============================================================================

!macro customInstall
  ${If} $ShortcutChoice == ${BST_CHECKED}
    CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${APP_FILENAME}.exe" "" "$INSTDIR\${APP_FILENAME}.exe" 0
  ${EndIf}
  ; Clean up the cross-instance choice bridge from HKCU. /ifempty drops the
  ; parent key when nothing else lives under it.
  DeleteRegValue HKCU "Software\${MD_APP_REG_NAME}" "InstallerShortcutChoice"
  DeleteRegKey /ifempty HKCU "Software\${MD_APP_REG_NAME}"
!macroend

; ============================================================================
; Uninstall — clean up file associations AND the desktop shortcut.
; ============================================================================

!macro customUnInstall
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"

  DeleteRegKey SHCTX "Software\Classes\${MD_PROGID}"

  DeleteRegValue SHCTX "Software\Classes\.md\OpenWithProgids"       "${MD_PROGID}"
  DeleteRegValue SHCTX "Software\Classes\.markdown\OpenWithProgids" "${MD_PROGID}"
  DeleteRegValue SHCTX "Software\Classes\.mdown\OpenWithProgids"    "${MD_PROGID}"
  DeleteRegValue SHCTX "Software\Classes\.mdx\OpenWithProgids"      "${MD_PROGID}"

  DeleteRegValue SHCTX "Software\RegisteredApplications" "${MD_APP_REG_NAME}"
  DeleteRegKey   SHCTX "Software\${MD_APP_REG_NAME}"

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
