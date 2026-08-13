// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type {
  SandboxIdentityProbe,
  SandboxNameLabeledContainer,
} from "../../adapters/docker/sandbox-identity";
import {
  classifyDestroyContainerIdentity,
  type DestroyContainerIdentityVerdict,
  formatAmbiguousDestroyIdentity,
} from "./destroy-container-identity";

// The classifier is pure over a probe result: the Docker call + output parsing
// live in the probeSandboxNameContainers adapter (see sandbox-identity.test.ts).
function ok(rows: SandboxNameLabeledContainer[]): SandboxIdentityProbe {
  return { status: "ok", rows };
}

// Narrowing assertion helpers keep test bodies linear (no branching): they
// assert the verdict shape and let TypeScript narrow the union afterwards.
function expectAmbiguous(
  verdict: DestroyContainerIdentityVerdict,
): asserts verdict is Extract<DestroyContainerIdentityVerdict, { status: "ambiguous" }> {
  expect(verdict.status).toBe("ambiguous");
}

const MANAGED: SandboxNameLabeledContainer = {
  id: "aaaa000000000000",
  managedBy: "openshell",
  workspace: "default",
  sandboxId: "sb-real",
};

const FOREIGN: SandboxNameLabeledContainer = {
  id: "ffff000000000000",
  managedBy: "",
  workspace: "foreign",
  sandboxId: "",
};

describe("classifyDestroyContainerIdentity", () => {
  it("is clear when no container carries the sandbox-name label", () => {
    expect(classifyDestroyContainerIdentity("destroytest", ok([])).status).toBe("clear");
  });

  it("is clear for exactly one managed container", () => {
    expect(classifyDestroyContainerIdentity("destroytest", ok([MANAGED])).status).toBe("clear");
  });

  it("refuses when a foreign container shares the sandbox-name label (#8999 repro)", () => {
    // The exact repro: a real managed sandbox plus a busybox that borrows the
    // sandbox-name label with a different workspace and no managed marker.
    const verdict = classifyDestroyContainerIdentity("destroytest", ok([MANAGED, FOREIGN]));
    expectAmbiguous(verdict);
    expect(verdict.foreign).toHaveLength(1);
    expect(verdict.foreign[0].id).toBe(FOREIGN.id);
    expect(verdict.managed).toHaveLength(1);
    expect(verdict.reason).toContain("managed-by");
  });

  it("refuses a foreign-only match with no managed container behind it", () => {
    const verdict = classifyDestroyContainerIdentity("destroytest", ok([FOREIGN]));
    expectAmbiguous(verdict);
    expect(verdict.managed).toHaveLength(0);
    expect(verdict.foreign).toHaveLength(1);
  });

  it("refuses when managed containers span more than one workspace", () => {
    const verdict = classifyDestroyContainerIdentity(
      "destroytest",
      ok([
        MANAGED,
        { id: "bbbb000000000000", managedBy: "openshell", workspace: "other", sandboxId: "sb-real" },
      ]),
    );
    expectAmbiguous(verdict);
    expect(verdict.reason).toContain("workspace");
  });

  it("refuses when managed containers span more than one sandbox-id", () => {
    const verdict = classifyDestroyContainerIdentity(
      "destroytest",
      ok([
        MANAGED,
        { id: "cccc000000000000", managedBy: "openshell", workspace: "default", sandboxId: "sb-two" },
      ]),
    );
    expect(verdict.status).toBe("ambiguous");
  });

  it("refuses a managed container missing its sandbox-id label (identity unprovable) (#8999)", () => {
    // A second same-name row that is managed and in the same workspace but has
    // no sandbox-id must not be waved through as a single clear identity: the
    // blank label used to be filtered out before the uniqueness check.
    const verdict = classifyDestroyContainerIdentity(
      "destroytest",
      ok([
        MANAGED,
        { id: "dddd000000000000", managedBy: "openshell", workspace: "default", sandboxId: "" },
      ]),
    );
    expectAmbiguous(verdict);
    expect(verdict.reason).toContain("missing a required");
    expect(verdict.managed).toHaveLength(2);
  });

  it("refuses a lone managed container missing its workspace label (#8999)", () => {
    const verdict = classifyDestroyContainerIdentity(
      "destroytest",
      ok([{ id: "eeee000000000000", managedBy: "openshell", workspace: "", sandboxId: "sb-real" }]),
    );
    expectAmbiguous(verdict);
    expect(verdict.reason).toContain("missing a required");
  });

  it("passes a probe failure through as a fail-closed verdict (ambiguity unprovable)", () => {
    const verdict = classifyDestroyContainerIdentity("destroytest", {
      status: "probe-failed",
      detail: "Cannot connect to the Docker daemon",
    });
    expect(verdict.status).toBe("probe-failed");
  });
});

describe("formatAmbiguousDestroyIdentity", () => {
  it("names the refusal, both container roles with sandbox-id, and neutral recovery", () => {
    const verdict = classifyDestroyContainerIdentity("destroytest", ok([MANAGED, FOREIGN]));
    expectAmbiguous(verdict);
    const lines = formatAmbiguousDestroyIdentity(verdict, "nemoclaw").join("\n");
    expect(lines).toContain("Refusing to destroy sandbox 'destroytest'");
    expect(lines).toContain("Unexpected container:");
    expect(lines).toContain("Managed sandbox container:");
    expect(lines).toContain("sandbox-id=sb-real");
    expect(lines).toContain("Inspect, remove, or relabel the conflicting container");
    expect(lines).toContain("nemoclaw destroytest destroy --yes");
  });
});
