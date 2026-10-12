// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RuntimeProviderPrerequisite } from "./runtime-provider.ts";
import type { ShellProbeRunOptions } from "./shell-probe.ts";
import type { HostCliClient } from "./clients/host.ts";
import { STOPPED_CONTAINER_STARTUP_LOG_READER } from "./stopped-container-startup-log.ts";

/** Retain container output when OpenShell refuses sandbox execution. */
export async function captureOpenClawContainerFailure(
  runtime: Pick<RuntimeProviderPrerequisite, "resolveSandboxResourceHandle" | "command"> &
    Partial<Pick<RuntimeProviderPrerequisite, "hostInvocation">>,
  sandboxName: string,
  artifactPrefix: string,
  options: ShellProbeRunOptions,
  logReader: readonly string[],
  host?: Pick<HostCliClient, "command">,
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
      (async () => {
        // Prefer the descriptor-checked reader while the container still runs.
        const result = await runtime
          .command(["container", "exec", "--user", "sandbox", id, ...logReader], {
            ...options,
            artifactName: `${artifactPrefix}-failure-container-startup-logs`,
          })
          .catch(() => null);
        if (result?.exitCode === 0 || !host || !runtime.hostInvocation) return;
        const copy = runtime.hostInvocation(["cp", `${id}:/tmp/nemoclaw-start.log`, "-"]);
        await host.command(
          "bash",
          [
            "-o",
            "pipefail",
            "-c",
            'reader="$1"; shift; "$@" | python3 -I -c "$reader"',
            "stopped-container-startup-log",
            STOPPED_CONTAINER_STARTUP_LOG_READER,
            copy.command,
            ...copy.args,
          ],
          {
            ...options,
            // JSON escaping can expand the complete 16 KiB log by six times.
            captureLimitBytes: 128 * 1024,
            artifactName: `${artifactPrefix}-failure-stopped-startup-log`,
          },
        );
      })(),
    ]);
  } catch {
    // Missing resources and diagnostic failures must not change the test result.
  }
}
