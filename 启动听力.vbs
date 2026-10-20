Option Explicit
Dim shell, files, root, nodePath, command
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
nodePath = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
If Not files.FileExists(nodePath) Then nodePath = "node.exe"
shell.CurrentDirectory = root
command = Chr(34) & nodePath & Chr(34) & " " & Chr(34) & root & "\scripts\launch.mjs" & Chr(34)
shell.Run command, 0, False
