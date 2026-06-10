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
import {
  EnvironmentPhaseFixture,
  LifecyclePhaseFixture,
  OnboardingPhaseFixture,
  RuntimePhaseFixture,
  StateValidationPhaseFixture,
} from "./phases/index.ts";
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
  environment: EnvironmentPhaseFixture;
  onboard: OnboardingPhaseFixture;
  lifecycle: LifecyclePhaseFixture;
  runtime: RuntimePhaseFixture;
  stateValidation: StateValidationPhaseFixture;
}

export const test = base.extend<E2EScenarioFixtures>({
  artifacts: async ({ task }, use) => {
    const artifacts = createArtifactSink(task.name);
    await artifacts.ensureRoot();
    try {
      await use(artifacts);
    } finally {
      await artifacts.writeJson("artifact-summary.json", {
        test: task.name,
        rootDir: artifacts.rootDir,
      });
    }
  },
  secrets: async ({ skip }, use) => {
    await use(new SecretStore(process.env, skip));
  },
  cleanup: async ({ artifacts, secrets }, use) => {
    const cleanup = new CleanupRegistry((text) => secrets.redact(text));
    try {
      await use(cleanup);
    } finally {
      const result = await cleanup.runAll();
      await artifacts.writeJson("cleanup.json", result);
      assertCleanupPassed(result);
    }
  },
  shellProbe: async ({ artifacts, secrets, signal }, use) => {
    await use(
      new ShellProbe({
        artifacts,
        redact: (text, extraValues) => secrets.redact(text, extraValues),
        signal,
      }),
    );
  },
  host: async ({ shellProbe }, use) => {
    await use(new HostCliClient(shellProbe));
  },
  gateway: async ({ host }, use) => {
    await use(new GatewayClient(host));
  },
  sandbox: async ({ shellProbe }, use) => {
    await use(new SandboxClient(shellProbe));
  },
  provider: async ({ shellProbe }, use) => {
    await use(new ProviderClient(shellProbe));
  },
  state: async ({}, use) => {
    await use(new StateClient());
  },
  environment: async ({ host }, use) => {
    await use(new EnvironmentPhaseFixture(host));
  },
  onboard: async ({ cleanup, host, secrets }, use) => {
    await use(new OnboardingPhaseFixture(host, secrets, cleanup));
  },
  lifecycle: async ({ cleanup, host, sandbox }, use) => {
    await use(new LifecyclePhaseFixture(host, sandbox, cleanup));
  },
  runtime: async ({ provider, sandbox }, use) => {
    await use(new RuntimePhaseFixture(sandbox, provider));
  },
  stateValidation: async ({ host, gateway, sandbox }, use) => {
    await use(new StateValidationPhaseFixture(host, gateway, sandbox));
  },
});

export { expect };
