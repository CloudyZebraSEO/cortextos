' run-hidden.vbs — launch a console command fully hidden (no window flash).
' Used by agent .claude/settings.json fire-and-forget hooks so Claude Code's
' hook spawner does not pop a node.exe console window on Windows.
'
' wscript.exe is a GUI-subsystem binary, so Windows never allocates a console
' for the launcher itself; WshShell.Run(..., 0, False) then starts the real
' command hidden (0 = SW_HIDE) and does not wait (fire-and-forget). Only use
' this for hooks that do NOT need to return data on stdout to Claude Code.
'
' Args: <exe> [arg1] [arg2] ...   e.g.  node.exe cli.js bus hook-idle-flag
Set sh = CreateObject("WScript.Shell")
cmd = ""
For i = 0 To WScript.Arguments.Count - 1
  a = WScript.Arguments(i)
  If InStr(a, " ") > 0 Then a = """" & a & """"
  cmd = cmd & a & " "
Next
sh.Run cmd, 0, False
