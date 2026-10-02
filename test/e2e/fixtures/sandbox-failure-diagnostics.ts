// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import { GATEWAY_PORT } from "../../../src/lib/core/ports.ts";
import { resolveGatewayLogPathForPort } from "../../../src/lib/onboard/gateway/state-dir.ts";
import { buildAvailabilityProbeEnv } from "./availability-env.ts";
import type { HostCliClient } from "./clients/host.ts";
import { RuntimeProviderPrerequisite } from "./runtime-provider.ts";

export async function captureSandboxFailureDiagnostics(
  host: Pick<HostCliClient, "command" | "openshellCommandPath">,
  result: { exitCode: number | null; timedOut: boolean },
  options: {
    sandboxName: string;
    artifactPrefix: string;
    redactionValues: string[];
    captureGatewayLog?: boolean;
    expectedExitCode?: number;
  },
): Promise<void> {
  if (result.exitCode === (options.expectedExitCode ?? 0) && !result.timedOut) return;
  await host
    .command(
      host.openshellCommandPath,
      ["logs", options.sandboxName, "-n", "200", "--source", "all", "--since", "2m"],
      {
        artifactName: `${options.artifactPrefix}-supervisor-logs`,
        env: buildAvailabilityProbeEnv(),
        redactionValues: options.redactionValues,
        captureLimitBytes: 32_768,
        timeoutMs: 30_000,
      },
    )
    .catch(() => undefined);
  if (options.captureGatewayLog) {
    await host
      .command(
        "cat",
        [
          resolveGatewayLogPathForPort({
            configured: process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR,
            home: os.homedir(),
            port: GATEWAY_PORT,
          }),
        ],
        {
          artifactName: `${options.artifactPrefix}-gateway-log`,
          env: buildAvailabilityProbeEnv(),
          redactionValues: options.redactionValues,
          captureLimitBytes: 32_768,
          timeoutMs: 5_000,
        },
      )
      .catch(() => undefined);
  }
  // OpenShell's event stream does not include the entrypoint's stderr.
  // Read the stopped container through the existing runtime owner instead of
  // depending on an exec service that died with the supervisor.
  try {
    const runtime = new RuntimeProviderPrerequisite(host);
    const diagnosticOptions = {
      redactionValues: options.redactionValues,
      captureLimitBytes: 32_768,
      timeoutMs: 30_000,
    };
    const prefix = options.artifactPrefix;
    const containerId = await runtime.resolveSandboxResourceHandle(options.sandboxName, {
      ...diagnosticOptions,
      artifactName: `${prefix}-container-identity`,
    });
    const startupLog = runtime.hostInvocation([
      "cp",
      `${containerId}:/tmp/nemoclaw-start.log`,
      "-",
    ]);
    await Promise.allSettled([
      runtime.command(
        [
          "inspect",
          "--format",
          "{{.State.Status}}\t{{.State.OOMKilled}}\t{{.State.ExitCode}}\t{{.State.FinishedAt}}",
          containerId,
        ],
        { ...diagnosticOptions, artifactName: `${prefix}-container-state` },
      ),
      runtime.command(["logs", "--tail", "200", "--since", "3m", containerId], {
        ...diagnosticOptions,
        artifactName: `${prefix}-container-logs`,
      }),
      // The managed entrypoint records its output in this file. Stream only
      // its contents from the stopped container; never unpack files on the host.
      host.command(
        "bash",
        [
          "-o",
          "pipefail",
          "-c",
          '"$@" | tar -xOf - nemoclaw-start.log',
          prefix,
          startupLog.command,
          ...startupLog.args,
        ],
        {
          ...diagnosticOptions,
          env: buildAvailabilityProbeEnv(),
          artifactName: `${prefix}-startup-log`,
        },
      ),
    ]);
  } catch {
    // Failure-only evidence must preserve the original lifecycle assertion.
  }
}
