// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { buildAvailabilityProbeEnv } from "./availability-env.ts";
import type { CleanupRegistry } from "./cleanup.ts";
import { assertCleanupSucceededOrAbsent } from "./cleanup-resources.ts";
import { assertExitZero } from "./clients/command.ts";
import type { HostCliClient } from "./clients/host.ts";
import { requireHostedInferenceConfig, type HostedInferenceSecrets } from "./hosted-inference.ts";
import { REPO_ROOT } from "./paths.ts";
import { execTimeout } from "../../helpers/timeouts.ts";

export async function onboardTavilyExportSource(
  agent: "openclaw" | "hermes",
  host: Pick<HostCliClient, "command" | "nemoclaw">,
  secrets: HostedInferenceSecrets,
  cleanup: Pick<CleanupRegistry, "trackDisposable">,
): Promise<{ sandboxName: string }> {
  const inference = requireHostedInferenceConfig(secrets);
  const tavilyKey = secrets.required("TAVILY_API_KEY");
  const sandboxName = `tv-${agent === "hermes" ? "hm" : "oc"}-${randomUUID().slice(0, 8)}`;
  const env = {
    ...buildAvailabilityProbeEnv(),
    NEMOCLAW_AGENT: agent,
    NEMOCLAW_SANDBOX_NAME: sandboxName,
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
  };
  cleanup.trackDisposable(`destroy Tavily export source ${sandboxName}`, async () => {
    const result = await host.nemoclaw([sandboxName, "destroy", "--yes"], {
      env,
      timeoutMs: 120_000,
      artifactName: "cleanup-tavily-export-source",
    });
    assertCleanupSucceededOrAbsent(
      result,
      /Sandbox '.+' does not exist|sandbox .* not found|no such sandbox/iu,
      "Tavily export source cleanup",
    );
  });
  const result = await host.command("bash", ["install.sh", "--fresh"], {
    cwd: REPO_ROOT,
    env: {
      ...env,
      ...inference.env,
      NEMOCLAW_REPO_ROOT: REPO_ROOT,
      NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
      NEMOCLAW_NON_INTERACTIVE: "1",
      NEMOCLAW_NO_EXPRESS: "1",
      NEMOCLAW_SANDBOX_GPU: "0",
      NEMOCLAW_HERMES_DASHBOARD: "0",
      NEMOCLAW_WEB_SEARCH_PROVIDER: "tavily",
      NEMOCLAW_POLICY_MODE: "suggested",
      NEMOCLAW_POLICY_TIER: "balanced",
      BRAVE_API_KEY: "",
      TAVILY_API_KEY: tavilyKey,
      npm_config_save: "false",
    },
    redactionValues: [inference.apiKey, tavilyKey],
    timeoutMs: execTimeout(25 * 60_000),
    artifactName: "install-tavily-export-source",
  });
  assertExitZero(result, `${agent} Tavily source installation`);
  return { sandboxName };
}
