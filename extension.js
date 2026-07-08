"use strict";

const vscode = require("vscode");
const lc = require("vscode-languageclient/node");

let client;

/** Called when extension activates. */
async function activate(context) {
  const config = vscode.workspace.getConfiguration("basamake");
  let jarPath = config.get("jarPath", "");

  if (!jarPath) {
    // Look next to extension
    jarPath = context.asAbsolutePath("basamake.jar");
  }

  const jvmArgs = config.get("jvmArgs", []);

  const serverOptions = {
    command: "java",
    args: [...jvmArgs, "-jar", jarPath],
    transport: lc.TransportKind.stdio,
  };

  const clientOptions = {
    documentSelector: [{ scheme: "file", language: "scala" }],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher("**/*.scala"),
    },
  };

  client = new lc.LanguageClient(
    "basamake",
    "Basamake",
    serverOptions,
    clientOptions
  );

  context.subscriptions.push(client.start());

  await client.onReady();
  vscode.window.showInformationMessage("Basamake started");
}

/** Called when extension deactivates. */
function deactivate() {
  if (client) return client.stop();
}

module.exports = { activate, deactivate };
