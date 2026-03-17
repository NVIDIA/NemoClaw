// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { PluginLogger, NemoClawConfig } from "../index.js";
import { loadState } from "../blueprint/state.js";

const execAsync = promisify(exec);

/**
 * Detect whether we are running inside an OpenShell sandbox.
 * Inside the sandbox the filesystem is restricted to /sandbox and /tmp,
 * and the openshell CLI cannot query its own container status.
 */
function isInsideSandbox(): boolean {
  return existsSync("/sandbox") || process.env.OPENSHELL_SANDBOX === "1";
}

export interface StatusOptions {
  json: boolean;
  logger: PluginLogger;
  pluginConfig: NemoClawConfig;
}

export async function cliStatus(opts: StatusOptions): Promise<void> {
  const { json: jsonOutput, logger } = opts;
  const state = loadState();
  const sandboxName = state.sandboxName ?? "openclaw";

  const [sandbox, inference] = await Promise.all([
    getSandboxStatus(sandboxName),
    getInferenceStatus(),
  ]);

  const statusData = {
    nemoclaw: {
      lastAction: state.lastAction,
      lastRunId: state.lastRunId,
      blueprintVersion: state.blueprintVersion,
      sandboxName: state.sandboxName,
      migrationSnapshot: state.migrationSnapshot,
      updatedAt: state.updatedAt,
    },
    sandbox,
    inference,
  };

  if (jsonOutput) {
    logger.info(JSON.stringify(statusData, null, 2));
    return;
  }

  logger.info("NemoClaw Status");
  logger.info("===============");
  logger.info("");

  logger.info("Plugin State:");
  if (state.lastAction) {
    logger.info(`  Last action:      ${state.lastAction}`);
    logger.info(`  Blueprint:        ${state.blueprintVersion ?? "unknown"}`);
    logger.info(`  Run ID:           ${state.lastRunId ?? "none"}`);
    logger.info(`  Updated:          ${state.updatedAt}`);
  } else {
    logger.info("  No operations have been performed yet.");
  }
  logger.info("");

  logger.info("Sandbox:");
  if (sandbox.running) {
    logger.info(`  Name:    ${sandbox.name}`);
    logger.info("  Status:  running");
    logger.info(`  Uptime:  ${sandbox.uptime ?? "unknown"}`);
  } else {
    logger.info("  Status:  not running");
  }
  logger.info("");

  logger.info("Inference:");
  if (inference.configured) {
    logger.info(`  Provider:  ${inference.provider ?? "unknown"}`);
    logger.info(`  Model:     ${inference.model ?? "unknown"}`);
    logger.info(`  Endpoint:  ${inference.endpoint ?? "unknown"}`);
  } else {
    logger.info("  Not configured");
  }

  if (state.migrationSnapshot) {
    logger.info("");
    logger.info("Rollback:");
    logger.info(`  Snapshot:  ${state.migrationSnapshot}`);
    logger.info("  Run 'openclaw nemoclaw eject' to restore host installation.");
  }
}

interface SandboxStatus {
  name: string;
  running: boolean;
  uptime: string | null;
}

interface SandboxStatusResponse {
  state?: string;
  uptime?: string;
}

async function getSandboxStatus(sandboxName: string): Promise<SandboxStatus> {
  // When running inside the sandbox, openshell cannot query its own
  // container.  The fact that this code is executing proves the sandbox
  // is running, so report that directly.
  if (isInsideSandbox()) {
    return { name: sandboxName, running: true, uptime: null };
  }

  try {
    const { stdout } = await execAsync(`openshell sandbox status ${sandboxName} --json`, {
      timeout: 5000,
    });
    const parsed = JSON.parse(stdout) as SandboxStatusResponse;
    return {
      name: sandboxName,
      running: parsed.state === "running",
      uptime: parsed.uptime ?? null,
    };
  } catch {
    return { name: sandboxName, running: false, uptime: null };
  }
}

interface InferenceStatus {
  configured: boolean;
  provider: string | null;
  model: string | null;
  endpoint: string | null;
}

interface InferenceStatusResponse {
  provider?: string;
  model?: string;
  endpoint?: string;
}

async function getInferenceStatus(): Promise<InferenceStatus> {
  try {
    const { stdout } = await execAsync("openshell inference get --json", {
      timeout: 5000,
    });
    const parsed = JSON.parse(stdout) as InferenceStatusResponse;
    return {
      configured: true,
      provider: parsed.provider ?? null,
      model: parsed.model ?? null,
      endpoint: parsed.endpoint ?? null,
    };
  } catch {
    return { configured: false, provider: null, model: null, endpoint: null };
  }
}
