"use strict";

const path = require("node:path");
const vscode = require("vscode");
const lc = require("vscode-languageclient/node");
const { resolveJarPath } = require("./download");

/** @type {lc.LanguageClient | undefined} */
let client;
/** @type {import("child_process").ChildProcess | undefined} */
let serverProcess;

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
  const args = [...requiredJvmArgs, ...jvmArgs, "-jar", jarPath];
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
