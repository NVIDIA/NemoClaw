// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { create as createTar } from "tar";
import JSON5 from "json5";
import type { PluginLogger } from "../index.js";

const SANDBOX_MIGRATION_DIR = "/sandbox/.nemoclaw/migration";
const SNAPSHOT_VERSION = 2;

export type MigrationRootKind = "workspace" | "agentDir" | "skillsExtraDir";

export interface MigrationRootBinding {
  configPath: string;
}

export interface MigrationExternalRoot {
  id: string;
  kind: MigrationRootKind;
  label: string;
  sourcePath: string;
  snapshotRelativePath: string;
  sandboxPath: string;
  symlinkPaths: string[];
  bindings: MigrationRootBinding[];
}

export interface HostOpenClawState {
  exists: boolean;
  homeDir: string | null;
  stateDir: string | null;
  configDir: string | null;
  configPath: string | null;
  workspaceDir: string | null;
  extensionsDir: string | null;
  skillsDir: string | null;
  hooksDir: string | null;
  externalRoots: MigrationExternalRoot[];
  warnings: string[];
  errors: string[];
  hasExternalConfig: boolean;
}

export interface SnapshotManifest {
  version: number;
  createdAt: string;
  homeDir: string;
  stateDir: string;
  configPath: string | null;
  hasExternalConfig: boolean;
  externalRoots: MigrationExternalRoot[];
  warnings: string[];
}

export interface SnapshotBundle {
  snapshotDir: string;
  snapshotPath: string;
  preparedStateDir: string;
  archivesDir: string;
  manifest: SnapshotManifest;
  temporary: boolean;
}

type CandidateRoot = {
  id: string;
  kind: MigrationRootKind;
  label: string;
  sourcePath: string;
  sandboxPath: string;
  bindings: MigrationRootBinding[];
  required: boolean;
};

type OpenClawConfigDocument = Record<string, unknown>;

function resolveHostHome(env: NodeJS.ProcessEnv = process.env): string {
  const fallbackHome = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
  const explicitHome = env.OPENCLAW_HOME?.trim();
  if (explicitHome) {
    if (explicitHome === "~") {
      return fallbackHome;
    }
    if (explicitHome.startsWith("~/") || explicitHome.startsWith("~\\")) {
      return path.join(fallbackHome, explicitHome.slice(2));
    }
    return path.resolve(explicitHome);
  }
  return fallbackHome;
}

function resolveUserPath(input: string, env: NodeJS.ProcessEnv = process.env): string {
  if (input === "~") {
    return resolveHostHome(env);
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(resolveHostHome(env), input.slice(2));
  }
  return path.resolve(input);
}

function normalizeHostPath(input: string): string {
  const resolved = path.resolve(input);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithinRoot(candidatePath: string, rootPath: string): boolean {
  const candidate = normalizeHostPath(candidatePath);
  const root = normalizeHostPath(rootPath);
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    return resolveUserPath(override, env);
  }
  return path.join(resolveHostHome(env), ".openclaw");
}

function resolveConfigPath(stateDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCLAW_CONFIG_PATH?.trim();
  if (override) {
    return resolveUserPath(override, env);
  }
  return path.join(stateDir, "openclaw.json");
}

function loadConfigDocument(configPath: string): OpenClawConfigDocument | null {
  if (!existsSync(configPath)) {
    return null;
  }
  const raw = readFileSync(configPath, "utf-8");
  const parsed: unknown = JSON5.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Config at ${configPath} is not a JSON object.`);
  }
  return parsed as OpenClawConfigDocument;
}

function collectSymlinkPaths(rootPath: string): string[] {
  const symlinks: string[] = [];

  function walk(currentPath: string, relativePath: string): void {
    const stat = lstatSync(currentPath);
    if (stat.isSymbolicLink()) {
      symlinks.push(relativePath || ".");
      return;
    }
    if (!stat.isDirectory()) {
      return;
    }
    for (const entry of readdirSync(currentPath)) {
      const nextPath = path.join(currentPath, entry);
      const nextRelative = relativePath ? path.join(relativePath, entry) : entry;
      walk(nextPath, nextRelative);
    }
  }

  walk(rootPath, "");
  return symlinks.sort();
}

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "root";
}

function registerRoot(
  rootMap: Map<string, CandidateRoot>,
  params: {
    pathValue: string;
    kind: MigrationRootKind;
    label: string;
    bindingPath: string;
    sandboxGroup: string;
    required: boolean;
  },
): void {
  const resolvedPath = resolveUserPath(params.pathValue);
  const normalized = normalizeHostPath(resolvedPath);
  const existing = rootMap.get(normalized);
  if (existing) {
    existing.bindings.push({ configPath: params.bindingPath });
    return;
  }

  const id = `${params.sandboxGroup}-${slugify(params.label)}`;
  rootMap.set(normalized, {
    id,
    kind: params.kind,
    label: params.label,
    sourcePath: resolvedPath,
    sandboxPath: path.posix.join(SANDBOX_MIGRATION_DIR, params.sandboxGroup, id),
    bindings: [{ configPath: params.bindingPath }],
    required: params.required,
  });
}

function defaultWorkspacePath(env: NodeJS.ProcessEnv = process.env): string {
  const home = resolveHostHome(env);
  const profile = env.OPENCLAW_PROFILE?.trim();
  if (profile && profile.toLowerCase() !== "default") {
    return path.join(home, ".openclaw", `workspace-${profile}`);
  }
  return path.join(home, ".openclaw", "workspace");
}

function collectExternalRoots(
  config: OpenClawConfigDocument | null,
  stateDir: string,
): { roots: MigrationExternalRoot[]; warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  const rootMap = new Map<string, CandidateRoot>();

  const agents = config?.["agents"];
  const agentDefaults =
    agents && typeof agents === "object" && !Array.isArray(agents)
      ? (agents as Record<string, unknown>)["defaults"]
      : undefined;
  const agentList =
    agents && typeof agents === "object" && !Array.isArray(agents)
      ? (agents as Record<string, unknown>)["list"]
      : undefined;
  const skills = config?.["skills"];
  const skillLoad =
    skills && typeof skills === "object" && !Array.isArray(skills)
      ? (skills as Record<string, unknown>)["load"]
      : undefined;

  const defaultsWorkspace =
    agentDefaults && typeof agentDefaults === "object" && !Array.isArray(agentDefaults)
      ? (agentDefaults as Record<string, unknown>)["workspace"]
      : undefined;
  const defaultWorkspace =
    typeof defaultsWorkspace === "string" && defaultsWorkspace.trim()
      ? defaultsWorkspace.trim()
      : defaultWorkspacePath();
  registerRoot(rootMap, {
    pathValue: defaultWorkspace,
    kind: "workspace",
    label: "default-workspace",
    bindingPath: "agents.defaults.workspace",
    sandboxGroup: "workspaces",
    required: typeof defaultsWorkspace === "string" && defaultsWorkspace.trim().length > 0,
  });

  if (Array.isArray(agentList)) {
    agentList.forEach((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return;
      }
      const agent = entry as Record<string, unknown>;
      const agentId =
        typeof agent["id"] === "string" && agent["id"].trim()
          ? agent["id"].trim()
          : `agent-${String(index)}`;

      if (typeof agent["workspace"] === "string" && agent["workspace"].trim()) {
        registerRoot(rootMap, {
          pathValue: agent["workspace"].trim(),
          kind: "workspace",
          label: `${agentId}-workspace`,
          bindingPath: `agents.list[${String(index)}].workspace`,
          sandboxGroup: "workspaces",
          required: true,
        });
      }

      if (typeof agent["agentDir"] === "string" && agent["agentDir"].trim()) {
        registerRoot(rootMap, {
          pathValue: agent["agentDir"].trim(),
          kind: "agentDir",
          label: `${agentId}-agent-dir`,
          bindingPath: `agents.list[${String(index)}].agentDir`,
          sandboxGroup: "agent-dirs",
          required: true,
        });
      }
    });
  }

  const extraDirs =
    skillLoad && typeof skillLoad === "object" && !Array.isArray(skillLoad)
      ? (skillLoad as Record<string, unknown>)["extraDirs"]
      : undefined;
  if (Array.isArray(extraDirs)) {
    extraDirs.forEach((entry, index) => {
      if (typeof entry !== "string" || !entry.trim()) {
        return;
      }
      registerRoot(rootMap, {
        pathValue: entry.trim(),
        kind: "skillsExtraDir",
        label: `skills-extra-${String(index + 1)}`,
        bindingPath: `skills.load.extraDirs[${String(index)}]`,
        sandboxGroup: "skills",
        required: true,
      });
    });
  }

  const roots = [...rootMap.values()]
    .filter((root) => !isWithinRoot(root.sourcePath, stateDir))
    .map<MigrationExternalRoot>((root) => ({
      id: root.id,
      kind: root.kind,
      label: root.label,
      sourcePath: root.sourcePath,
      snapshotRelativePath: path.join("external", root.id),
      sandboxPath: root.sandboxPath,
      symlinkPaths: [],
      bindings: root.bindings,
    }));

  const validRoots: MigrationExternalRoot[] = [];
  for (const root of roots) {
    if (!existsSync(root.sourcePath)) {
      const message = `${root.kind} path is missing: ${root.sourcePath} (${root.bindings
        .map((binding) => binding.configPath)
        .join(", ")})`;
      if (rootMap.get(normalizeHostPath(root.sourcePath))?.required) {
        errors.push(`Configured ${message}`);
      } else {
        warnings.push(`Skipping absent optional ${message}`);
      }
      continue;
    }
    try {
      const stat = lstatSync(root.sourcePath);
      if (!stat.isDirectory()) {
        errors.push(
          `${root.kind} path is not a directory: ${root.sourcePath} (${root.bindings
            .map((binding) => binding.configPath)
            .join(", ")})`,
        );
        continue;
      }
      root.symlinkPaths = collectSymlinkPaths(root.sourcePath);
      if (root.symlinkPaths.length > 0) {
        warnings.push(
          `Preserving ${String(root.symlinkPaths.length)} symlink(s) under ${root.sourcePath} during migration.`,
        );
      }
      validRoots.push(root);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Failed to inspect ${root.sourcePath}: ${msg}`);
    }
  }

  return { roots: validRoots, warnings, errors };
}

export function detectHostOpenClaw(env: NodeJS.ProcessEnv = process.env): HostOpenClawState {
  const homeDir = resolveHostHome(env);
  const stateDir = resolveStateDir(env);
  const configPath = resolveConfigPath(stateDir, env);
  const stateExists = existsSync(stateDir);
  const configExists = existsSync(configPath);

  if (!stateExists && !configExists) {
    return {
      exists: false,
      homeDir,
      stateDir: null,
      configDir: null,
      configPath: null,
      workspaceDir: null,
      extensionsDir: null,
      skillsDir: null,
      hooksDir: null,
      externalRoots: [],
      warnings: [],
      errors: [],
      hasExternalConfig: false,
    };
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  let config: OpenClawConfigDocument | null = null;

  if (!stateExists) {
    errors.push(`Resolved OpenClaw state directory does not exist: ${stateDir}`);
  }

  try {
    config = loadConfigDocument(configPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Failed to parse OpenClaw config at ${configPath}: ${msg}`);
  }

  const rootInfo = collectExternalRoots(config, stateDir);
  warnings.push(...rootInfo.warnings);
  errors.push(...rootInfo.errors);

  const workspaceDir =
    config &&
    typeof config["agents"] === "object" &&
    config["agents"] &&
    !Array.isArray(config["agents"]) &&
    typeof (
      (config["agents"] as Record<string, unknown>)["defaults"] as
        | Record<string, unknown>
        | undefined
    )?.["workspace"] === "string"
      ? resolveUserPath(
          (
            ((config["agents"] as Record<string, unknown>)["defaults"] as Record<string, unknown>)[
              "workspace"
            ] as string
          ).trim(),
          env,
        )
      : defaultWorkspacePath(env);

  const extensionsDir = existsSync(path.join(stateDir, "extensions"))
    ? path.join(stateDir, "extensions")
    : null;
  const skillsDir = existsSync(path.join(stateDir, "skills"))
    ? path.join(stateDir, "skills")
    : null;
  const hooksDir = existsSync(path.join(stateDir, "hooks")) ? path.join(stateDir, "hooks") : null;

  if (existsSync(workspaceDir)) {
    try {
      const symlinkPaths = collectSymlinkPaths(workspaceDir);
      if (symlinkPaths.length > 0) {
        warnings.push(
          `Primary workspace contains ${String(symlinkPaths.length)} symlink(s): ${workspaceDir}.`,
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Failed to inspect workspace symlinks at ${workspaceDir}: ${msg}`);
    }
  }

  return {
    exists: true,
    homeDir,
    stateDir,
    configDir: stateDir,
    configPath: configExists ? configPath : null,
    workspaceDir: existsSync(workspaceDir) ? workspaceDir : null,
    extensionsDir,
    skillsDir,
    hooksDir,
    externalRoots: rootInfo.roots,
    warnings,
    errors,
    hasExternalConfig: configExists && !isWithinRoot(configPath, stateDir),
  };
}

function copyDirectory(sourcePath: string, destinationPath: string): void {
  cpSync(sourcePath, destinationPath, {
    recursive: true,
  });
}

function writeSnapshotManifest(snapshotDir: string, manifest: SnapshotManifest): void {
  writeFileSync(path.join(snapshotDir, "snapshot.json"), JSON.stringify(manifest, null, 2));
}

function readSnapshotManifest(snapshotDir: string): SnapshotManifest {
  return JSON.parse(
    readFileSync(path.join(snapshotDir, "snapshot.json"), "utf-8"),
  ) as SnapshotManifest;
}

function resolveConfigSourcePath(manifest: SnapshotManifest, snapshotDir: string): string {
  if (manifest.hasExternalConfig) {
    return path.join(snapshotDir, "config", "openclaw.json");
  }
  return path.join(snapshotDir, "openclaw", "openclaw.json");
}

function setConfigValue(
  document: Record<string, unknown>,
  configPath: string,
  value: string,
): void {
  const tokens = configPath.match(/[^.[\]]+/g);
  if (!tokens || tokens.length === 0) {
    throw new Error(`Invalid config path: ${configPath}`);
  }

  let current: unknown = document;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index];
    const nextToken = tokens[index + 1];
    if (!token || !nextToken) {
      throw new Error(`Invalid config path segment in ${configPath}`);
    }
    const isArrayIndex = /^\d+$/.test(token);

    if (isArrayIndex) {
      const array = current as unknown[];
      const entry = array[Number.parseInt(token, 10)];
      if (entry == null) {
        array[Number.parseInt(token, 10)] = /^\d+$/.test(nextToken) ? [] : {};
      }
      current = array[Number.parseInt(token, 10)];
      continue;
    }

    const record = current as Record<string, unknown>;
    if (!record[token] || typeof record[token] !== "object") {
      record[token] = /^\d+$/.test(nextToken) ? [] : {};
    }
    current = record[token];
  }

  const finalToken = tokens[tokens.length - 1];
  if (!finalToken) {
    throw new Error(`Missing final config path segment in ${configPath}`);
  }
  if (/^\d+$/.test(finalToken)) {
    const array = current as unknown[];
    array[Number.parseInt(finalToken, 10)] = value;
    return;
  }
  (current as Record<string, unknown>)[finalToken] = value;
}

function prepareSandboxState(snapshotDir: string, manifest: SnapshotManifest): string {
  const preparedStateDir = path.join(snapshotDir, "sandbox-bundle", "openclaw");
  rmSync(preparedStateDir, { recursive: true, force: true });
  mkdirSync(path.dirname(preparedStateDir), { recursive: true });
  copyDirectory(path.join(snapshotDir, "openclaw"), preparedStateDir);

  const configSourcePath = resolveConfigSourcePath(manifest, snapshotDir);
  const config = existsSync(configSourcePath) ? (loadConfigDocument(configSourcePath) ?? {}) : {};

  for (const root of manifest.externalRoots) {
    for (const binding of root.bindings) {
      setConfigValue(config, binding.configPath, root.sandboxPath);
    }
  }

  writeFileSync(path.join(preparedStateDir, "openclaw.json"), JSON.stringify(config, null, 2));
  return preparedStateDir;
}

export function createSnapshotBundle(
  hostState: HostOpenClawState,
  logger: PluginLogger,
  options: { persist: boolean },
): SnapshotBundle | null {
  if (!hostState.stateDir || !hostState.homeDir) {
    logger.error("Cannot snapshot host OpenClaw state: no state directory was resolved.");
    return null;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const parentDir = path.join(
    hostState.homeDir,
    ".nemoclaw",
    options.persist ? "snapshots" : "staging",
    timestamp,
  );

  try {
    mkdirSync(parentDir, { recursive: true });
    const snapshotStateDir = path.join(parentDir, "openclaw");
    copyDirectory(hostState.stateDir, snapshotStateDir);

    if (hostState.configPath && hostState.hasExternalConfig) {
      const configSnapshotDir = path.join(parentDir, "config");
      mkdirSync(configSnapshotDir, { recursive: true });
      copyFileSync(hostState.configPath, path.join(configSnapshotDir, "openclaw.json"));
    }

    const externalRoots: MigrationExternalRoot[] = [];
    for (const root of hostState.externalRoots) {
      const destination = path.join(parentDir, root.snapshotRelativePath);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyDirectory(root.sourcePath, destination);
      externalRoots.push({
        ...root,
        symlinkPaths: collectSymlinkPaths(root.sourcePath),
      });
    }

    const manifest: SnapshotManifest = {
      version: SNAPSHOT_VERSION,
      createdAt: new Date().toISOString(),
      homeDir: hostState.homeDir,
      stateDir: hostState.stateDir,
      configPath: hostState.configPath,
      hasExternalConfig: hostState.hasExternalConfig,
      externalRoots,
      warnings: hostState.warnings,
    };

    writeSnapshotManifest(parentDir, manifest);

    return {
      snapshotDir: parentDir,
      snapshotPath: path.join(parentDir, "snapshot.json"),
      preparedStateDir: prepareSandboxState(parentDir, manifest),
      archivesDir: path.join(parentDir, "sandbox-bundle", "archives"),
      manifest,
      temporary: !options.persist,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Snapshot failed: ${msg}`);
    return null;
  }
}

export function cleanupSnapshotBundle(bundle: SnapshotBundle): void {
  if (bundle.temporary) {
    rmSync(bundle.snapshotDir, { recursive: true, force: true });
  }
}

export async function createArchiveFromDirectory(
  sourceDir: string,
  archivePath: string,
): Promise<void> {
  mkdirSync(path.dirname(archivePath), { recursive: true });
  await createTar(
    {
      cwd: sourceDir,
      file: archivePath,
      portable: true,
      follow: false,
      noMtime: true,
    },
    ["."],
  );
}

export function loadSnapshotManifest(snapshotDir: string): SnapshotManifest {
  return readSnapshotManifest(snapshotDir);
}

export function restoreSnapshotToHost(snapshotDir: string, logger: PluginLogger): boolean {
  const manifest = readSnapshotManifest(snapshotDir);
  const snapshotStateDir = path.join(snapshotDir, "openclaw");
  if (!existsSync(snapshotStateDir)) {
    logger.error(`Snapshot directory not found: ${snapshotStateDir}`);
    return false;
  }

  // SECURITY (C-4): Validate that write targets are within a trusted root.
  // Use the host's actual home directory — NOT manifest.homeDir which is
  // attacker-controlled data from the snapshot JSON.
  const trustedRoot = resolveHostHome();

  // Validate manifest.homeDir itself is within trusted root
  if (typeof manifest.homeDir !== "string" || !isWithinRoot(manifest.homeDir, trustedRoot)) {
    logger.error(
      `Snapshot manifest homeDir is outside the trusted host root. ` +
        `Refusing to restore. homeDir=${manifest.homeDir}, trustedRoot=${trustedRoot}`,
    );
    return false;
  }

  // Validate stateDir type and containment
  if (typeof manifest.stateDir !== "string") {
    logger.error(`Snapshot manifest stateDir is not a string. Refusing to restore.`);
    return false;
  }

  // Support OPENCLAW_STATE_DIR env override: when set, require exact match
  const envStateDir = process.env.OPENCLAW_STATE_DIR?.trim();
  if (envStateDir) {
    const resolvedEnvStateDir = resolveUserPath(envStateDir);
    if (normalizeHostPath(manifest.stateDir) !== normalizeHostPath(resolvedEnvStateDir)) {
      logger.error(
        `Snapshot manifest stateDir does not match OPENCLAW_STATE_DIR. ` +
          `Refusing to restore. stateDir=${manifest.stateDir}, expected=${resolvedEnvStateDir}`,
      );
      return false;
    }
  } else if (!isWithinRoot(manifest.stateDir, trustedRoot)) {
    logger.error(
      `Snapshot manifest stateDir is outside the trusted host root. ` +
        `Refusing to restore. stateDir=${manifest.stateDir}, trustedRoot=${trustedRoot}`,
    );
    return false;
  }

  if (manifest.hasExternalConfig) {
    // Validate configPath type — fail closed when hasExternalConfig is true
    // but configPath is null/empty (partial restore would silently skip config).
    if (typeof manifest.configPath !== "string" || !manifest.configPath.trim()) {
      logger.error(
        `Snapshot manifest has hasExternalConfig=true but configPath is missing or empty. Refusing to restore.`,
      );
      return false;
    }

    // Support OPENCLAW_CONFIG_PATH env override: when set, require exact match
    const envConfigPath = process.env.OPENCLAW_CONFIG_PATH?.trim();
    if (envConfigPath) {
      const resolvedEnvConfigPath = resolveUserPath(envConfigPath);
      if (normalizeHostPath(manifest.configPath) !== normalizeHostPath(resolvedEnvConfigPath)) {
        logger.error(
          `Snapshot manifest configPath does not match OPENCLAW_CONFIG_PATH. ` +
            `Refusing to restore. configPath=${manifest.configPath}, expected=${resolvedEnvConfigPath}`,
        );
        return false;
      }
    } else if (!isWithinRoot(manifest.configPath, trustedRoot)) {
      logger.error(
        `Snapshot manifest configPath is outside the trusted host root. ` +
          `Refusing to restore. configPath=${manifest.configPath}, trustedRoot=${trustedRoot}`,
      );
      return false;
    }
  }

  try {
    if (existsSync(manifest.stateDir)) {
      const archiveName = `${manifest.stateDir}.nemoclaw-archived-${String(Date.now())}`;
      renameSync(manifest.stateDir, archiveName);
      logger.info(`Archived current state directory to ${archiveName}`);
    }

    mkdirSync(path.dirname(manifest.stateDir), { recursive: true });
    copyDirectory(snapshotStateDir, manifest.stateDir);

    if (manifest.hasExternalConfig && manifest.configPath) {
      const configSnapshotPath = path.join(snapshotDir, "config", "openclaw.json");
      mkdirSync(path.dirname(manifest.configPath), { recursive: true });
      copyFileSync(configSnapshotPath, manifest.configPath);
      logger.info(`Restored external config to ${manifest.configPath}`);
    }

    logger.info("Host OpenClaw state restored.");
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Restoration failed: ${msg}`);
    return false;
  }
}
