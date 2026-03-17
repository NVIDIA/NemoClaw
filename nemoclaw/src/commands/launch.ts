// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execSync } from "node:child_process";
import type { PluginLogger, NemoClawConfig } from "../index.js";
import { resolveBlueprint } from "../blueprint/resolve.js";
import { verifyBlueprintDigest, checkCompatibility } from "../blueprint/verify.js";
import { execBlueprint } from "../blueprint/exec.js";
import { loadState, saveState } from "../blueprint/state.js";
import { detectHostOpenClaw } from "./migrate.js";
import { metrics } from "../observability/metrics.js";

export interface LaunchOptions {
  force: boolean;
  profile: string;
  logger: PluginLogger;
  pluginConfig: NemoClawConfig;
}

export async function cliLaunch(opts: LaunchOptions): Promise<void> {
  const { force, profile, logger, pluginConfig } = opts;

  logger.info("NemoClaw launch: setting up OpenClaw inside OpenShell");

  // Check if there's an existing host OpenClaw installation
  const hostState = detectHostOpenClaw();

  if (!hostState.exists && !force) {
    logger.info("");
    logger.info("No existing OpenClaw installation detected on this host.");
    logger.info("");
    logger.info("For net-new users, the recommended path is OpenShell-native setup:");
    logger.info("");
    logger.info("  openshell sandbox create --from openclaw --name openclaw");
    logger.info("  openshell sandbox connect openclaw");
    logger.info("");
    logger.info(
      "This avoids installing OpenClaw on the host only to redeploy it inside OpenShell.",
    );
    logger.info("");
    logger.info("To proceed with NemoClaw-driven bootstrap anyway, use --force.");
    return;
  }

  if (hostState.exists && !force) {
    logger.info(
      "Existing OpenClaw installation detected. Consider using 'openclaw nemoclaw migrate' instead.",
    );
    logger.info(
      "Use --force to proceed with a fresh launch (existing config will not be migrated).",
    );
    return;
  }

  // Resolve and verify blueprint
  logger.info("Resolving blueprint...");
  const blueprint = await resolveBlueprint(pluginConfig);

  logger.info("Verifying blueprint integrity...");
  const verification = verifyBlueprintDigest(blueprint.localPath, blueprint.manifest);
  if (!verification.valid) {
    logger.error(`Blueprint verification failed: ${verification.errors.join(", ")}`);
    return;
  }

  // Check version compatibility
  const openshellVersion = getOpenshellVersion();
  const openclawVersion = getOpenclawVersion();
  const compat = checkCompatibility(blueprint.manifest, openshellVersion, openclawVersion);
  if (compat.length > 0) {
    logger.error(`Compatibility check failed:\n  ${compat.join("\n  ")}`);
    return;
  }

  // Plan
  logger.info("Planning deployment...");
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
    logger.error(`Blueprint plan failed: ${planResult.output}`);
    return;
  }

  // Apply
  logger.info("Deploying OpenClaw sandbox...");
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
    logger.error(`Blueprint apply failed: ${applyResult.output}`);
    return;
  }

  metrics.incrementCounter("sandbox_operation_total", { operation: "launch" });

  // Save state
  saveState({
    ...loadState(),
    lastRunId: applyResult.runId,
    lastAction: "launch",
    blueprintVersion: blueprint.version,
    sandboxName: pluginConfig.sandboxName,
  });

  logger.info("");
  logger.info("OpenClaw is now running inside OpenShell.");
  logger.info(`Sandbox: ${pluginConfig.sandboxName}`);
  logger.info("");
  logger.info("Next steps:");
  logger.info("  openclaw nemoclaw connect    # Enter the sandbox");
  logger.info("  openclaw nemoclaw status     # Check health");
  logger.info("  openshell term               # Monitor network egress");
}

function getOpenshellVersion(): string {
  try {
    return execSync("openshell --version", { encoding: "utf-8" }).trim();
  } catch {
    return "0.0.0";
  }
}

function getOpenclawVersion(): string {
  try {
    return execSync("openclaw --version", { encoding: "utf-8" }).trim();
  } catch {
    return "0.0.0";
  }
}
