// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, test as base } from "vitest";

import { createArtifactSink, type ArtifactSink } from "./artifacts.ts";
import {
  GatewayClient,
  HostCliClient,
  ProviderClient,
  SandboxClient,
  StateClient,
} from "./clients/index.ts";
import { assertCleanupPassed, CleanupRegistry } from "./cleanup.ts";
import { SecretStore } from "./secrets.ts";
import { ShellProbe } from "./shell-probe.ts";

export interface E2EScenarioFixtures {
  artifacts: ArtifactSink;
  cleanup: CleanupRegistry;
  secrets: SecretStore;
  shellProbe: ShellProbe;
  host: HostCliClient;
  gateway: GatewayClient;
  sandbox: SandboxClient;
  provider: ProviderClient;
  state: StateClient;
}

export const test = base
  .extend("artifacts", async ({ task }, { onCleanup }) => {
    const artifacts = createArtifactSink(task.name);
    await artifacts.ensureRoot();
    onCleanup(async () => {
      await artifacts.writeJson("artifact-summary.json", {
        test: task.name,
        rootDir: artifacts.rootDir,
      });
    });
    return artifacts;
  })
  .extend("cleanup", async ({ artifacts }, { onCleanup }) => {
    const cleanup = new CleanupRegistry();
    onCleanup(async () => {
      const result = await cleanup.runAll();
      await artifacts.writeJson("cleanup.json", result);
      assertCleanupPassed(result);
    });
    return cleanup;
  })
  .extend("secrets", async ({ skip }) => new SecretStore(process.env, skip))
  .extend("shellProbe", async ({ artifacts, secrets, signal }) => {
    return new ShellProbe({
      artifacts,
      redact: (text, extraValues) => secrets.redact(text, extraValues),
      signal,
    });
  })
  .extend("host", async ({ shellProbe }) => new HostCliClient(shellProbe))
  .extend("gateway", async ({ host }) => new GatewayClient(host))
  .extend("sandbox", async ({ shellProbe }) => new SandboxClient(shellProbe))
  .extend("provider", async ({ shellProbe }) => new ProviderClient(shellProbe))
  .extend("state", async () => new StateClient());

export { expect };
