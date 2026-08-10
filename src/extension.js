"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");
const lc = require("vscode-languageclient/node");
const { resolveJarPath } = require("./download");

/** @type {lc.LanguageClient | undefined} */
let client;
/** @type {import("child_process").ChildProcess | undefined} */
let serverProcess;

const JVM_ARGS_FILE_NAME = "jvmargs.txt";
const JVM_ARGS_DIR_NAME = ".basamake";
const PID_PLACEHOLDER = "# PID:       <pending>";

/**
 * Writes the JVM args mirror file `<workspace>/.basamake/jvmargs.txt`.
 * Java ignores `#` comment lines, so the file doubles as a readable
 * "which server is this" note: workspace, jar, start time, and PID
 * (filled in after spawn).
 * Returns the absolute file path, or undefined if writing failed
 * (caller then falls back to inline JVM args).
 */
function writeJvmArgsFile(workspacePath, jarPath, jvmArgs) {
  const dir = path.join(workspacePath, JVM_ARGS_DIR_NAME);
  const file = path.join(dir, JVM_ARGS_FILE_NAME);
  const lines = [
    "# basamake-vscode server mirror - safe to delete, regenerated on start",
    `# Workspace: ${workspacePath}`,
    `# Server:    ${jarPath}`,
    `# Started:   ${new Date().toLocaleString()}`,
    PID_PLACEHOLDER,
    "# --- JVM args below (informational; edit does nothing) ---",
    ...jvmArgs,
    "",
  ];
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, lines.join("\n"), "utf8");
    return file;
  } catch (_) {
    return undefined;
  }
}

/**
 * Absolute path of the workspace to hand to the basamake server.
 * Uses the first workspace folder; falls back to the active file's
 * directory when no folder is open. Returns undefined if neither exists.
 */
function getWorkspacePath() {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].uri.fsPath;
  }
  const activeDoc = vscode.window.activeTextEditor?.document;
  if (activeDoc && activeDoc.uri.scheme === "file") {
    return path.dirname(activeDoc.uri.fsPath);
  }
  return undefined;
}

/** Called when extension activates. */
async function activate(context) {
  let jarPath;
  try {
    jarPath = await resolveJarPath(context);
  } catch (err) {
    vscode.window.showErrorMessage(err.message);
    return; // do not start server
  }

  const config = vscode.workspace.getConfiguration("basamake");
  const jvmArgs = config.get("jvmArgs", [
    "-Xmx1g",
    "-XX:G1PeriodicGCInterval=60000",
    "-XX:+G1PeriodicGCInvokesConcurrent",
  ]);

  // lmdbjava (used for the dep/JDK symbol index cache) needs these on JDK 17+.
  const requiredJvmArgs = [
    "--add-opens=java.base/java.nio=ALL-UNNAMED",
    "--add-opens=java.base/sun.nio.ch=ALL-UNNAMED",
  ];

  // basamake expects --workspace as the first program argument.
  // Absolute path of the first workspace folder; fall back to the
  // active file's directory when no folder is open.
  const workspacePath = getWorkspacePath();
  const allJvmArgs = [...requiredJvmArgs, ...jvmArgs];

  // Mirror the JVM args into a workspace file and pass them via
  // `java @file` so the file can be opened at a glance to see
  // which server is running here. On failure, fall back to inline args.
  let jvmArgsFile;
  if (workspacePath) {
    jvmArgsFile = writeJvmArgsFile(workspacePath, jarPath, allJvmArgs);
    if (!jvmArgsFile) {
      vscode.window.showWarningMessage(
        "Basamake: could not write .basamake/jvmargs.txt, using inline JVM args."
      );
    }
  }

  let args;
  if (jvmArgsFile) {
    args = [`@${jvmArgsFile}`, "-jar", jarPath];
  } else {
    args = [...allJvmArgs, "-jar", jarPath];
  }
  if (workspacePath) {
    args.push("--workspace", workspacePath);
  }

  const serverOptions = {
    command: "java",
    args,
    transport: lc.TransportKind.stdio,
  };

  const clientOptions = {
    documentSelector: [
      { scheme: "file", language: "scala" },
      { scheme: "file", language: "java" },
    ],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher("**/*.{scala,java}"),
    },
  };

  client = new lc.LanguageClient(
    "basamake",
    "Basamake",
    serverOptions,
    clientOptions
  );

  await client.start();
  serverProcess = client._serverProcess;

  // Fill in the PID of the just-started server (java reads the file
  // only at launch, so this is safe). Skip silently if the file was
  // deleted or hand-edited in the meantime.
  if (jvmArgsFile && serverProcess && serverProcess.pid) {
    try {
      const content = fs.readFileSync(jvmArgsFile, "utf8");
      const updated = content.replace(
        PID_PLACEHOLDER,
        `# PID:       ${serverProcess.pid}`
      );
      if (updated !== content) {
        fs.writeFileSync(jvmArgsFile, updated, "utf8");
      }
    } catch (_) {
      // File gone or unreadable - nothing to do.
    }
  }

  context.subscriptions.push(client);

  // AI added, no idea if needed
  // Defense-in-depth: kill the server process if this extension is disposed.
  /*context.subscriptions.push({
    dispose: () => {
      if (serverProcess && serverProcess.pid) {
        try {
          serverProcess.kill("SIGKILL");
        } catch (_) {
          // Already dead — that is the goal.
        }
      }
    },
  });*/

  vscode.window.showInformationMessage("Basamake started");
}

/** Called when extension deactivates. */
async function deactivate() {

  // Attempt graceful LSP shutdown
  if (client) {
    try {
      await Promise.race([
        client.stop(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("client stop timed out")), 1000),
        ),
      ]);
    } catch (_) {
      // stop() timed out or failed — expected during fast shutdown.
    }
  }

  // Guarantee: kill the JVM process NOW, not seconds from now.
  if (serverProcess && serverProcess.pid) {
    try {
      await Promise.race([
        serverProcess.kill(), // SIGTERM
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("server process sigterm kill timed out")), 1000),
        ),
      ]);
    } catch (_) {
      // kill() timed out or failed
      // kill forcefully just in case ..
      try {
        serverProcess.kill("SIGKILL");
      } catch (_) {
        // Already dead.
      }
    }

  }
}

module.exports = { activate, deactivate };
