// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import standalonePluginVitestConfig from "../nemoclaw/vitest.config";
import pluginVitestProjectOptions from "../nemoclaw/vitest.project";
import rootVitestConfig from "../vitest.config";
import { vitestStateIsolation } from "./helpers/vitest-state-isolation";

type ProjectTestOptions = Partial<typeof vitestStateIsolation> & {
  mockReset?: boolean;
  name?: string;
};

const DETERMINISTIC_PROJECTS = [
  "cli",
  "integration",
  "installer-integration",
  "package-contract",
  "plugin",
  "e2e-support",
] as const;

const LIVE_PROJECTS = ["e2e-live", "e2e-branch-validation"] as const;

const AUTOMATIC_CLEANUP_OPTIONS = [
  "clearMocks",
  "restoreMocks",
  "unstubEnvs",
  "unstubGlobals",
  "mockReset",
] as const;

function projectTestOptions(): ProjectTestOptions[] {
  const projects = (rootVitestConfig.test?.projects ?? []) as unknown as Array<{
    test?: ProjectTestOptions;
  }>;
  return projects.flatMap((project) => (project.test ? [project.test] : []));
}

describe("Vitest state isolation", () => {
  it("enables automatic state cleanup in every deterministic project", () => {
    const projects = projectTestOptions();

    for (const name of DETERMINISTIC_PROJECTS) {
      const project = projects.find((candidate) => candidate.name === name);
      expect(project, name).toMatchObject(vitestStateIsolation);
      expect(project?.mockReset, name).not.toBe(true);
    }
  });

  it("keeps root and live projects free of unvalidated automatic cleanup", () => {
    const projects = projectTestOptions();
    const rootOptions = rootVitestConfig.test as ProjectTestOptions;

    for (const option of AUTOMATIC_CLEANUP_OPTIONS) {
      expect(rootOptions, `root.${option}`).not.toHaveProperty(option);
    }

    for (const name of LIVE_PROJECTS) {
      const project = projects.find((candidate) => candidate.name === name);
      expect(project, name).toBeDefined();
      for (const option of AUTOMATIC_CLEANUP_OPTIONS) {
        expect(project, `${name}.${option}`).not.toHaveProperty(option);
      }
    }
  });

  it("keeps standalone plugin runs aligned without enabling mockReset", () => {
    expect(pluginVitestProjectOptions.test).toMatchObject(vitestStateIsolation);
    expect(standalonePluginVitestConfig.test).toMatchObject(vitestStateIsolation);
    expect(pluginVitestProjectOptions.test).not.toHaveProperty("mockReset", true);
    expect(standalonePluginVitestConfig.test).not.toHaveProperty("mockReset", true);
  });
});
