// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { shouldRunLiveE2EScenarios } from "../framework/live-project-gate.ts";
import config from "../../../vitest.config.ts";

interface ProjectConfig {
  test?: {
    name?: string;
    include?: string[];
  };
}

interface RootConfig {
  test?: {
    projects?: ProjectConfig[];
  };
}

function liveProject(): ProjectConfig {
  const projects = (config as RootConfig).test?.projects ?? [];
  const project = projects.find((entry) => entry.test?.name === "e2e-scenarios-live");
  if (!project) {
    throw new Error("missing e2e-scenarios-live Vitest project");
  }
  return project;
}

describe("live E2E scenario Vitest project", () => {
  it("is present but excludes live tests by default", () => {
    const project = liveProject();
    expect(project.test?.include).toEqual([]);
  });

  it("is enabled only by the explicit live scenario opt-in env var", () => {
    expect(shouldRunLiveE2EScenarios({})).toBe(false);
    expect(shouldRunLiveE2EScenarios({ NEMOCLAW_RUN_E2E_SCENARIOS: "0" })).toBe(false);
    expect(shouldRunLiveE2EScenarios({ NEMOCLAW_RUN_E2E_SCENARIOS: "yes" })).toBe(false);
    expect(shouldRunLiveE2EScenarios({ NEMOCLAW_RUN_E2E_SCENARIOS: "1" })).toBe(true);
    expect(shouldRunLiveE2EScenarios({ NEMOCLAW_RUN_E2E_SCENARIOS: "true" })).toBe(true);
    expect(shouldRunLiveE2EScenarios({ NEMOCLAW_RUN_E2E_SCENARIOS: " TRUE " })).toBe(true);
  });
});
