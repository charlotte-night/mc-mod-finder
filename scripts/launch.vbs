' Hidden launcher used by the desktop shortcut.
'
' ASCII ONLY on purpose: Windows Script Host reads .vbs files using the system
' ANSI codepage, so non-ASCII text here gets mis-decoded and breaks parsing.
' All Chinese messages live in the Node scripts, which are UTF-8 aware.
Option Explicit

Dim sh, fso, root, nodeExe, cmd

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' This file lives in <project>\scripts\, so the project root is two levels up.
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))

' Prefer the node that was recorded at setup time; fall back to PATH.
nodeExe = "E:\node\node.exe"
If Not fso.FileExists(nodeExe) Then nodeExe = "node"

If Not fso.FileExists(root & "\server\index.js") Then
    MsgBox "server\index.js not found - the project files look incomplete." & vbCrLf & vbCrLf & root, 16, "MC Mod Finder"
    WScript.Quit 1
End If

sh.CurrentDirectory = root
cmd = """" & nodeExe & """ """ & root & "\scripts\launch.mjs"""
sh.Run cmd, 0, False
