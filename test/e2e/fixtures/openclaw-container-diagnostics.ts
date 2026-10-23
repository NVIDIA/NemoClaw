// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RuntimeProviderPrerequisite } from "./runtime-provider.ts";
import type { ShellProbeRunOptions } from "./shell-probe.ts";

/** Retain container output when OpenShell refuses sandbox execution. */
export async function captureOpenClawContainerFailure(
  runtime: Pick<RuntimeProviderPrerequisite, "resolveSandboxResourceHandle" | "command">,
  sandboxName: string,
  artifactPrefix: string,
  options: ShellProbeRunOptions,
  logReader: readonly string[],
): Promise<void> {
  try {
    const id = await runtime.resolveSandboxResourceHandle(sandboxName, {
      ...options,
      artifactName: `${artifactPrefix}-failure-container-id`,
    });
    // Never fall back to a mutable name or accept a shortened or ambiguous ID.
    if (!/^[a-f0-9]{64}$/u.test(id)) return;
    await Promise.allSettled([
      runtime.command(
        [
          "container",
          "inspect",
          "--format",
          "{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}}",
          id,
        ],
        {
          ...options,
          artifactName: `${artifactPrefix}-failure-container-state`,
        },
      ),
      runtime.command(["logs", "--tail", "120", id], {
        ...options,
        artifactName: `${artifactPrefix}-failure-container-logs`,
      }),
      // Direct runtime exec can still work while OpenShell reports phase Error.
      // Keep descriptor checks; never copy files from a stopped container.
      runtime.command(["container", "exec", "--user", "sandbox", id, ...logReader], {
        ...options,
        artifactName: `${artifactPrefix}-failure-container-startup-logs`,
      }),
    ]);
  } catch {
    // Missing resources and diagnostic failures must not change the test result.
  }
}
