// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { getOpenshellBinary } from "../../adapters/openshell/runtime";
import * as agentRuntime from "../../agent/runtime";
import { shouldManageDashboardForAgent } from "../../onboard/dashboard-runtime";
import { buildSandboxRuntimeEnvArgs } from "../../onboard/sandbox-create-launch";
import { ROOT, shellQuote } from "../../runner";
import * as registry from "../../state/registry";
import { buildSubprocessEnv } from "../../subprocess-env";
import { resolveSandboxDashboardPort } from "./forward-recovery";

const RELAUNCH_EXEC_TIMEOUT_MS = 15000;
const NEMOCLAW_START_PATH = "/usr/local/bin/nemoclaw-start";

function reconstructSupervisorLaunchEnvArgs(sandboxName: string): string[] | null {
  const entry = registry.getSandbox(sandboxName);
  if (!entry) return null;
  const agent = agentRuntime.getSessionAgent(sandboxName) ?? null;
  const manageDashboard = shouldManageDashboardForAgent(agent);
  const dashboardPort = String(resolveSandboxDashboardPort(sandboxName));
  const chatUiUrl = manageDashboard ? `http://127.0.0.1:${dashboardPort}` : "";
  const hermesDashboardEnabled = entry.hermesDashboardEnabled === true;
  const { envArgs } = buildSandboxRuntimeEnvArgs({
    agent,
    chatUiUrl,
    manageDashboard,
    getDashboardForwardPort: () => dashboardPort,
    hermesDashboardState: {
      enabled: hermesDashboardEnabled,
      config: hermesDashboardEnabled
        ? {
            enabled: true,
            port: entry.hermesDashboardPort ?? 0,
            internalPort: entry.hermesDashboardInternalPort ?? 0,
            tuiEnabled: entry.hermesDashboardTui === true,
          }
        : null,
    },
    extraPlaceholderKeys: [],
    observabilityEnabled: entry.observabilityEnabled === true,
    sandboxName,
    env: process.env,
    omitCredentialEnv: true,
  });
  return envArgs;
}

export function relaunchManagedSupervisorSession(
  sandboxName: string,
  { quiet }: { quiet: boolean },
): boolean {
  if (process.env.NEMOCLAW_DISABLE_SUPERVISOR_RELAUNCH === "1") return false;
  const envArgs = reconstructSupervisorLaunchEnvArgs(sandboxName);
  if (envArgs === null) return false;
  const startedMarker = "NEMOCLAW_SUPERVISOR_RELAUNCHED";
  const envPrefix = envArgs.map(shellQuote).join(" ");
  const daemonCommand =
    `echo ${startedMarker}; ` +
    `setsid nohup env ${envPrefix} ${NEMOCLAW_START_PATH} ` +
    ">/tmp/nemoclaw-start-recover.log 2>&1 </dev/null &";
  if (!quiet) console.log("  Relaunching the in-sandbox supervisor...");
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(
      getOpenshellBinary(),
      ["sandbox", "exec", "--name", sandboxName, "--", "sh", "-c", daemonCommand],
      {
        cwd: ROOT,
        encoding: "utf-8",
        env: buildSubprocessEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        timeout: RELAUNCH_EXEC_TIMEOUT_MS,
      },
    );
  } catch {
    return false;
  }
  return result.status === 0 && String(result.stdout || "").includes(startedMarker);
}
