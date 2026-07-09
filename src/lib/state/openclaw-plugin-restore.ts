// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { spawnSync } from "child_process";

import { isRecord } from "../core/json-types.js";
import { shellQuote } from "../core/shell-quote.js";
import { createTempSshConfig } from "../sandbox/temp-ssh-config.js";
import {
  OPENCLAW_IMAGE_MANAGED_EXTENSION_DIRS,
  shouldPreserveOpenClawManagedExtensions,
} from "./openclaw-managed-extensions.js";

const MAX_OPENCLAW_IMAGE_MANAGED_PLUGIN_INSTALLS = 128;
const MAX_OPENCLAW_CONFIGURED_PLUGIN_LOAD_PATHS = 512;
// The parser accepts at most 128 records with 4 KiB install paths, leaving
// ample room for IDs and metadata while bounding sandbox-controlled output.
const OPENCLAW_PLUGIN_INSTALL_REGISTRY_MAX_BYTES = 1024 * 1024;
// Bound sandbox-controlled registry strings before path normalization.
const MAX_OPENCLAW_PLUGIN_INSTALL_PATH_LENGTH = 4096;
const MAX_OPENCLAW_PLUGIN_INSTALL_PATH_SEGMENTS = 64;
const OPENCLAW_EXTENSION_GLOB_CHARS = ["/", "\\", "*", "?", "[", "]"] as const;
const OPENCLAW_PLUGIN_INSTALL_SOURCES = new Set([
  "archive",
  "clawhub",
  "git",
  "marketplace",
  "npm",
  "path",
]);
const OPENCLAW_PLUGIN_ID_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._+~-]*$/;
const FORBIDDEN_OPENCLAW_PLUGIN_IDS = new Set(["__proto__", "constructor", "prototype"]);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export type OpenClawManagedExtensionDiscoveryResult =
  | { ok: true; extensionDirs: string[]; pluginInstalls: OpenClawImagePluginInstall[] }
  | { ok: false; error: string };

export interface OpenClawImagePluginInstall {
  readonly id: string;
  readonly installPath: string;
  /** Exact configured load paths owned by this image install; durable validation requires it. */
  readonly loadPaths?: readonly string[];
}

export type CompleteOpenClawImagePluginInstall = Omit<OpenClawImagePluginInstall, "loadPaths"> & {
  readonly loadPaths: readonly string[];
};

export interface OpenClawPluginDiscoveryDeps {
  getSshConfig(sandboxName: string): string | null;
  sshArgs(configFile: string, sandboxName: string): string[];
}

export type OpenClawPluginRestorePlanResult =
  | {
      ok: true;
      freshExtensionDirs: string[];
      previousExtensionDirs: string[];
      preservedExtensionDirs: string[];
      archiveExcludedExtensionDirs: string[];
      requiredFreshExtensionDirs: string[];
    }
  | { ok: false; error: string };

const OPENCLAW_PLUGIN_INDEX_SQLITE_PY = [
  "import json, sqlite3, sys, urllib.parse",
  'uri = "file:" + urllib.parse.quote(sys.argv[1], safe="/") + "?mode=ro"',
  "conn = sqlite3.connect(uri, uri=True, timeout=30)",
  "try:",
  '    conn.execute("PRAGMA query_only=ON")',
  '    conn.execute("PRAGMA busy_timeout=30000")',
  "    row = conn.execute(\"SELECT install_records_json FROM installed_plugin_index WHERE index_key = 'installed-plugin-index'\").fetchone()",
  "    if not row or not row[0]: raise SystemExit(12)",
  "    records = json.loads(row[0])",
  "    with open(sys.argv[2], 'r', encoding='utf-8') as config_file: config = json.load(config_file)",
  "    plugins = config.get('plugins') if isinstance(config, dict) else None",
  "    load = plugins.get('load') if isinstance(plugins, dict) else None",
  "    load_paths = load.get('paths', []) if isinstance(load, dict) else []",
  "    print(json.dumps({'version': 1, 'installRecords': records, 'loadPaths': load_paths}, separators=(',', ':')))",
  "finally:",
  "    conn.close()",
].join("\n");

const OPENCLAW_PLUGIN_INDEX_LEGACY_PY = [
  "import json, sys",
  "with open(sys.argv[1], 'r', encoding='utf-8') as index_file: index = json.load(index_file)",
  "with open(sys.argv[2], 'r', encoding='utf-8') as config_file: config = json.load(config_file)",
  "plugins = config.get('plugins') if isinstance(config, dict) else None",
  "load = plugins.get('load') if isinstance(plugins, dict) else None",
  "load_paths = load.get('paths', []) if isinstance(load, dict) else []",
  "if not isinstance(index, dict): raise SystemExit(12)",
  "index['loadPaths'] = load_paths",
  "print(json.dumps(index, separators=(',', ':')))",
].join("\n");

function buildSafeRegularFileReadGuard(variable: string, missingStatus: number): string[] {
  return [
    `[ -e "$${variable}" ] || [ -L "$${variable}" ] || exit ${missingStatus}`,
    `[ -f "$${variable}" ] && [ ! -L "$${variable}" ] || { echo "unsafe state file: $${variable}" >&2; exit 10; }`,
    `${variable}_hardlinks="$(find "$${variable}" -maxdepth 0 -type f -links +1 -print 2>/dev/null | wc -l | tr -d " ")"`,
    `[ "\${${variable}_hardlinks:-0}" = "0" ] || { echo "hard-linked state file rejected: $${variable}" >&2; exit 11; }`,
  ];
}

export function buildFreshOpenClawPluginIndexSqliteReadCommand(dir: string): string {
  const sqlitePath = `${dir.replace(/\/+$/, "")}/state/openclaw.sqlite`;
  const configPath = `${dir.replace(/\/+$/, "")}/openclaw.json`;
  const quotedSqlitePath = shellQuote(sqlitePath);
  const quotedConfigPath = shellQuote(configPath);
  return [
    `db=${quotedSqlitePath}`,
    `cfg=${quotedConfigPath}`,
    ...buildSafeRegularFileReadGuard("db", 2),
    ...buildSafeRegularFileReadGuard("cfg", 12),
    `python3 -c ${shellQuote(OPENCLAW_PLUGIN_INDEX_SQLITE_PY)} "$db" "$cfg"`,
  ].join("; ");
}

function buildLegacyOpenClawPluginIndexReadCommand(dir: string): string {
  const installIndexPath = `${dir.replace(/\/+$/, "")}/plugins/installs.json`;
  const configPath = `${dir.replace(/\/+$/, "")}/openclaw.json`;
  const quotedInstallIndexPath = shellQuote(installIndexPath);
  const quotedConfigPath = shellQuote(configPath);
  return [
    `src=${quotedInstallIndexPath}`,
    `cfg=${quotedConfigPath}`,
    ...buildSafeRegularFileReadGuard("src", 2),
    ...buildSafeRegularFileReadGuard("cfg", 12),
    `python3 -c ${shellQuote(OPENCLAW_PLUGIN_INDEX_LEGACY_PY)} "$src" "$cfg"`,
  ].join("; ");
}

function readFreshOpenClawPluginInstallIndex(
  deps: OpenClawPluginDiscoveryDeps,
  configFile: string,
  sandboxName: string,
  dir: string,
): ReturnType<typeof spawnSync> {
  // OpenClaw 2026.6.10 moved install records into its shared SQLite state.
  // Fall back only when that database is absent so a corrupt/incomplete
  // canonical index cannot be masked by stale legacy JSON.
  const sqliteResult = spawnSync(
    "ssh",
    [...deps.sshArgs(configFile, sandboxName), buildFreshOpenClawPluginIndexSqliteReadCommand(dir)],
    {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
      maxBuffer: OPENCLAW_PLUGIN_INSTALL_REGISTRY_MAX_BYTES,
    },
  );
  if (sqliteResult.status !== 2 || sqliteResult.error || sqliteResult.signal) return sqliteResult;

  return spawnSync(
    "ssh",
    [...deps.sshArgs(configFile, sandboxName), buildLegacyOpenClawPluginIndexReadCommand(dir)],
    {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
      maxBuffer: OPENCLAW_PLUGIN_INSTALL_REGISTRY_MAX_BYTES,
    },
  );
}

export function discoverFreshOpenClawPluginExtensionDirs(
  deps: OpenClawPluginDiscoveryDeps,
  configFile: string,
  sandboxName: string,
  dir: string,
): OpenClawManagedExtensionDiscoveryResult {
  const result = readFreshOpenClawPluginInstallIndex(deps, configFile, sandboxName, dir);
  if (
    result.stdout &&
    Buffer.byteLength(result.stdout) > OPENCLAW_PLUGIN_INSTALL_REGISTRY_MAX_BYTES
  ) {
    return { ok: false, error: "fresh OpenClaw plugin install registry response too large" };
  }
  if (result.status !== 0 || result.error || result.signal || !result.stdout) {
    return { ok: false, error: "could not read fresh OpenClaw plugin install registry" };
  }

  let config: unknown;
  try {
    config = JSON.parse(result.stdout.toString("utf-8")) as unknown;
  } catch {
    return {
      ok: false,
      error: "fresh OpenClaw plugin install registry is not valid JSON",
    };
  }
  const parsed = parseFreshOpenClawPluginExtensionDirs(config, dir);
  return parsed.ok
    ? parsed
    : { ok: false, error: "fresh OpenClaw plugin install registry failed validation" };
}

export function discoverFreshOpenClawImagePluginInstalls(
  sandboxName: string,
  deps: OpenClawPluginDiscoveryDeps,
  dir = "/sandbox/.openclaw",
): OpenClawManagedExtensionDiscoveryResult {
  const sshConfig = deps.getSshConfig(sandboxName);
  if (!sshConfig) {
    return { ok: false, error: "could not get SSH config for OpenClaw plugin discovery" };
  }
  const tempSshConfig = createTempSshConfig(sshConfig, "nemoclaw-plugin-discovery-");
  try {
    return discoverFreshOpenClawPluginExtensionDirs(deps, tempSshConfig.file, sandboxName, dir);
  } finally {
    tempSshConfig.cleanup();
  }
}

function isSafeOpenClawPluginInstallId(id: string): boolean {
  if (id.length === 0 || id.length > 256 || FORBIDDEN_OPENCLAW_PLUGIN_IDS.has(id)) return false;
  const slash = id.indexOf("/");
  if (slash === -1) return OPENCLAW_PLUGIN_ID_SEGMENT.test(id);
  return (
    id.startsWith("@") &&
    slash > 1 &&
    slash === id.lastIndexOf("/") &&
    slash < id.length - 1 &&
    !FORBIDDEN_OPENCLAW_PLUGIN_IDS.has(id.slice(slash + 1)) &&
    OPENCLAW_PLUGIN_ID_SEGMENT.test(id.slice(1, slash)) &&
    OPENCLAW_PLUGIN_ID_SEGMENT.test(id.slice(slash + 1))
  );
}

export function isSafeOpenClawExtensionDirName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 128 &&
    name !== "." &&
    name !== ".." &&
    !/[\u0000-\u001f\u007f]/.test(name) &&
    !OPENCLAW_EXTENSION_GLOB_CHARS.some((char) => name.includes(char))
  );
}

function validateCanonicalAbsolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_OPENCLAW_PLUGIN_INSTALL_PATH_LENGTH &&
    !CONTROL_CHARACTERS.test(value) &&
    value.split("/").filter(Boolean).length <= MAX_OPENCLAW_PLUGIN_INSTALL_PATH_SEGMENTS &&
    path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value
  );
}

function validateConfiguredLoadPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_OPENCLAW_PLUGIN_INSTALL_PATH_LENGTH &&
    !CONTROL_CHARACTERS.test(value)
  );
}

function validateDurableOpenClawImagePluginInstall(
  id: unknown,
  installPath: unknown,
  loadPaths: unknown,
): CompleteOpenClawImagePluginInstall | null {
  if (typeof id !== "string" || !isSafeOpenClawPluginInstallId(id)) return null;
  if (!validateCanonicalAbsolutePath(installPath)) return null;
  if (
    !Array.isArray(loadPaths) ||
    loadPaths.length > 1 ||
    !loadPaths.every(validateCanonicalAbsolutePath) ||
    new Set(loadPaths).size !== loadPaths.length
  )
    return null;
  return { id, installPath, loadPaths: [...loadPaths] };
}

function extensionDirForInstall(
  install: OpenClawImagePluginInstall,
  dir: string,
): { ok: true; extensionDir: string | null } | { ok: false; error: string } {
  const extensionsDir = `${dir.replace(/\/+$/, "")}/extensions`;
  const relativeInstallPath = path.posix.relative(extensionsDir, install.installPath);
  if (
    relativeInstallPath.startsWith("../") ||
    relativeInstallPath === ".." ||
    path.posix.isAbsolute(relativeInstallPath)
  ) {
    return { ok: true, extensionDir: null };
  }
  if (
    relativeInstallPath.length === 0 ||
    relativeInstallPath.includes("/") ||
    !isSafeOpenClawExtensionDirName(relativeInstallPath)
  ) {
    return {
      ok: false,
      error: `fresh OpenClaw plugin install path is invalid for ${install.id}`,
    };
  }
  return { ok: true, extensionDir: relativeInstallPath };
}

function validateOpenClawImagePluginInstalls(
  entries: readonly (readonly [string, unknown, unknown])[],
  dir: string,
): OpenClawManagedExtensionDiscoveryResult {
  if (entries.length > MAX_OPENCLAW_IMAGE_MANAGED_PLUGIN_INSTALLS) {
    return {
      ok: false,
      error: `fresh OpenClaw registry has too many plugin installs (${entries.length})`,
    };
  }

  const ids = new Set<string>();
  const installPaths = new Set<string>();
  const loadPaths = new Set<string>();
  const extensionDirs = new Set<string>();
  const pluginInstalls: OpenClawImagePluginInstall[] = [];
  for (const [id, installPath, durableLoadPaths] of entries) {
    const install = validateDurableOpenClawImagePluginInstall(id, installPath, durableLoadPaths);
    if (!install) {
      return { ok: false, error: `fresh OpenClaw plugin install metadata is invalid: ${id}` };
    }
    if (
      ids.has(install.id) ||
      installPaths.has(install.installPath) ||
      install.loadPaths?.some((loadPath) => loadPaths.has(loadPath))
    ) {
      return { ok: false, error: `fresh OpenClaw plugin install provenance is duplicated: ${id}` };
    }
    const projected = extensionDirForInstall(install, dir);
    if (!projected.ok) return projected;
    if (projected.extensionDir && extensionDirs.has(projected.extensionDir)) {
      return { ok: false, error: `fresh OpenClaw extension directory is duplicated: ${id}` };
    }
    ids.add(install.id);
    installPaths.add(install.installPath);
    for (const loadPath of install.loadPaths ?? []) loadPaths.add(loadPath);
    pluginInstalls.push(install);
    if (projected.extensionDir) extensionDirs.add(projected.extensionDir);
  }
  return {
    ok: true,
    extensionDirs: [...extensionDirs].sort(),
    pluginInstalls: pluginInstalls.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function parseOpenClawImagePluginInstalls(
  value: unknown,
  dir: string,
): OpenClawManagedExtensionDiscoveryResult {
  if (!Array.isArray(value)) {
    return { ok: false, error: "OpenClaw image plugin provenance is invalid" };
  }
  return validateOpenClawImagePluginInstalls(
    value.map((entry) => [
      isRecord(entry) && typeof entry.id === "string" ? entry.id : "",
      isRecord(entry) ? entry.installPath : undefined,
      isRecord(entry) ? entry.loadPaths : undefined,
    ]),
    dir,
  );
}

/** True only for explicit, fully validated provenance; an explicit empty array is complete. */
export function hasCompleteOpenClawImagePluginProvenance(
  value: unknown,
  dir: string,
): value is readonly CompleteOpenClawImagePluginInstall[] {
  return Array.isArray(value) && parseOpenClawImagePluginInstalls(value, dir).ok;
}

export function parseFreshOpenClawPluginExtensionDirs(
  registryIndex: unknown,
  dir: string,
): OpenClawManagedExtensionDiscoveryResult {
  if (!isRecord(registryIndex) || registryIndex.version !== 1) {
    return { ok: false, error: "fresh OpenClaw plugin install registry is invalid" };
  }
  const installs = registryIndex.installRecords;
  if (!isRecord(installs)) {
    return { ok: false, error: "fresh OpenClaw plugin install records are invalid" };
  }

  const configuredLoadPaths = registryIndex.loadPaths;
  if (
    !Array.isArray(configuredLoadPaths) ||
    configuredLoadPaths.length > MAX_OPENCLAW_CONFIGURED_PLUGIN_LOAD_PATHS ||
    !configuredLoadPaths.every(validateConfiguredLoadPath)
  ) {
    return { ok: false, error: "fresh OpenClaw configured plugin load paths are invalid" };
  }
  const configuredLoadPathSet = new Set(configuredLoadPaths);

  const entries = Object.keys(installs)
    .sort()
    .map((id) => {
      const metadata = installs[id];
      if (!isRecord(metadata) || !OPENCLAW_PLUGIN_INSTALL_SOURCES.has(String(metadata.source))) {
        return [id, undefined, undefined] as const;
      }
      if (
        metadata.sourcePath !== undefined &&
        !validateCanonicalAbsolutePath(metadata.sourcePath)
      ) {
        return [id, undefined, undefined] as const;
      }
      if (metadata.source === "path" && !validateCanonicalAbsolutePath(metadata.sourcePath)) {
        return [id, undefined, undefined] as const;
      }
      const loadPaths =
        metadata.source === "path" && configuredLoadPathSet.has(String(metadata.sourcePath))
          ? [String(metadata.sourcePath)]
          : [];
      return [id, metadata.installPath, loadPaths] as const;
    });
  return validateOpenClawImagePluginInstalls(entries, dir);
}

export function planOpenClawPluginRestore(options: {
  agentType: string;
  dir: string;
  localDirs: readonly string[];
  freshImagePluginInstalls?: readonly OpenClawImagePluginInstall[];
  previousImagePluginInstalls?: readonly OpenClawImagePluginInstall[];
}): OpenClawPluginRestorePlanResult {
  const freshProjection = parseOpenClawImagePluginInstalls(
    options.freshImagePluginInstalls ?? [],
    options.dir,
  );
  if (!freshProjection.ok) return freshProjection;

  const previousImagePluginInstalls =
    options.freshImagePluginInstalls !== undefined
      ? options.previousImagePluginInstalls
      : undefined;
  const previousProjection = parseOpenClawImagePluginInstalls(
    previousImagePluginInstalls ?? [],
    options.dir,
  );
  if (!previousProjection.ok) return previousProjection;

  // The same ID in both projections is an image-owned plugin upgrade, not a
  // provenance collision. Fresh ownership wins during config merge; retaining
  // the previous projection here only excludes its old directory from the
  // user backup so stale image code cannot be restored over the fresh install.

  const preserveManagedExtensions = shouldPreserveOpenClawManagedExtensions(
    { agentType: options.agentType },
    options.dir,
    options.localDirs,
  );
  const freshExtensionDirs = preserveManagedExtensions ? freshProjection.extensionDirs : [];
  const previousExtensionDirs =
    preserveManagedExtensions && previousImagePluginInstalls !== undefined
      ? previousProjection.extensionDirs
      : [];
  const preservedExtensionDirs = preserveManagedExtensions
    ? [...new Set([...OPENCLAW_IMAGE_MANAGED_EXTENSION_DIRS, ...freshExtensionDirs])].sort()
    : [];
  const archiveExcludedExtensionDirs = preserveManagedExtensions
    ? [...new Set([...preservedExtensionDirs, ...previousExtensionDirs])].sort()
    : [];

  return {
    ok: true,
    freshExtensionDirs,
    previousExtensionDirs,
    preservedExtensionDirs,
    archiveExcludedExtensionDirs,
    requiredFreshExtensionDirs: freshExtensionDirs,
  };
}
