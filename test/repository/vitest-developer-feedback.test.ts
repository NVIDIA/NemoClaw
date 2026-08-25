// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "vitest";

import { test as it } from "../helpers/owned-test-resources";
import { resolveVitestFeedback } from "../helpers/vitest-feedback";
import { runVitestNpmScript } from "../helpers/vitest-npm-script";

const focusedProjects = "--project cli --project plugin --project e2e-support";

describe("Vitest developer feedback", () => {
  it("selects passed-only Vitest output in CI (#6692)", () => {
    expect(resolveVitestFeedback({})).toEqual({ isCi: false, silent: false });
    expect(resolveVitestFeedback({ CI: "0" })).toEqual({ isCi: false, silent: false });
    expect(resolveVitestFeedback({ CI: "1" })).toEqual({ isCi: true, silent: "passed-only" });
    expect(resolveVitestFeedback({ CI: "true" })).toEqual({ isCi: true, silent: "passed-only" });
    expect(resolveVitestFeedback({ GITHUB_ACTIONS: "true" })).toEqual({
      isCi: true,
      silent: "passed-only",
    });
  });

  it("runs changed and watch feedback on the focused source projects (#6692)", ({ resources }) => {
    expect(runVitestNpmScript(resources, "test:changed")).toBe(
      `vitest run --changed ${focusedProjects}`,
    );
    expect(runVitestNpmScript(resources, "test:watch")).toBe(`vitest watch ${focusedProjects}`);
  });

  it("passes a reproducible seed to test-only shuffle diagnostics outside coverage (#6692)", ({
    resources,
  }) => {
    expect(runVitestNpmScript(resources, "test:shuffle", ["--", "--sequence.seed=6692"])).toBe(
      `vitest run ${focusedProjects} --sequence.shuffle.tests --coverage=false --sequence.seed=6692`,
    );
  });

  it("runs opt-in async-leak diagnostics outside coverage (#6692)", ({ resources }) => {
    expect(runVitestNpmScript(resources, "test:diagnose:leaks")).toBe(
      `vitest run ${focusedProjects} --detectAsyncLeaks --coverage=false --reporter=default --reporter=hanging-process`,
    );
  });
});
