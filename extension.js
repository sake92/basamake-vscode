"use strict";

const vscode = require("vscode");
const lc = require("vscode-languageclient/node");
const { resolveJarPath } = require("./src/download");

let client;
let serverProcess;

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
  const jvmArgs = config.get("jvmArgs", []);

  const serverOptions = {
    command: "java",
    args: [...jvmArgs, "-jar", jarPath],
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

  // Defense-in-depth: kill the server process if this extension is disposed.
  context.subscriptions.push({
    dispose: () => {
      if (serverProcess && serverProcess.pid) {
        try {
          serverProcess.kill("SIGKILL");
        } catch (_) {
          // Already dead — that is the goal.
        }
      }
    },
  });

  vscode.window.showInformationMessage("Basamake started");
}

/** Called when extension deactivates. */
async function deactivate() {
  const proc = client?._serverProcess;

  // Attempt graceful LSP shutdown with a short timeout.
  if (client) {
    try {
      await Promise.race([
        client.stop(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("stop timed out")), 500),
        ),
      ]);
    } catch (_) {
      // stop() timed out or failed — expected during fast shutdown.
    }
  }

  // Guarantee: kill the JVM process NOW, not seconds from now.
  if (proc && proc.pid) {
    try {
      proc.kill("SIGKILL");
    } catch (_) {
      // Already dead.
    }
  }
}

module.exports = { activate, deactivate };
