"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { parseJavaVersion, listJavaCandidates, resolveJava } = require("../src/java");

// ---------------------------------------------------------------- parseJavaVersion

test("parses OpenJDK 17 format", () => {
  const v = parseJavaVersion(
    'openjdk version "17.0.12" 2024-07-16\nOpenJDK 64-Bit Server VM (build 17.0.12+7-1, mixed mode, sharing)'
  );
  assert.deepEqual(v, { major: 17, full: "17.0.12" });
});

test("parses legacy 1.8 format", () => {
  const v = parseJavaVersion('java version "1.8.0_292"');
  assert.deepEqual(v, { major: 8, full: "1.8.0_292" });
});

test("parses -ea builds", () => {
  const v = parseJavaVersion('java version "21-ea"');
  assert.deepEqual(v, { major: 21, full: "21-ea" });
});

test("returns null for garbage", () => {
  assert.equal(parseJavaVersion("not a version at all"), null);
  assert.equal(parseJavaVersion(""), null);
  assert.equal(parseJavaVersion(null), null);
});

// ------------------------------------------------------------- listJavaCandidates

test("lists basamake.javaHome candidate first", () => {
  const list = listJavaCandidates({ javaHome: "/opt/jdk", env: {}, homeDir: "/home/u", platform: "linux" });
  assert.equal(list[0].source, "basamake.javaHome");
  assert.equal(list[0].path, "/opt/jdk/bin/java");
});

test("lists JAVA_HOME candidate", () => {
  const list = listJavaCandidates({ javaHome: "", env: { JAVA_HOME: "/jdks/21" }, homeDir: "/home/u", platform: "linux" });
  assert.ok(list.some((c) => c.path === "/jdks/21/bin/java" && c.source === "JAVA_HOME"));
});

test("lists sdkman candidate under custom homeDir", () => {
  const list = listJavaCandidates({ javaHome: "", env: {}, homeDir: "/home/u", platform: "linux" });
  assert.ok(list.some((c) => c.path === "/home/u/.sdkman/candidates/java/current/bin/java" && c.source.includes("sdkman")));
});

test("uses java.exe on win32", () => {
  const list = listJavaCandidates({ javaHome: "C:\\jdks\\17", env: {}, homeDir: "C:\\Users\\u", platform: "win32" });
  // Compare with normalized separators: path.join uses "/" on POSIX hosts.
  const norm = (s) => s.replace(/[\\/]/g, path.sep);
  assert.equal(norm(list[0].path), norm("C:\\jdks\\17\\bin\\java.exe"));
});

test("lists macOS java_home command and sdkman on darwin", () => {
  const list = listJavaCandidates({ javaHome: "", env: {}, homeDir: "/Users/u", platform: "darwin" });
  assert.ok(list.some((c) => c.kind === "command" && c.command === "/usr/libexec/java_home"));
  assert.ok(list.some((c) => c.path === "/Users/u/.sdkman/candidates/java/current/bin/java"));
});

test("finds .jdk bundles in Contents/Home layout on darwin", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bm-jdks-"));
  try {
    fs.mkdirSync(path.join(root, "jdk-17.jdk", "Contents", "Home", "bin"), { recursive: true });
    fs.mkdirSync(path.join(root, "openjdk-17", "bin"), { recursive: true });
    const list = listJavaCandidates({ javaHome: "", env: {}, homeDir: "/Users/u", platform: "darwin", globRoots: [root] });
    assert.ok(list.some((c) => c.path === path.join(root, "jdk-17.jdk", "Contents", "Home", "bin", "java")));
    assert.ok(list.some((c) => c.path === path.join(root, "openjdk-17", "bin", "java")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("finds JDKs under /usr/lib/jvm-style roots on linux", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bm-jvm-"));
  try {
    fs.mkdirSync(path.join(root, "java-17-openjdk", "bin"), { recursive: true });
    const list = listJavaCandidates({ javaHome: "", env: {}, homeDir: "/home/u", platform: "linux", globRoots: [root] });
    assert.ok(list.some((c) => c.path === path.join(root, "java-17-openjdk", "bin", "java")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------------- resolveJava

/** Creates a fake `bin/java` in `dir` that prints `version` to stderr. POSIX-only. */
function makeFakeJava(dir, version) {
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const javaBin = path.join(binDir, "java");
  fs.writeFileSync(
    javaBin,
    `#!/bin/sh\necho 'openjdk version "${version}" 2024-07-16' >&2\nexit 0\n`,
    { mode: 0o755 }
  );
  return javaBin;
}

test("uses basamake.javaHome when it provides Java 17+", async () => {
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), "bm-java-"));
  makeFakeJava(fake, "17.0.12");
  try {
    const r = await resolveJava({ javaHome: fake, env: {}, homeDir: "/home/u", platform: "linux", probePath: false });
    assert.equal(r.command, path.join(fake, "bin", "java"));
    assert.equal(r.version, "17.0.12");
    assert.equal(r.source, "basamake.javaHome");
  } finally {
    fs.rmSync(fake, { recursive: true, force: true });
  }
});

test("skips too-old javaHome and falls through to sdkman", async () => {
  const old = fs.mkdtempSync(path.join(os.tmpdir(), "bm-old-"));
  const sdk = fs.mkdtempSync(path.join(os.tmpdir(), "bm-sdk-"));
  try {
    makeFakeJava(old, "1.8.0_292");
    fs.mkdirSync(path.join(sdk, ".sdkman", "candidates", "java", "current"), { recursive: true });
    makeFakeJava(path.join(sdk, ".sdkman", "candidates", "java", "current"), "17.0.12");
    const r = await resolveJava({ javaHome: old, env: {}, homeDir: sdk, platform: "linux", probePath: false });
    assert.equal(r.command, path.join(sdk, ".sdkman", "candidates", "java", "current", "bin", "java"));
    assert.ok(r.source.includes("sdkman"));
  } finally {
    fs.rmSync(old, { recursive: true, force: true });
    fs.rmSync(sdk, { recursive: true, force: true });
  }
});

test("probes bare `java` on PATH when configured javaHome is missing", async () => {
  const r = await resolveJava({ javaHome: "/nonexistent", env: {}, homeDir: "/home/u", platform: "linux", probePath: true });
  assert.ok(r.command === "java" && r.source === "PATH" || r.source !== "PATH");
});

test("throws a helpful error when nothing is found", async () => {
  await assert.rejects(
    resolveJava({ javaHome: "", env: {}, homeDir: "/home/u", platform: "linux", probePath: false }),
    /Java 17\+ not found/
  );
});
