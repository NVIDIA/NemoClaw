// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the expected-failure schema, resolver merge, and matcher.
 *
 * Companion to NemoClaw issue #3608. The scenario-additional-families
 * suite covers the end-to-end plan shape; this file focuses on the new
 * code paths in isolation so failures point at a single layer.
 */

import { describe, it, expect } from "vitest";
import yaml from "js-yaml";

import { loadMetadataFromObjects } from "../runtime/resolver/load.ts";
import { resolveScenario } from "../runtime/resolver/plan.ts";
import {
  matchExpectedFailure,
  type ObservedFailure,
} from "../runtime/resolver/expected-failure.ts";
import type { ExpectedFailure } from "../runtime/resolver/schema.ts";

function makeMetadata(opts: {
  stateBlock?: Record<string, unknown> | null;
  scenarioBlock?: Record<string, unknown> | null;
}) {
  const stateBlock = opts.stateBlock;
  const scenarioBlock = opts.scenarioBlock;
  const stateYaml: Record<string, unknown> = {
    cli: { installed: true },
    gateway: { expected: "absent" },
    sandbox: { expected: "absent" },
  };
  if (stateBlock !== undefined && stateBlock !== null) {
    stateYaml.expected_failure = stateBlock;
  }
  const scenarioYaml: Record<string, unknown> = {
    dimensions: {
      platform: "p",
      install: "i",
      runtime: "r",
      onboarding: "o",
    },
    expected_state: "neg",
    suites: [],
  };
  if (scenarioBlock !== undefined && scenarioBlock !== null) {
    scenarioYaml.expected_failure = scenarioBlock;
  }
  return loadMetadataFromObjects({
    scenarios: {
      platforms: { p: { os: "ubuntu" } },
      installs: { i: { method: "repo-checkout" } },
      runtimes: { r: { container_engine: "docker", container_daemon: "missing" } },
      onboarding: { o: { agent: "openclaw", provider: "nvidia" } },
      setup_scenarios: { s: scenarioYaml },
    },
    expectedStates: {
      expected_states: { neg: stateYaml },
    },
    suites: { suites: {} },
  });
}

describe("expected_failure: loader validation", () => {
  it("accepts a complete state-level block", () => {
    const meta = makeMetadata({
      stateBlock: {
        phase: "preflight",
        error_class: "docker-missing",
        message_pattern: "docker",
        forbidden_side_effects: ["sandbox-created"],
      },
    });
    const plan = resolveScenario("s", meta);
    expect(plan.expected_failure?.phase).toBe("preflight");
    expect(plan.expected_failure?.error_class).toBe("docker-missing");
  });

  it("rejects unknown phase", () => {
    expect(() =>
      makeMetadata({
        stateBlock: { phase: "bogus", error_class: "docker-missing" },
      }),
    ).toThrow(/expected_failure\.phase/);
  });

  it("rejects unknown error_class", () => {
    expect(() =>
      makeMetadata({
        stateBlock: { phase: "preflight", error_class: "moon-missing" },
      }),
    ).toThrow(/expected_failure\.error_class/);
  });

  it("rejects invalid message_pattern regex", () => {
    expect(() =>
      makeMetadata({
        stateBlock: {
          phase: "preflight",
          error_class: "docker-missing",
          message_pattern: "(unclosed",
        },
      }),
    ).toThrow(/message_pattern is not a valid regex/);
  });

  it("rejects unknown forbidden_side_effects entry", () => {
    expect(() =>
      makeMetadata({
        stateBlock: {
          phase: "preflight",
          error_class: "docker-missing",
          forbidden_side_effects: ["paint-the-fence"],
        },
      }),
    ).toThrow(/forbidden_side_effects entry/);
  });

  it("rejects unknown keys in the block", () => {
    expect(() =>
      makeMetadata({
        stateBlock: {
          phase: "preflight",
          error_class: "docker-missing",
          rogue: true,
        },
      }),
    ).toThrow(/unknown key 'rogue'/);
  });

  it("requires phase + error_class at the state level", () => {
    expect(() => makeMetadata({ stateBlock: { phase: "preflight" } })).toThrow(
      /error_class is required/,
    );
  });

  it("rejects a non-mapping expected_states section", () => {
    expect(() =>
      loadMetadataFromObjects({
        scenarios: {
          platforms: { p: {} },
          installs: { i: {} },
          runtimes: { r: {} },
          onboarding: { o: { agent: "openclaw", provider: "nvidia" } },
          setup_scenarios: {},
        },
        expectedStates: { expected_states: [] },
        suites: { suites: {} },
      }),
    ).toThrow(/expected_states' must be a mapping/);
  });

  it("rejects scenario-level expected_failure when state has none", () => {
    expect(() =>
      resolveScenario(
        "s",
        makeMetadata({
          stateBlock: null,
          scenarioBlock: { phase: "preflight", error_class: "docker-missing" },
        }),
      ),
    ).toThrow(/expected_failure but expected_state.*does not/);
  });

  it("merges scenario-level override on top of state-level block", () => {
    const meta = makeMetadata({
      stateBlock: {
        phase: "preflight",
        error_class: "docker-missing",
        message_pattern: "docker",
        forbidden_side_effects: ["sandbox-created"],
      },
      scenarioBlock: {
        message_pattern: "(?i)daemon",
        forbidden_side_effects: ["gateway-started"],
      },
    });
    const plan = resolveScenario("s", meta);
    expect(plan.expected_failure?.message_pattern).toBe("(?i)daemon");
    expect(plan.expected_failure?.forbidden_side_effects).toEqual(["gateway-started"]);
    expect(plan.expected_failure?.phase).toBe("preflight");
  });
});

describe("expected_failure: matcher", () => {
  const expected: ExpectedFailure = {
    phase: "preflight",
    error_class: "docker-missing",
    message_pattern: "(?i)docker|daemon",
    forbidden_side_effects: ["sandbox-created", "gateway-started"],
  };

  function obs(over: Partial<ObservedFailure>): ObservedFailure {
    return {
      phase: "preflight",
      error_class: "docker-missing",
      log: "Cannot connect to the Docker daemon",
      observed_side_effects: [],
      ...over,
    };
  }

  it("passes when phase, class, pattern, and side-effects all match", () => {
    const report = matchExpectedFailure(expected, obs({}));
    expect(report.ok).toBe(true);
    expect(report.checks.every((c) => c.ok)).toBe(true);
  });

  it("fails on phase mismatch", () => {
    const report = matchExpectedFailure(expected, obs({ phase: "install" }));
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "phase")?.ok).toBe(false);
  });

  it("fails on error_class mismatch", () => {
    const report = matchExpectedFailure(expected, obs({ error_class: "gpu-missing" }));
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "error_class")?.ok).toBe(false);
  });

  it("skips error_class check when observation is undefined", () => {
    const report = matchExpectedFailure(expected, obs({ error_class: undefined }));
    const classCheck = report.checks.find((c) => c.name === "error_class");
    expect(classCheck?.ok).toBe(true);
    expect(classCheck?.message).toMatch(/skipped/);
  });

  it("fails when message_pattern does not match the log", () => {
    const report = matchExpectedFailure(
      expected,
      obs({ log: "something else entirely" }),
    );
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "message_pattern")?.ok).toBe(false);
  });

  it("fails when a forbidden side effect is observed", () => {
    const report = matchExpectedFailure(
      expected,
      obs({ observed_side_effects: ["sandbox-created"] }),
    );
    expect(report.ok).toBe(false);
    const sideCheck = report.checks.find((c) => c.name === "forbidden_side_effects");
    expect(sideCheck?.ok).toBe(false);
    expect(sideCheck?.message).toMatch(/sandbox-created/);
  });

  it("ignores non-forbidden observed side effects", () => {
    const trimmed: ExpectedFailure = {
      ...expected,
      forbidden_side_effects: ["gateway-started"],
    };
    const report = matchExpectedFailure(
      trimmed,
      obs({ observed_side_effects: ["sandbox-created"] }),
    );
    expect(report.ok).toBe(true);
  });
});

describe("expected_failure: real metadata", () => {
  it("loads structurally for ubuntu-no-docker-preflight-negative", () => {
    const meta = loadMetadataFromObjects({
      scenarios: yaml.load(`
platforms: { p: { os: ubuntu } }
installs: { i: {} }
runtimes: { r: { container_daemon: missing } }
onboarding: { o: { agent: openclaw, provider: nvidia } }
setup_scenarios:
  s:
    dimensions: { platform: p, install: i, runtime: r, onboarding: o }
    expected_state: neg
    suites: []
`) as object,
      expectedStates: yaml.load(`
expected_states:
  neg:
    cli: { installed: true }
    gateway: { expected: absent }
    sandbox: { expected: absent }
    expected_failure:
      phase: preflight
      error_class: docker-missing
      message_pattern: "(?i)docker|container|daemon|socket|preflight"
      forbidden_side_effects: [sandbox-created, gateway-started, credentials-written]
`) as object,
      suites: yaml.load(`
suites: {}
`) as object,
    });
    const plan = resolveScenario("s", meta);
    expect(plan.expected_failure).toBeTruthy();
    expect(plan.expected_failure?.forbidden_side_effects?.length).toBe(3);
  });
});
