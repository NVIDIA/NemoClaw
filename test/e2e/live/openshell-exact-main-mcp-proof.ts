// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ArtifactSink } from "../fixtures/artifacts.ts";
import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import type { LifecyclePhaseFixture } from "../fixtures/phases/lifecycle.ts";
import { prepareExactMainDriverConfigProof } from "./openshell-exact-main-driver-config.ts";
import { assertExactMainOpenShellContracts } from "./openshell-exact-main-exec.ts";
import {
  assertExactMainMcpLogPrivacy,
  assertExactMainPolicyNftAndIdentityContracts,
} from "./openshell-exact-main-runtime-contracts.ts";

export function prepareExactMainMcpProof(
  fixture: {
    artifacts: ArtifactSink;
    cleanup: CleanupRegistry;
    host: HostCliClient;
    lifecycle: LifecyclePhaseFixture;
    sandbox: SandboxClient;
  },
  sandboxName: string,
  mcpUrl: string,
) {
  const { artifacts, cleanup, host, sandbox } = fixture;
  const driverConfig = prepareExactMainDriverConfigProof(fixture, sandboxName);
  return {
    async afterOnboard(): Promise<void> {
      await driverConfig.assertAfterOnboard();
      await assertExactMainOpenShellContracts(host, sandboxName);
      await assertExactMainPolicyNftAndIdentityContracts({
        artifacts,
        cleanup,
        host,
        mcpUrl,
        sandbox,
        sandboxName,
      });
    },
    async afterRebuild(): Promise<void> {
      await driverConfig.assertAfterRebuild();
    },
    async assertLogPrivacy(argumentCanaries: string[], expectedTool: string): Promise<void> {
      await assertExactMainMcpLogPrivacy({
        argumentCanaries,
        artifacts,
        expectedTool,
        sandbox,
        sandboxName,
      });
    },
  };
}
