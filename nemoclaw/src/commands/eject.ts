// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { PluginLogger, NemoClawConfig } from "../index.js";
import { execBlueprint } from "../blueprint/exec.js";
import { loadState, clearState } from "../blueprint/state.js";
import { restoreSnapshotToHost } from "./migration-state.js";

const HOME = process.env.HOME ?? "/tmp";

export interface EjectOptions {
  runId?: string;
  confirm: boolean;
  logger: PluginLogger;
  pluginConfig: NemoClawConfig;
}

export async function cliEject(opts: EjectOptions): Promise<void> {
  const { confirm, runId, logger } = opts;
  const state = loadState();

  if (!state.lastAction) {
    logger.error("No NemoClaw deployment found. Nothing to eject from.");
    return;
  }

  if (!state.migrationSnapshot && !state.hostBackupPath) {
    logger.error("No migration snapshot found. Cannot restore host installation.");
    logger.info("If you used --skip-backup during migrate, manual restoration is required.");
    return;
  }

  const snapshotPath = state.migrationSnapshot ?? state.hostBackupPath;
  if (!snapshotPath) {
    logger.error("No snapshot or backup path found in state. Cannot restore.");
    return;
  }
  const snapshotOpenClawDir = join(snapshotPath, "openclaw");

  if (!existsSync(snapshotOpenClawDir)) {
    logger.error(`Snapshot directory not found: ${snapshotOpenClawDir}`);
    return;
  }

  if (!confirm) {
    logger.info("Eject will:");
    logger.info("  1. Stop the OpenShell sandbox");
    logger.info("  2. Rollback blueprint state");
    logger.info(`  3. Restore ~/.openclaw from snapshot: ${snapshotPath}`);
    logger.info("  4. Clear NemoClaw state");
    logger.info("");
    logger.info("Run with --confirm to proceed, or cancel now.");
    return;
  }

  // Step 0: Ensure sandbox is stopped before restoration
  if (state.sandboxName) {
    logger.info(`Ensuring sandbox '${state.sandboxName}' is stopped...`);
    try {
      execSync(`openshell sandbox stop ${state.sandboxName}`, { stdio: "ignore" });
    } catch {
      // Best effort — sandbox might already be stopped
    }
  }

  // Step 1: Rollback blueprint
  if (state.lastRunId && state.blueprintVersion) {
    const blueprintPath = join(HOME, ".nemoclaw", "blueprints", state.blueprintVersion);

    if (existsSync(blueprintPath)) {
      const rollbackResult = await execBlueprint(
        {
          blueprintPath,
          action: "rollback",
          profile: "default",
          runId: runId ?? state.lastRunId,
          jsonOutput: true,
        },
        logger,
      );

      if (!rollbackResult.success) {
        logger.warn(`Blueprint rollback returned errors: ${rollbackResult.output}`);
        logger.info("Continuing with host restoration...");
      }
    }
  }

  // Step 2: Restore host state using the original snapshot manifest paths.
  const restored = restoreSnapshotToHost(snapshotPath, logger);
  if (!restored) {
    logger.info(`Manual restore available at: ${snapshotOpenClawDir}`);
    return;
  }

  // Step 3: Clear NemoClaw state
  clearState();

  logger.info("");
  logger.info("Eject complete. Host OpenClaw installation has been restored.");
  logger.info("You can now run 'openclaw' directly on your host.");
}
