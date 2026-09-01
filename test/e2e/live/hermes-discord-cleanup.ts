// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HostCliClient, SandboxClient } from "../fixtures/clients/index.ts";

export async function precleanHermesDiscordResources(
  host: Pick<HostCliClient, "cleanupGatewayRegistration" | "cleanupSandbox">,
  sandbox: Pick<SandboxClient, "cleanupSandbox">,
  options: {
    sandboxName: string;
    env: NodeJS.ProcessEnv;
    redactionValues: string[];
    prefix: string;
  },
): Promise<void> {
  await host.cleanupSandbox(options.sandboxName, {
    artifactName: `${options.prefix}-nemoclaw-destroy`,
    env: options.env,
    redactionValues: options.redactionValues,
    timeoutMs: 15 * 60_000,
  });
  await sandbox.cleanupSandbox(options.sandboxName, {
    artifactName: `${options.prefix}-openshell-sandbox-delete`,
    env: options.env,
    redactionValues: options.redactionValues,
    timeoutMs: 120_000,
  });
  await host.cleanupGatewayRegistration("nemoclaw", {
    artifactName: `${options.prefix}-openshell-gateway-destroy`,
    env: options.env,
    redactionValues: options.redactionValues,
    timeoutMs: 120_000,
  });
}
