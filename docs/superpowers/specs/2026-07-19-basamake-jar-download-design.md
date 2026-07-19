# Basamake Jar Download & Cache — Design

## Summary

Replace the 56MB bundled `basamake.jar` with an on-demand download from GitHub releases. The extension downloads and caches the jar on first activation, or when a new version is configured.

## Settings (package.json)

**Keep existing:**
```
basamake.jarPath    — string, default "" (local override, skip download)
basamake.jvmArgs    — array, default []
```

**Add new:**
```
basamake.serverVersion  — string, default "latest"
  "latest" auto-resolves to newest GitHub release tag.
  Pin to a tag like "v0.1.0" for a specific version.
  Ignored when basamake.jarPath is set.
```

## Cache Layout (globalStorageUri)

```
~/.config/Code/User/globalStorage/local.basamake/
  └── jars/
        ├── basamake-v0.1.0.jar
        └── basamake-v0.2.0.jar
```

`context.globalState` stores `{ "cachedVersion": "v0.2.0" }` for quick version lookup.

## Resolution Order

```
config.jarPath set? → use it directly, done

→ read config.serverVersion (default "latest")
  → if "latest": fetch https://api.github.com/repos/sake92/basamake/releases/latest
                 extract tag_name (e.g. "v0.1.0")
  → else: use configured string as-is

→ check globalStorageUri/jars/basamake-{version}.jar exists
  → yes: use it, done

→ download from https://github.com/sake92/basamake/releases/download/{version}/basamake.jar
  → stream to temp file, rename atomically on success
  → store version in globalState
  → use it, done

→ download fails → showErrorMessage, do NOT start server
```

## Module API (src/download.js)

One public export:
```js
async function resolveJarPath(context) => string
```

Internal helpers:
- `resolveVersion()` — reads config, resolves "latest" via GitHub API
- `getCachedJarPath(context, version)` — checks cache dir exists and jar is present
- `downloadJar(context, version)` — HTTP stream to temp file, rename, update globalState
- `ensureDir(uri)` — creates directory if not exists (via workspace.fs)

## Error Handling

| Scenario | UX |
|----------|----|
| version pinned but release 404s | error: "release v0.1.0 not found" |
| "latest" resolution fails (no network/API) | error: "could not resolve latest version" |
| download fails mid-stream | clean temp, error: "download failed" |
| write failed | error: "could not save jar" |

All via `vscode.window.showErrorMessage`. Server does not start if jar can't be resolved.

## Download UX

`vscode.window.withProgress` with `ProgressLocation.Notification`:
> "Downloading Basamake v0.1.0..."

Indeterminate progress bar. Download streams to temp file, renames on success, deletes temp on failure.

## Files Changed

| File | Action |
|------|--------|
| `package.json` | Add `basamake.serverVersion` setting |
| `src/download.js` | **New** — download/cache/resolution logic |
| `extension.js` | Replace jarPath block with `resolveJarPath(context)` call |
| `basamake.jar` | **Delete from repo and git history** |
| `.gitignore` | Add `basamake.jar` |
| `.vscodeignore` | Add `basamake.jar` |

## Git History Purge

Use `git filter-repo` to remove `basamake.jar` from all commits.
