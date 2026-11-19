' CyberLuke Local HELLDESK — zero-window scheduled-task launcher for the dashboard.
' Same detachment as the control-plane launcher: hides the whole chain so nothing
' appears on any desktop and Task Scheduler sees it return immediately. Starts
' the local-live dashboard (entry.ts) detached via a hidden PowerShell -> bun.
Option Explicit

Dim fso, shell, here, root, quot, ps1, pwrsh, cmd

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)   ' services/helldesk/local-live/scripts
root = fso.GetParentFolderName(here)                     ' services/helldesk/local-live
quot = Chr(34)

' Hidden PowerShell bootstrap that starts bun on src/entry.ts detached.
ps1 = fso.BuildPath(here, "launch-dashboard-hidden.ps1")
pwrsh = "powershell.exe"
cmd = pwrsh & " -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden " & _
      "-File " & quot & ps1 & quot & " -Root " & quot & root & quot

' 0 = SW_HIDE, False = do not wait.
shell.Run cmd, 0, False