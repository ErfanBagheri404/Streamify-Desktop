; Streamify Desktop installer skin — Berno-style dark wizard.
;
; electron-builder prepends this file to the generated script (ahead of its own
; `!include "MUI2.nsh"`), so MUI2 is pulled in here and every page it inserts
; later inherits these colors.
;
; Ceiling: MUI2's nsDialogs full-window pages (welcome, finish) go fully dark;
; the classic directory/instfiles pages keep the system dialog brush.

!define MUI_BGCOLOR   "161618"
!define MUI_TEXTCOLOR "ECECEE"

!include "MUI2.nsh"

!ifndef SF_SKIN_NSH
!define SF_SKIN_NSH

; Open on a branded dark page, like Berno's installer does.
; (electron-builder inserts its own pages after this, uninstaller pages too.)
!ifndef BUILD_UNINSTALLER
  !insertmacro MUI_PAGE_WELCOME
!endif

!endif
