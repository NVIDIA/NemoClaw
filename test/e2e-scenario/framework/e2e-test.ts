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
  .extend("secrets", async ({ skip }) => new SecretStore(process.env, skip))
  .extend("cleanup", async ({ artifacts, secrets }, { onCleanup }) => {
    const cleanup = new CleanupRegistry((text) => secrets.redact(text));
    onCleanup(async () => {
      const result = await cleanup.runAll();
      await artifacts.writeJson("cleanup.json", result);
      assertCleanupPassed(result);
    });
    return cleanup;
  })
  .extend("shellProbe", async ({ artifacts, secrets, signal }) => {
    return new ShellProbe({
      artifacts,
      redact: (text, extraValues) => secrets.redact(text, extraValues),
      signal,
    });
  });

export { expect };
