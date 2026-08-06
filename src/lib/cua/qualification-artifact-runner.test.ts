// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  CUA_QUALIFICATION_ARTIFACT_RUNNER_PATH,
  CUA_QUALIFICATION_ISOLATED_TASK_INPUT_PATH,
  resolveCuaQualificationArtifactRunner,
} from "./qualification-artifact-runner";

describe("CUA qualification artifact runner", () => {
  it("does not introduce a runner into ordinary or final lifecycle execution", () => {
    expect(resolveCuaQualificationArtifactRunner({})).toBeUndefined();
    expect(resolveCuaQualificationArtifactRunner({ NEMOCLAW_CUA_ENABLED: "1" })).toBeUndefined();
  });

  it("fails candidate execution closed without the exact root-installed runner", () => {
    const candidate = {
      NEMOCLAW_CUA_ENABLED: "1",
      NEMOCLAW_CUA_QUALIFICATION: "1",
    };
    expect(() => resolveCuaQualificationArtifactRunner(candidate)).toThrow(
      /exact Linux artifact runner/,
    );
    expect(() =>
      resolveCuaQualificationArtifactRunner({
        ...candidate,
        NEMOCLAW_CUA_QUALIFICATION_ARTIFACT_RUNNER: "/tmp/caller-runner",
      }),
    ).toThrow(/exact Linux artifact runner/);
  });

  it("never accepts a configured path other than the fixed Launchable authority", () => {
    expect(CUA_QUALIFICATION_ARTIFACT_RUNNER_PATH).toBe(
      "/usr/local/libexec/nemoclaw-cua-qualification-artifact-runner",
    );
    expect(CUA_QUALIFICATION_ISOLATED_TASK_INPUT_PATH).toBe(
      "/run/nemoclaw-cua-artifact/task-input",
    );
  });
});
