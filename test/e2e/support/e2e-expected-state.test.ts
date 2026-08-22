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
