' CyberLuke Local HELLDESK — zero-window scheduled-task launcher.
' Task Scheduler invokes this via wscript.exe. WScript.Shell.Run with window
' style 0 (SW_HIDE) + bWaitOnReturn=False starts the proper hidden daemon
' wrapper fully detached from any console: NOTHING ever appears on any desktop
' and Task Scheduler sees the wrapper return immediately.
'
'   wscript.exe "scripts\launch-daemon-task.vbs"  [config.json]
Option Explicit

Dim fso, shell, here, root, cfg, quot, args

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.GetParentFolderName(here)
cfg = JoinPathSafe(root, "config.json")
If WScript.Arguments.Count >= 1 And WScript.Arguments(0) <> "" Then
    cfg = WScript.Arguments(0)
End If

quot = Chr(34)
Dim ps1, pwrsh, cmd
ps1 = JoinPathSafe(root, "scripts\daemon-hidden.ps1")

' PowerShell hidden inside this detached wscript; its own Start-Process hides
' the bun child, so the whole chain is headless end-to-end.
pwrsh = "powershell.exe"
cmd = pwrsh & " -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden " & _
      "-File " & quot & ps1 & quot & " -Config " & quot & cfg & quot & " -Task"

' 0 = SW_HIDE, False = do not wait. The daemon keeps running after we exit.
shell.Run cmd, 0, False

Function JoinPathSafe(parent, name)
    If Right(parent, 1) = "\" Then
        JoinPathSafe = parent & name
    Else
        JoinPathSafe = parent & "\" & name
    End If
End Function