"use strict";

const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

const GH_OWNER = "sake92";
const GH_REPO = "basamake";
const JAR_FILENAME = "basamake.jar";

/**
 * Resolves the absolute path to basamake.jar.
 *
 * Priority:
 * 1. basamake.jarPath config (user override) – returned as-is
 * 2. Cached jar matching basamake.serverVersion (default "latest")
 * 3. Download from GitHub releases, cache, return path
 *
 * Throws if download is needed and fails.
 */
async function resolveJarPath(context) {
  const cfg = vscode.workspace.getConfiguration("basamake");

  // Priority 1: explicit user override
  const configuredPath = cfg.get("jarPath", "");
  if (configuredPath) {
    return configuredPath;
  }

  // Priority 2 & 3: versioned download flow
  const version = await resolveVersion(cfg);
  const cachedPath = getCachedJarPath(context, version);

  if (cachedPath) {
    return cachedPath;
  }

  // Download and cache
  await downloadJar(context, version);

  // Verify it exists now
  const finalPath = getCachedJarPath(context, version);
  if (!finalPath) {
    throw new Error(
      "Basamake: jar was downloaded but could not be found in cache"
    );
  }
  return finalPath;
}

/**
 * Reads serverVersion setting.
 * If "latest", fetches the latest release tag from GitHub API.
 * Otherwise returns the configured string as-is.
 */
async function resolveVersion(cfg) {
  const configured = cfg.get("serverVersion", "latest");

  if (configured !== "latest") {
    return configured;
  }

  // Resolve "latest" via GitHub Releases API
  const apiUrl = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/releases/latest`;

  const data = await httpsGet(apiUrl, {
    headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "basamake-vscode" },
  });

  let tag;
  try {
    tag = JSON.parse(data).tag_name;
  } catch (e) {
    throw new Error(
      "Basamake: could not parse GitHub API response for latest release"
    );
  }

  if (!tag) {
    throw new Error(
      "Basamake: GitHub API returned no tag_name for latest release"
    );
  }

  return tag;
}

/**
 * Returns the cached jar path if it exists, otherwise null.
 */
function getCachedJarPath(context, version) {
  const cacheDir = context.globalStorageUri;
  const jarPath = path.join(cacheDir.fsPath, "jars", `basamake-${version}.jar`);

  if (fs.existsSync(jarPath)) {
    return jarPath;
  }
  return null;
}

/**
 * Downloads basamake.jar for the given version from GitHub releases.
 * Writes to a temp file first, then atomically renames on success.
 */
async function downloadJar(context, version) {
  const downloadUrl = `https://github.com/${GH_OWNER}/${GH_REPO}/releases/download/${version}/${JAR_FILENAME}`;

  const cacheDir = context.globalStorageUri;
  const jarsDir = path.join(cacheDir.fsPath, "jars");
  const finalPath = path.join(jarsDir, `basamake-${version}.jar`);
  const tmpPath = finalPath + ".tmp";

  // Ensure jars directory exists
  fs.mkdirSync(jarsDir, { recursive: true });

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Downloading Basamake ${version}...`,
      cancellable: false,
    },
    async () => {
      await httpsGetBuffer(downloadUrl, tmpPath);
    }
  );

  // Atomic rename
  fs.renameSync(tmpPath, finalPath);

  // Store in globalState so we can quick-check later
  await context.globalState.update("cachedVersion", version);
}

/**
 * HTTP GET that collects response as string (text mode).
 */
function httpsGet(url, options) {
  return new Promise((resolve, reject) => {
    https
      .get(url, options, (res) => {
        if (res.statusCode !== 200) {
          res.resume(); // drain response to free memory
          reject(
            new Error(
              `Basamake: GitHub API responded with status ${res.statusCode}`
            )
          );
          return;
        }
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve(body));
      })
      .on("error", (e) =>
        reject(new Error(`Basamake: GitHub API request failed — ${e.message}`))
      );
  });
}

/**
 * HTTP GET that streams response body directly to a file (binary mode).
 */
function httpsGetBuffer(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https
      .get(url, { headers: { "User-Agent": "basamake-vscode" } }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          file.close();
          fs.unlinkSync(destPath);
          reject(
            new Error(
              `Basamake: download failed — server responded with status ${res.statusCode}`
            )
          );
          return;
        }
        res.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
      })
      .on("error", (e) => {
        file.close();
        try {
          fs.unlinkSync(destPath);
        } catch (_) {}
        reject(
          new Error(`Basamake: download failed — ${e.message}`)
        );
      });
  });
}

module.exports = { resolveJarPath };
