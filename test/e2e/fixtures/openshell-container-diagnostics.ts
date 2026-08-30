// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resultText } from "./clients/command.ts";
import type { HostCliClient } from "./clients/host.ts";
import type { ShellProbeResult } from "./shell-probe.ts";

/** Capture bounded logs from the exact OpenShell-managed sandbox container after a failed command. */
export async function collectOpenShellSandboxContainerLogs(input: {
  readonly artifactPrefix: string;
  readonly env: NodeJS.ProcessEnv;
  readonly host: HostCliClient;
  readonly redactionValues: string[];
  readonly sandboxName: string;
}): Promise<string> {
  const lookup = await input.host.command(
    "docker",
    [
      "ps",
      "--all",
      "--filter",
      "label=openshell.ai/managed-by=openshell",
      "--filter",
      `label=openshell.ai/sandbox-name=${input.sandboxName}`,
      "--filter",
      "label=openshell.ai/sandbox-workspace=default",
      "-q",
    ],
    {
      artifactName: `${input.artifactPrefix}-container`,
      env: input.env,
      redactionValues: input.redactionValues,
      timeoutMs: 30_000,
    },
  );
  const containerId = lookup.stdout.trim().split(/\s+/u).filter(Boolean)[0] ?? "";
  if (lookup.exitCode !== 0 || !containerId) return resultText(lookup);
  return resultText(
    await input.host.command("docker", ["logs", "--tail", "300", containerId], {
      artifactName: `${input.artifactPrefix}-docker-logs`,
      env: input.env,
      redactionValues: input.redactionValues,
      timeoutMs: 30_000,
    }),
  );
}

/** Add exact container logs to a failed command's assertion detail. */
export async function openShellCommandDiagnostic(
  result: ShellProbeResult,
  input: Parameters<typeof collectOpenShellSandboxContainerLogs>[0],
): Promise<string> {
  const output = resultText(result);
  if (result.exitCode === 0) return output;
  const logs = await collectOpenShellSandboxContainerLogs(input);
  return [output, logs].filter(Boolean).join("\n\n");
}
