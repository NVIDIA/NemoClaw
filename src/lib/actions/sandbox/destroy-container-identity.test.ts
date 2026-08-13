// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  classifyDestroyContainerIdentity,
  type DestroyContainerIdentityVerdict,
  formatAmbiguousDestroyIdentity,
} from "./destroy-container-identity";

type Row = {
  id: string;
  managedBy?: string;
  workspace?: string;
  sandboxId?: string;
};

function fakeDockerRun(rows: Row[], status = 0): { status: number; stdout: string } {
  const stdout = rows
    .map((r) => [r.id, r.managedBy ?? "", r.workspace ?? "", r.sandboxId ?? ""].join("\t"))
    .join("\n");
  return { status, stdout };
}

// Narrowing assertion helpers keep test bodies linear (no branching): they
// assert the verdict shape and let TypeScript narrow the union afterwards.
function expectAmbiguous(
  verdict: DestroyContainerIdentityVerdict,
): asserts verdict is Extract<DestroyContainerIdentityVerdict, { status: "ambiguous" }> {
  expect(verdict.status).toBe("ambiguous");
}

function expectProbeFailed(
  verdict: DestroyContainerIdentityVerdict,
): asserts verdict is Extract<DestroyContainerIdentityVerdict, { status: "probe-failed" }> {
  expect(verdict.status).toBe("probe-failed");
}

const MANAGED = {
  id: "aaaa000000000000",
  managedBy: "openshell",
  workspace: "default",
  sandboxId: "sb-real",
} as const;

const FOREIGN = {
  id: "ffff000000000000",
  managedBy: "",
  workspace: "foreign",
  sandboxId: "",
} as const;

describe("classifyDestroyContainerIdentity", () => {
  it("is clear when no container carries the sandbox-name label", () => {
    const dockerRun = vi.fn(() => fakeDockerRun([]));
    expect(classifyDestroyContainerIdentity("destroytest", { dockerRun }).status).toBe("clear");
  });

  it("is clear for exactly one managed container", () => {
    const dockerRun = vi.fn(() => fakeDockerRun([MANAGED]));
    expect(classifyDestroyContainerIdentity("destroytest", { dockerRun }).status).toBe("clear");
  });

  it("refuses when a foreign container shares the sandbox-name label (#8999 repro)", () => {
    // The exact repro: a real managed sandbox plus a busybox that borrows the
    // sandbox-name label with a different workspace and no managed marker.
    const dockerRun = vi.fn(() => fakeDockerRun([MANAGED, FOREIGN]));
    const verdict = classifyDestroyContainerIdentity("destroytest", { dockerRun });
    expectAmbiguous(verdict);
    expect(verdict.foreign).toHaveLength(1);
    expect(verdict.foreign[0].id).toBe(FOREIGN.id);
    expect(verdict.managed).toHaveLength(1);
    expect(verdict.reason).toContain("managed-by");
  });

  it("refuses a foreign-only match with no managed container behind it", () => {
    const dockerRun = vi.fn(() => fakeDockerRun([FOREIGN]));
    const verdict = classifyDestroyContainerIdentity("destroytest", { dockerRun });
    expectAmbiguous(verdict);
    expect(verdict.managed).toHaveLength(0);
    expect(verdict.foreign).toHaveLength(1);
  });

  it("refuses when managed containers span more than one workspace", () => {
    const dockerRun = vi.fn(() =>
      fakeDockerRun([
        MANAGED,
        { id: "bbbb000000000000", managedBy: "openshell", workspace: "other", sandboxId: "sb-real" },
      ]),
    );
    const verdict = classifyDestroyContainerIdentity("destroytest", { dockerRun });
    expectAmbiguous(verdict);
    expect(verdict.reason).toContain("workspace");
  });

  it("refuses when managed containers span more than one sandbox-id", () => {
    const dockerRun = vi.fn(() =>
      fakeDockerRun([
        MANAGED,
        { id: "cccc000000000000", managedBy: "openshell", workspace: "default", sandboxId: "sb-two" },
      ]),
    );
    expect(classifyDestroyContainerIdentity("destroytest", { dockerRun }).status).toBe("ambiguous");
  });

  it("refuses a managed container missing its sandbox-id label (identity unprovable) (#8999)", () => {
    // A second same-name row that is managed and in the same workspace but has
    // no sandbox-id must not be waved through as a single clear identity: the
    // blank label used to be filtered out before the uniqueness check.
    const dockerRun = vi.fn(() =>
      fakeDockerRun([
        MANAGED,
        { id: "dddd000000000000", managedBy: "openshell", workspace: "default", sandboxId: "" },
      ]),
    );
    const verdict = classifyDestroyContainerIdentity("destroytest", { dockerRun });
    expectAmbiguous(verdict);
    expect(verdict.reason).toContain("missing a required");
    expect(verdict.managed).toHaveLength(2);
  });

  it("refuses a lone managed container missing its workspace label (#8999)", () => {
    const dockerRun = vi.fn(() =>
      fakeDockerRun([{ id: "eeee000000000000", managedBy: "openshell", workspace: "", sandboxId: "sb-real" }]),
    );
    const verdict = classifyDestroyContainerIdentity("destroytest", { dockerRun });
    expectAmbiguous(verdict);
    expect(verdict.reason).toContain("missing a required");
  });

  it("does not block when the Docker probe fails (ambiguity unprovable)", () => {
    const dockerRun = vi.fn(() => ({ status: 1, stdout: "", stderr: "Cannot connect to daemon" }));
    const verdict = classifyDestroyContainerIdentity("destroytest", { dockerRun });
    expectProbeFailed(verdict);
    expect(verdict.detail).toContain("daemon");
  });

  it("ignores blank and malformed lines without misclassifying", () => {
    const dockerRun = vi.fn(() => ({
      status: 0,
      stdout: `\n  \n${["aaaa000000000000", "openshell", "default", "sb-real"].join("\t")}\n`,
    }));
    expect(classifyDestroyContainerIdentity("destroytest", { dockerRun }).status).toBe("clear");
  });

  it("filters ONLY on the sandbox-name label so foreign containers stay visible", () => {
    const dockerRun = vi.fn(() => fakeDockerRun([MANAGED]));
    classifyDestroyContainerIdentity("destroytest", { dockerRun });
    const argv = dockerRun.mock.calls[0][0] as string[];
    expect(argv).toContain("label=openshell.ai/sandbox-name=destroytest");
    expect(argv.some((a) => a.includes("managed-by="))).toBe(false);
  });
});

describe("formatAmbiguousDestroyIdentity", () => {
  it("names the refusal, both container roles with sandbox-id, and neutral recovery", () => {
    const verdict = classifyDestroyContainerIdentity("destroytest", {
      dockerRun: () => fakeDockerRun([MANAGED, FOREIGN]),
    });
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
