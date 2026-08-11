"use strict";

// Java discovery helper for basamake-vscode.
//
// The extension needs a Java 17+ runtime to launch the basamake server.
// `java` is NOT always on PATH: when VS Code is started from the Dock/Finder
// on macOS (or any GUI launcher), the process gets a minimal environment and
// shell rc files like ~/.zshrc (sdkman, etc.) are never sourced. This module
// therefore resolves Java from several sources, in order:
//
//   1. basamake.javaHome setting
//   2. `java` on PATH
//   3. JAVA_HOME
//   4. Platform locations: macOS /usr/libexec/java_home, sdkman, Homebrew,
//      system JDKs, Linux /usr/lib/jvm, Windows Program Files
//
// Every candidate is verified by running `java -version` and gating on the
// major version (>= 17). The module is pure Node — no `vscode` import — so
// all inputs are injected and it is unit-testable in isolation.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const MIN_JAVA_MAJOR = 17;
const PROBE_TIMEOUT_MS = 5000;

/** Binary name of `java` for the given platform. */
const javaBinName = (platform) => (platform === "win32" ? "java.exe" : "java");

// ---------------------------------------------------------------------------
// Version parsing
// ---------------------------------------------------------------------------

/**
 * Parses the stderr output of `java -version`.
 * Returns `{ major, full }`, or null when the output is not a version string.
 *
 * Handles the common formats:
 *   openjdk version "17.0.12" 2024-07-16
 *   java version "1.8.0_292"
 *   java version "21-ea"
 *   java version "17"
 */
function parseJavaVersion(output) {
  if (!output) return null;
  const m = output.match(/version "([^"]+)"/) || output.match(/version (\S+)/);
  if (!m) return null;
  const raw = m[1].split("-")[0]; // strip -ea, -LTS, ...
  const parts = raw.split(".").map((s) => parseInt(s, 10));
  if (parts.some((p) => Number.isNaN(p))) return null;
  const major = parts[0] === 1 ? parts[1] : parts[0]; // "1.8.x" -> 8
  return { major, full: m[1] };
}

// ---------------------------------------------------------------------------
// Candidate discovery
// ---------------------------------------------------------------------------

/** readdir that never throws; returns [] for missing/unreadable dirs. */
function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Adds every `bin/java` under the given roots that looks like a JDK install
 * (directory name contains "jdk" or "java"). On macOS also checks the
 * `Contents/Home` layout used by .jdk bundles.
 */
function addGlobCandidates(candidates, roots, { platform, prefix }) {
  const bin = javaBinName(platform);
  for (const root of roots) {
    for (const dirent of safeReaddir(root)) {
      if (!dirent.isDirectory()) continue;
      const name = dirent.name.toLowerCase();
      if (!name.includes("jdk") && !name.includes("java")) continue;
      const dir = path.join(root, dirent.name);
      const subPaths =
        platform === "darwin"
          ? [path.join(dir, "Contents", "Home", "bin", bin), path.join(dir, "bin", bin)]
          : [path.join(dir, "bin", bin)];
      for (const p of subPaths) {
        candidates.push({ kind: "path", path: p, source: `${prefix} ${dirent.name}` });
      }
    }
  }
}

/**
 * Ordered list of java candidates.
 * `kind: "path"`    -> file must exist, then probe `-version`
 * `kind: "command"` -> run it; stdout is a JDK home to probe
 *
 * Every candidate carries a `source` string describing where it came from,
 * for logging and error messages.
 *
 * `globRoots` overrides the platform's default glob roots (used by tests).
 */
function listJavaCandidates({ javaHome, env, homeDir = os.homedir(), platform = process.platform, globRoots }) {
  const bin = javaBinName(platform);
  const candidates = [];

  // 1. Explicit user configuration
  if (javaHome) {
    candidates.push({ kind: "path", path: path.join(javaHome, "bin", bin), source: "basamake.javaHome" });
  }

  // 2. JAVA_HOME environment variable
  if (env.JAVA_HOME) {
    candidates.push({ kind: "path", path: path.join(env.JAVA_HOME, "bin", bin), source: "JAVA_HOME" });
  }

  // 3. Platform locations
  if (platform === "darwin") {
    // Canonical macOS way: prints the path of the highest-version JDK.
    candidates.push({ kind: "command", command: "/usr/libexec/java_home", source: "macOS /usr/libexec/java_home" });

    // sdkman (symlink `current` points at the active JDK)
    if (homeDir) {
      candidates.push({
        kind: "path",
        path: path.join(homeDir, ".sdkman", "candidates", "java", "current", "bin", bin),
        source: "sdkman (~/.sdkman/candidates/java/current)",
      });
    }

    // System JDKs (.jdk bundles) and Homebrew (Apple Silicon + Intel)
    addGlobCandidates(
      candidates,
      globRoots || ["/Library/Java/JavaVirtualMachines", "/opt/homebrew/opt", "/usr/local/opt"],
      { platform, prefix: "system JDK" }
    );
  } else if (platform === "linux") {
    if (homeDir) {
      candidates.push({
        kind: "path",
        path: path.join(homeDir, ".sdkman", "candidates", "java", "current", "bin", bin),
        source: "sdkman (~/.sdkman/candidates/java/current)",
      });
    }
    addGlobCandidates(candidates, globRoots || ["/usr/lib/jvm", "/usr/lib64/jvm"], { platform, prefix: "system JDK" });
  } else if (platform === "win32") {
    const roots = [
      env.ProgramFiles && path.join(env.ProgramFiles, "Eclipse Adoptium"),
      env.ProgramFiles && path.join(env.ProgramFiles, "Java"),
      env.ProgramFiles && path.join(env.ProgramFiles, "Microsoft"),
      env["ProgramFiles(x86)"] && path.join(env["ProgramFiles(x86)"], "Java"),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "Eclipse Adoptium"),
    ].filter(Boolean);
    addGlobCandidates(candidates, roots, { platform, prefix: "system JDK" });
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

/**
 * Runs `binary -version` and checks the version gate.
 * Resolves `{ path, version, major }` when the binary works and is recent
 * enough, otherwise null (missing binary, non-zero exit — e.g. the macOS
 * /usr/bin/java stub — too old, or probe timeout).
 */
function probeJava(binary) {
  return new Promise((resolve) => {
    execFile(binary, ["-version"], { timeout: PROBE_TIMEOUT_MS }, (err, _stdout, stderr) => {
      if (err) return resolve(null);
      const parsed = parseJavaVersion(stderr);
      if (!parsed || parsed.major < MIN_JAVA_MAJOR) return resolve(null);
      resolve({ path: binary, version: parsed.full, major: parsed.major });
    });
  });
}

/** Runs a JDK-home command (macOS /usr/libexec/java_home); resolves home path or null. */
function runJavaHomeCommand(command) {
  return new Promise((resolve) => {
    execFile(command, [], { timeout: PROBE_TIMEOUT_MS }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Finds a Java 17+ binary.
 *
 * Resolution order: 1. basamake.javaHome, 2. `java` on PATH, 3. JAVA_HOME,
 * 4. platform locations. Each candidate is probed with `java -version`;
 * too-old or broken candidates are skipped, the first passing one wins.
 *
 * Returns `{ command, version, source }` where `command` is the binary to
 * spawn ("java" when found on PATH, absolute path otherwise).
 * Throws a user-facing Error when nothing suitable is found.
 */
async function resolveJava(opts) {
  const {
    javaHome,
    env = process.env,
    homeDir = os.homedir(),
    platform = process.platform,
    probePath = true,
  } = opts || {};

  const candidates = listJavaCandidates({ javaHome, env, homeDir, platform });
  // `java` on PATH sits between the explicit setting and JAVA_HOME:
  // config wins, then keep today's behavior (PATH java) when it works.
  if (probePath) {
    candidates.splice(1, 0, { kind: "path", path: "java", source: "PATH" });
  }

  for (const cand of candidates) {
    let binary = null;
    if (cand.kind === "command") {
      const home = await runJavaHomeCommand(cand.command);
      if (home) binary = path.join(home, "bin", javaBinName(platform));
    } else {
      binary = cand.path;
    }
    if (!binary) continue;

    const found = await probeJava(binary);
    if (found) {
      return { command: binary, version: found.version, source: cand.source };
    }
  }

  throw new Error(
    "Basamake: Java 17+ not found. Install a JDK (e.g. `brew install openjdk@17` or sdkman), " +
      "or set the 'basamake.javaHome' setting to your JDK home (e.g. ~/.sdkman/candidates/java/current). " +
      "Tip: extensions only see the environment of the process that started VS Code — when launched " +
      "from the Dock/Finder on macOS, your shell's PATH (and sdkman) is not loaded."
  );
}

module.exports = { parseJavaVersion, listJavaCandidates, resolveJava, MIN_JAVA_MAJOR };
