// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, test as base } from "vitest";

import { createArtifactSink, type ArtifactSink } from "./artifacts.ts";
import { assertCleanupPassed, CleanupRegistry } from "./cleanup.ts";
import { SecretStore } from "./secrets.ts";
import { ShellProbe } from "./shell-probe.ts";

export interface E2EScenarioFixtures {
  artifacts: ArtifactSink;
  cleanup: CleanupRegistry;
  secrets: SecretStore;
  shellProbe: ShellProbe;
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
    await use(new ShellProbe({
      artifacts,
      redact: (text, extraValues) => secrets.redact(text, extraValues),
      signal,
    }));
  },
});

export { expect };
