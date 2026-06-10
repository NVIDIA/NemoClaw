// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  getExpectedState,
  listExpectedStates,
  probesForState,
  requireExpectedState,
} from "../scenarios/expected-states.ts";
import { listScenarios } from "../scenarios/registry.ts";
import type { ExpectedState } from "../scenarios/types.ts";

// The typed registry in `scenarios/expected-states.ts` is the single source
// of truth for live Vitest state-validation fixtures.
describe("typed expected-state registry id coverage", () => {
  it("exposes a non-empty list of registered expected-state ids", () => {
    const ids = listExpectedStates().map((s) => s.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("requireExpectedState throws on unknown id with available list", () => {
    expect(() => requireExpectedState("does-not-exist")).toThrow(/Unknown expected_state/);
  });

  it("getExpectedState returns the state for known ids", () => {
    expect(getExpectedState("cloud-openclaw-ready")?.id).toBe("cloud-openclaw-ready");
  });
});

describe("probesForState maps typed expected-state into probe ids", () => {
  it("ready cloud state emits cli-installed, gateway-healthy, sandbox-running", () => {
    expect(probesForState(requireExpectedState("cloud-openclaw-ready"))).toEqual([
      "cli-installed",
      "gateway-healthy",
      "sandbox-running",
    ]);
  });

  it("preflight-failure state emits cli-installed, gateway-absent, sandbox-absent", () => {
    expect(probesForState(requireExpectedState("preflight-failure-no-sandbox"))).toEqual([
      "cli-installed",
      "gateway-absent",
      "sandbox-absent",
    ]);
  });

  it("optional-dimension state emits cli-installed only", () => {
    expect(probesForState(requireExpectedState("macos-cli-ready-docker-optional"))).toEqual([
      "cli-installed",
    ]);
  });

  it("inference and credentials probes are intentionally NOT emitted yet", () => {
    // The typed registry declares inference.expected=available and
    // credentials.expected=present for ready states; the compiler does
    // not yet emit probe actions for those dimensions because the
    // probe scripts aren't written. This test pins that gap so a
    // future probe-script PR is forced to update probesForState too.
    const state: ExpectedState = {
      id: "synthetic",
      inference: { expected: "available", provider: "nvidia" },
      credentials: { expected: "present" },
    };
    expect(probesForState(state)).toEqual([]);
  });

  it("localRegistry.expected=present emits the local-registry-entry-present probe", () => {
    const state: ExpectedState = {
      id: "synthetic-local-registry",
      cli: { installed: true },
      localRegistry: { expected: "present" },
    };
    expect(probesForState(state)).toEqual(["cli-installed", "local-registry-entry-present"]);
  });

  it("dockerSandboxContainer.expected=present emits the docker-sandbox-container-present probe", () => {
    const state: ExpectedState = {
      id: "synthetic-docker-container",
      cli: { installed: true },
      dockerSandboxContainer: { expected: "present" },
    };
    expect(probesForState(state)).toEqual(["cli-installed", "docker-sandbox-container-present"]);
  });

  it("localRegistry/dockerSandboxContainer 'absent' emits no probe today", () => {
    // Negative-direction probes haven't landed yet. Pin the gap so a
    // future negative-scenario PR is forced to add the absent probes.
    const state: ExpectedState = {
      id: "synthetic-host-absent",
      localRegistry: { expected: "absent" },
      dockerSandboxContainer: { expected: "absent" },
    };
    expect(probesForState(state)).toEqual([]);
  });

  it("post-reboot-recovery-ready locks down host-side invariants only", () => {
    // The post-reboot scenario locks the user-visible regression
    // surface: registry preservation and Docker container
    // preservation. Runtime liveness probes (gateway/sandbox) are
    // intentionally omitted because they're environmental on
    // `ubuntu-latest` after a simulated reboot and would mask the
    // host-side signal. See the comment on `postRebootRecoveryReady`
    // in `scenarios/expected-states.ts`.
    expect(probesForState(requireExpectedState("post-reboot-recovery-ready"))).toEqual([
      "cli-installed",
      "local-registry-entry-present",
      "docker-sandbox-container-present",
    ]);
  });
});

describe("expected-state registry covers every scenario referenced in the typed registry", () => {
  it("every ScenarioDefinition.expectedStateId resolves in the typed expected-state registry", () => {
    const referenced = new Set<string>();
    for (const scenario of listScenarios()) {
      if (scenario.expectedStateId) {
        referenced.add(scenario.expectedStateId);
      }
    }
    expect(referenced.size).toBeGreaterThan(0);
    for (const id of referenced) {
      expect(
        getExpectedState(id),
        `expected_state '${id}' must be in the typed registry`,
      ).toBeDefined();
    }
  });
});
