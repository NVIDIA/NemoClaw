// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  classifyOrphanedRegistrySandboxes,
  ORPHANED_SANDBOX_MARKER,
  orphanedRegistryRemediation,
  orphanedRegistrySummary,
} from "./orphan-detection";

type Entry = { name: string; gatewayName?: string };

function classify(sandboxes: Entry[], overrides: { observed?: string[]; reconnected?: string[] }) {
  return classifyOrphanedRegistrySandboxes(sandboxes, {
    observedNames: new Set(overrides.observed ?? []),
    reconnectedNames: new Set(overrides.reconnected ?? []),
    selectedGatewayName: "nemoclaw",
    resolveGatewayBinding: (sandbox) => sandbox.gatewayName ?? "nemoclaw",
  });
}

describe("classifyOrphanedRegistrySandboxes (#6520)", () => {
  it("flags an own-gateway sandbox unobserved in any phase", () => {
    expect(classify([{ name: "my-assistant" }], {})).toEqual([{ name: "my-assistant" }]);
  });

  it("excludes sandboxes the selected gateway observes", () => {
    expect(classify([{ name: "my-assistant" }], { observed: ["my-assistant"] })).toEqual([]);
  });

  it("excludes sandboxes the confirming second listing observed", () => {
    expect(classify([{ name: "my-assistant" }], { reconnected: ["my-assistant"] })).toEqual([]);
  });

  it("excludes sandboxes bound to a different gateway", () => {
    expect(classify([{ name: "elsewhere", gatewayName: "gateway-b" }], {})).toEqual([]);
  });

  it("never classifies a corrupted binding as an orphan", () => {
    expect(
      classifyOrphanedRegistrySandboxes([{ name: "tampered" }], {
        observedNames: new Set<string>(),
        reconnectedNames: new Set<string>(),
        selectedGatewayName: "nemoclaw",
        resolveGatewayBinding: () => {
          throw new Error("invalid persisted binding");
        },
      }),
    ).toEqual([]);
  });
});

describe("orphaned-registry messaging (#6520)", () => {
  it("renders the summary from the install.sh grep marker", () => {
    const summary = orphanedRegistrySummary(["a", "b"]);
    expect(summary).toBe(`2 ${ORPHANED_SANDBOX_MARKER}: a, b.`);
  });

  it("names concrete remediation commands", () => {
    const remediation = orphanedRegistryRemediation("nemoclaw");
    expect(remediation).toContain("cannot be recovered automatically");
    expect(remediation).toContain("`nemoclaw <name> destroy` to clear");
    expect(remediation).toContain("`nemoclaw onboard` to rebuild");
  });
});
