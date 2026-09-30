' Stops the background service started by the desktop shortcut.
' ASCII ONLY - see the note in launch.vbs.
Option Explicit

Dim sh, fso, root, nodeExe, cmd, rc

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))

nodeExe = "E:\node\node.exe"
If Not fso.FileExists(nodeExe) Then nodeExe = "node"

If Not fso.FileExists(root & "\scripts\stop.mjs") Then
    MsgBox "scripts\stop.mjs not found." & vbCrLf & vbCrLf & root, 16, "MC Mod Finder"
    WScript.Quit 1
End If

sh.CurrentDirectory = root
cmd = """" & nodeExe & """ """ & root & "\scripts\stop.mjs"""
rc = sh.Run(cmd, 0, True)

If rc = 0 Then
    MsgBox "MC Mod Finder stopped.", 64, "MC Mod Finder"
ElseIf rc = 3 Then
    MsgBox "MC Mod Finder was not running.", 64, "MC Mod Finder"
Else
    MsgBox "Could not stop it (exit code " & rc & ")." & vbCrLf & "See data\stop.log for details.", 48, "MC Mod Finder"
End If
