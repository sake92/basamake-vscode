# basamake-vscode

Basamake Scala LSP extension for VS Code.

Download latest VSIX release from [releases page](https://github.com/sake92/basamake-vscode/releases)
and install it in VSCode (extensions -> ... -> Install from VSIX).

You can also use [latest snapshot release](https://github.com/sake92/basamake-vscode/releases#release-main) if you feel brave.

## JVM args mirror file

On server start, the extension writes the JVM args into
`.basamake/jvmargs.txt` in your workspace and passes them to the JVM via
`java @file`. The `#` comment lines are ignored by Java and exist for you:
they show the workspace, server jar, start time and server PID, so when
multiple VS Code windows are running you can tell at a glance which
basamake server belongs to this window (cross-reference with
`ps aux | grep java @`).

The file is left behind when the window closes (safe to delete;
regenerated on next start). Editing it does nothing — JVM args are
configured with the `basamake.jvmArgs` setting. Add `.basamake/` to your
`.gitignore` if you don't want it in git status.
