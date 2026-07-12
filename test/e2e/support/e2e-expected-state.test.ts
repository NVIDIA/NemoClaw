// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { describe, expect, it } from "vitest";

import { loadAgent } from "../../../src/lib/agent/defs.ts";
import {
  getExpectedState,
  listExpectedStates,
  probesForState,
  requireExpectedState,
} from "../registry/expected-states.ts";
import { loadManifest } from "../registry/manifests.ts";
import { listTargets } from "../registry/registry.ts";
import type { ExpectedState, StateProbeId } from "../registry/types.ts";

describe("typed expected-state registry behavior", () => {
  // source-shape-contract: compatibility -- Registry indexing keeps every shipped expected-state selector resolvable
  it("indexes every registered state by its unique id", () => {
    const states = listExpectedStates();
    const ids = states.map((state) => state.id);

    expect(states.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const state of states) {
      expect(getExpectedState(state.id)).toBe(state);
      expect(requireExpectedState(state.id)).toBe(state);
    }
  });

  // source-shape-contract: compatibility -- Unknown expected-state selectors must retain actionable failure diagnostics
  it("rejects an unknown state with an actionable inventory", () => {
    const unknown = "synthetic-unknown-state";

    expect(() => requireExpectedState(unknown)).toThrow(
      new RegExp(`Unknown expected_state id '${unknown}'.*available:`),
    );
  });
});

describe("expected-state probe compilation", () => {
  it.each<{
    dimension: string;
    state: ExpectedState;
    expected: StateProbeId[];
  }>([
    {
      dimension: "installed CLI",
      state: { id: "synthetic", cli: { installed: true } },
      expected: ["cli-installed"],
    },
    {
      dimension: "healthy gateway",
      state: { id: "synthetic", gateway: { expected: "present", health: "healthy" } },
      expected: ["gateway-healthy"],
    },
    {
      dimension: "absent gateway",
      state: { id: "synthetic", gateway: { expected: "absent" } },
      expected: ["gateway-absent"],
    },
    {
      dimension: "running sandbox",
      state: { id: "synthetic", sandbox: { expected: "present", status: "running" } },
      expected: ["sandbox-running"],
    },
    {
      dimension: "absent sandbox",
      state: { id: "synthetic", sandbox: { expected: "absent" } },
      expected: ["sandbox-absent"],
    },
    {
      dimension: "host registry preservation",
      state: { id: "synthetic", localRegistry: { expected: "present" } },
      expected: ["local-registry-entry-present"],
    },
    {
      dimension: "Docker container preservation",
      state: { id: "synthetic", dockerSandboxContainer: { expected: "present" } },
      expected: ["docker-sandbox-container-present"],
    },
  ])("emits the implemented probe for $dimension", ({ state, expected }) => {
    expect(probesForState(state)).toEqual(expected);
  });

  it("runs host-preservation probes before runtime-health probes", () => {
    const state: ExpectedState = {
      id: "synthetic-all-implemented-dimensions",
      cli: { installed: true },
      localRegistry: { expected: "present" },
      dockerSandboxContainer: { expected: "present" },
      gateway: { expected: "present", health: "healthy" },
      sandbox: { expected: "present", status: "running" },
    };

    expect(probesForState(state)).toEqual([
      "cli-installed",
      "local-registry-entry-present",
      "docker-sandbox-container-present",
      "gateway-healthy",
      "sandbox-running",
    ]);
  });

  it("does not invent probes for optional, unimplemented, or negative host dimensions", () => {
    const state: ExpectedState = {
      id: "synthetic-non-emitting-dimensions",
      gateway: { expected: "optional", health: "optional" },
      sandbox: { expected: "optional", status: "optional" },
      inference: { expected: "available", provider: "synthetic" },
      credentials: { expected: "present" },
      localRegistry: { expected: "absent" },
      dockerSandboxContainer: { expected: "absent" },
    };

    expect(probesForState(state)).toEqual([]);
  });
});

describe("target expected-state references", () => {
  // source-shape-contract: compatibility -- Every shipped target must resolve its expected-state runtime contract
  it("resolves every state id consumed by the typed target registry", () => {
    const referenced = listTargets()
      .map((target) => target.expectedStateId)
      .filter((id): id is string => id !== undefined);

    expect(referenced.length).toBeGreaterThan(0);
    for (const id of new Set(referenced)) {
      expect(getExpectedState(id), `expected_state '${id}' must resolve`).toBeDefined();
    }
  });

  // source-shape-contract: security -- Fail-closed targets must compile probes that forbid gateway and sandbox side effects
  it("compiles fail-closed absence probes for targets that forbid runtime side effects", () => {
    const failClosedTargets = listTargets().filter((target) => {
      const forbidden = target.expectedFailure?.forbiddenSideEffects ?? [];
      return forbidden.includes("gateway-started") && forbidden.includes("sandbox-created");
    });

    expect(failClosedTargets.length).toBeGreaterThan(0);
    for (const target of failClosedTargets) {
      const probes = probesForState(requireExpectedState(target.expectedStateId!));
      expect(probes, target.id).toEqual(
        expect.arrayContaining(["gateway-absent", "sandbox-absent"]),
      );
    }
  });

  // source-shape-contract: security -- Every preflight failure must compile absence probes before privileged runtime creation
  it("compiles absence probes for every preflight failure contract", () => {
    const preflightFailures = listTargets().filter(
      (target) => target.expectedFailure?.phase === "preflight",
    );

    expect(preflightFailures.length).toBeGreaterThan(0);
    for (const target of preflightFailures) {
      const probes = probesForState(requireExpectedState(target.expectedStateId!));
      expect(probes, target.id).toEqual(
        expect.arrayContaining(["gateway-absent", "sandbox-absent"]),
      );
    }
  });

  // source-shape-contract: security -- Policy-selection failures must stop before gateway or sandbox side effects
  it("keeps policy-selection failures limited to the installed CLI", () => {
    const policySelectionFailures = listTargets().filter(
      (target) => target.expectedFailure?.errorClass === "policy-presets-required",
    );

    expect(policySelectionFailures.length).toBeGreaterThan(0);
    for (const target of policySelectionFailures) {
      expect(probesForState(requireExpectedState(target.expectedStateId!)), target.id).toEqual([
        "cli-installed",
      ]);
    }
  });

  // source-shape-contract: compatibility -- Terminal agent targets must not require an unsupported host gateway probe
  it("omits host gateway probes for targets whose loaded agent runtime is terminal", () => {
    const targetAgents = listTargets()
      .filter((target) => target.manifestPath !== undefined)
      .map((target) => ({
        target,
        agent: loadAgent(
          loadManifest(path.resolve(import.meta.dirname, "../../..", target.manifestPath!)).document
            .spec.onboarding.agent,
        ),
      }));
    const terminalTargets = targetAgents.filter(({ agent }) => agent.runtime?.kind === "terminal");

    expect(targetAgents.length).toBe(listTargets().length);
    expect(terminalTargets.length).toBeGreaterThan(0);
    for (const { target } of terminalTargets) {
      const probes = probesForState(requireExpectedState(target.expectedStateId!));
      expect(probes, target.id).toContain("cli-installed");
      expect(probes, target.id).toContain("sandbox-running");
      expect(probes, target.id).not.toContain("gateway-healthy");
      expect(probes, target.id).not.toContain("gateway-absent");
    }
  });

  // source-shape-contract: security -- Post-reboot targets must retain host registry and container preservation probes
  it("compiles host-preservation probes for every post-reboot recovery target", () => {
    const recoveryTargets = listTargets().filter(
      (target) => target.environment?.lifecycle === "post-reboot-recovery",
    );

    expect(recoveryTargets.length).toBeGreaterThan(0);
    for (const target of recoveryTargets) {
      const probes = probesForState(requireExpectedState(target.expectedStateId!));
      expect(probes, target.id).toEqual(
        expect.arrayContaining([
          "local-registry-entry-present",
          "docker-sandbox-container-present",
        ]),
      );
    }
  });
});
