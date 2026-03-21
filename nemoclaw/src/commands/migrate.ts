// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { join, posix as pathPosix } from "node:path";
import type { PluginLogger, NemoClawConfig } from "../index.js";
import { resolveBlueprint } from "../blueprint/resolve.js";
import { verifyBlueprintDigest } from "../blueprint/verify.js";
import { execBlueprint } from "../blueprint/exec.js";
import { loadState, saveState } from "../blueprint/state.js";
import {
  cleanupSnapshotBundle,
  createArchiveFromDirectory,
  createSnapshotBundle,
  detectHostOpenClaw,
  loadSnapshotManifest,
  type SnapshotBundle,
} from "./migration-state.js";

export { detectHostOpenClaw, type HostOpenClawState } from "./migration-state.js";

const SANDBOX_ARCHIVE_DIR = "/sandbox/.nemoclaw/migration/archives";

export interface MigrateOptions {
  dryRun: boolean;
  profile: string;
  skipBackup: boolean;
  logger: PluginLogger;
  pluginConfig: NemoClawConfig;
}

export async function cliMigrate(opts: MigrateOptions): Promise<void> {
  const { dryRun, profile, skipBackup, logger, pluginConfig } = opts;

  logger.info("NemoClaw migrate: moving host OpenClaw into OpenShell sandbox");

  logger.info("Detecting host OpenClaw installation...");
  const hostState = detectHostOpenClaw();

  if (!hostState.exists || !hostState.stateDir) {
    logger.error("No OpenClaw installation found for the current host environment.");
    logger.info("Use 'openclaw nemoclaw launch' for a fresh install.");
    return;
  }

  logger.info(`Resolved state dir: ${hostState.stateDir}`);
  if (hostState.configPath) logger.info(`  Config: ${hostState.configPath}`);
  if (hostState.workspaceDir) logger.info(`  Workspace: ${hostState.workspaceDir}`);
  if (hostState.extensionsDir) logger.info(`  Extensions: ${hostState.extensionsDir}`);
  if (hostState.skillsDir) logger.info(`  Skills: ${hostState.skillsDir}`);
  if (hostState.hooksDir) logger.info(`  Hooks: ${hostState.hooksDir}`);
  for (const root of hostState.externalRoots) {
    logger.info(`  External ${root.kind}: ${root.sourcePath} -> ${root.sandboxPath}`);
  }
  for (const warning of hostState.warnings) {
    logger.warn(warning);
  }
  if (hostState.errors.length > 0) {
    for (const error of hostState.errors) {
      logger.error(error);
    }
    logger.error("Refusing to migrate until all external OpenClaw roots can be resolved.");
    return;
  }

  if (dryRun) {
    logger.info("");
    logger.info("[Dry run] Would perform the following:");
    logger.info(`  1. Snapshot state dir: ${hostState.stateDir}`);
    if (hostState.configPath && hostState.hasExternalConfig) {
      logger.info(`  2. Capture external config file: ${hostState.configPath}`);
    }
    if (hostState.externalRoots.length > 0) {
      logger.info("  3. Capture external OpenClaw roots and rewrite config paths for the sandbox:");
      for (const root of hostState.externalRoots) {
        logger.info(`     - ${root.sourcePath} -> ${root.sandboxPath}`);
      }
      logger.info("  4. Package state and external roots as tar archives to preserve symlinks");
      logger.info("  5. Copy archives into the OpenShell sandbox and verify the migrated paths");
    } else {
      logger.info("  3. Package state dir as a tar archive to preserve symlinks");
      logger.info("  4. Copy the state archive into the OpenShell sandbox and verify the config");
    }
    logger.info("  6. Leave the host installation untouched and keep a rollback snapshot");
    return;
  }

  logger.info("Resolving blueprint...");
  const blueprint = await resolveBlueprint(pluginConfig);

  logger.info("Verifying blueprint...");
  const verification = verifyBlueprintDigest(blueprint.localPath, blueprint.manifest);
  if (!verification.valid) {
    logger.error(`Blueprint verification failed: ${verification.errors.join(", ")}`);
    return;
  }

  logger.info("Planning migration...");
  const planResult = await execBlueprint(
    {
      blueprintPath: blueprint.localPath,
      action: "plan",
      profile,
      jsonOutput: true,
    },
    logger,
  );

  if (!planResult.success) {
    logger.error(`Migration plan failed: ${planResult.output}`);
    return;
  }

  logger.info("Provisioning OpenShell sandbox...");
  const applyResult = await execBlueprint(
    {
      blueprintPath: blueprint.localPath,
      action: "apply",
      profile,
      planPath: planResult.runId,
      jsonOutput: true,
    },
    logger,
  );

  if (!applyResult.success) {
    logger.error(`Migration apply failed: ${applyResult.output}`);
    return;
  }

  logger.info("Creating migration snapshot...");
  const bundle = createSnapshotBundle(hostState, logger, { persist: !skipBackup });
  if (!bundle) {
    return;
  }
  logger.info(`Snapshot saved to ${bundle.snapshotDir}`);

  try {
    logger.info("Packaging OpenClaw state for sandbox import...");
    await buildMigrationArchives(bundle);

    logger.info("Syncing migration bundle into sandbox...");
    syncSnapshotBundleIntoSandbox(bundle, pluginConfig.sandboxName);

    logger.info("Verifying sandbox migration...");
    verifySandboxMigration(bundle, pluginConfig.sandboxName);

    saveState({
      ...loadState(),
      lastRunId: applyResult.runId,
      lastAction: "migrate",
      blueprintVersion: blueprint.version,
      sandboxName: pluginConfig.sandboxName,
      migrationSnapshot: skipBackup ? null : bundle.snapshotDir,
      hostBackupPath: skipBackup ? null : bundle.snapshotDir,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Migration sync failed: ${msg}`);
    logger.info("Your host installation is unchanged. Resolve the error and rerun migrate.");
    return;
  } finally {
    cleanupSnapshotBundle(bundle);
  }

  logger.info("");
  logger.info("Migration complete. OpenClaw is now running inside OpenShell.");
  logger.info(`Sandbox: ${pluginConfig.sandboxName}`);
  logger.info("");
  logger.info("Next steps:");
  logger.info("  openclaw nemoclaw connect    # Enter the sandbox");
  logger.info("  openclaw nemoclaw status     # Verify everything is healthy");
  logger.info("  openshell term               # Monitor sandbox activity");
  logger.info("");
  logger.info("To rollback to your host installation:");
  if (skipBackup) {
    logger.info("  Re-run migrate without --skip-backup to keep a rollback snapshot.");
  } else {
    logger.info("  openclaw nemoclaw eject");
  }
}

async function buildMigrationArchives(bundle: SnapshotBundle): Promise<void> {
  await createArchiveFromDirectory(bundle.preparedStateDir, stateArchivePath(bundle));
  for (const root of bundle.manifest.externalRoots) {
    await createArchiveFromDirectory(
      join(bundle.snapshotDir, root.snapshotRelativePath),
      rootArchivePath(bundle, root.id),
    );
  }
}

function syncSnapshotBundleIntoSandbox(bundle: SnapshotBundle, sandboxName: string): void {
  execSandboxCommand(sandboxName, ["sh", "-lc", `mkdir -p ${shellQuote(SANDBOX_ARCHIVE_DIR)}`]);

  syncArchive(sandboxName, "state.tar", stateArchivePath(bundle), "/sandbox/.openclaw");
  for (const root of bundle.manifest.externalRoots) {
    syncArchive(sandboxName, `${root.id}.tar`, rootArchivePath(bundle, root.id), root.sandboxPath);
  }
}

function syncArchive(
  sandboxName: string,
  archiveName: string,
  archivePath: string,
  destinationDir: string,
): void {
  const sandboxArchivePath = pathPosix.join(SANDBOX_ARCHIVE_DIR, archiveName);
  execFileSync(
    "openshell",
    ["sandbox", "cp", archivePath, `${sandboxName}:${sandboxArchivePath}`],
    {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const extractCommand = [
    "sh",
    "-lc",
    `mkdir -p ${shellQuote(destinationDir)} && tar -xf ${shellQuote(sandboxArchivePath)} -C ${shellQuote(
      destinationDir,
    )}`,
  ];
  execSandboxCommand(sandboxName, extractCommand);
}

function verifySandboxMigration(bundle: SnapshotBundle, sandboxName: string): void {
  const manifest = loadSnapshotManifest(bundle.snapshotDir);
  const verification = {
    stateDir: "/sandbox/.openclaw",
    configPath: "/sandbox/.openclaw/openclaw.json",
    roots: manifest.externalRoots.map((root) => ({
      id: root.id,
      sandboxPath: root.sandboxPath,
      bindings: root.bindings.map((binding) => ({
        path: binding.configPath,
        value: root.sandboxPath,
      })),
      symlinkPaths: root.symlinkPaths,
    })),
  };

  const script = `
const fs = require("node:fs");
const verification = ${JSON.stringify(verification)};
if (!fs.existsSync(verification.stateDir)) {
  throw new Error(\`Missing migrated state dir: \${verification.stateDir}\`);
}
const config = JSON.parse(fs.readFileSync(verification.configPath, "utf-8"));
const get = (obj, path) => path.match(/[^.[\\]]+/g).reduce((value, token) => value?.[Number.isInteger(Number(token)) ? Number(token) : token], obj);
for (const root of verification.roots) {
  if (!fs.existsSync(root.sandboxPath)) {
    throw new Error(\`Missing migrated root: \${root.sandboxPath}\`);
  }
  for (const binding of root.bindings) {
    const actual = get(config, binding.path);
    if (actual !== binding.value) {
      throw new Error(\`Config path \${binding.path} expected \${binding.value} but found \${actual}\`);
    }
  }
  for (const relativePath of root.symlinkPaths) {
    const targetPath = relativePath === "." ? root.sandboxPath : require("node:path").join(root.sandboxPath, relativePath);
    const stat = fs.lstatSync(targetPath);
    if (!stat.isSymbolicLink()) {
      throw new Error(\`Expected symlink after migration: \${targetPath}\`);
    }
  }
}
`;

  execSandboxCommand(sandboxName, ["node", "-e", script]);
}

function execSandboxCommand(sandboxName: string, args: string[]): void {
  try {
    execFileSync("openshell", ["sandbox", "connect", sandboxName, "--", ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err: unknown) {
    const stderr =
      err &&
      typeof err === "object" &&
      "stderr" in err &&
      typeof (err as { stderr?: unknown }).stderr === "string"
        ? (err as { stderr: string }).stderr.trim()
        : "";
    throw new Error(stderr || String(err));
  }
}

function stateArchivePath(bundle: SnapshotBundle): string {
  return join(bundle.archivesDir, "state.tar");
}

function rootArchivePath(bundle: SnapshotBundle, rootId: string): string {
  return join(bundle.archivesDir, `${rootId}.tar`);
}

function shellQuote(input: string): string {
  return `'${input.replace(/'/g, `'\\''`)}'`;
}
