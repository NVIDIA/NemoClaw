// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { inspectDockerSandboxIdentities } from "./inspect";

const LABELS = {
  managedBy: "openshell.ai/managed-by",
  workspace: "openshell.ai/sandbox-workspace",
  sandboxId: "openshell.ai/sandbox-id",
};

describe("inspectDockerSandboxIdentities", () => {
  it("queries only the sandbox-name label and parses one exact row", () => {
    const inspect = vi.fn((_args: readonly string[]) => ({
      status: 0,
      stdout: "aaaa000000000000\topenshell\tdefault\tsb-real",
    }));

    expect(
      inspectDockerSandboxIdentities("openshell.ai/sandbox-name=alpha", LABELS, inspect),
    ).toEqual({
      status: "observed",
      malformedRows: 0,
      rows: [
        {
          id: "aaaa000000000000",
          managedBy: "openshell",
          workspace: "default",
          sandboxId: "sb-real",
        },
      ],
    });
    expect(inspect.mock.calls[0][0]).toContain("-a");
    expect(inspect.mock.calls[0][0]).toContain("label=openshell.ai/sandbox-name=alpha");
    expect(inspect.mock.calls[0][0]).not.toContain("label=openshell.ai/managed-by=openshell");
  });

  it.each([
    ["trailing vertical tab", "openshell\u000b"],
    ["leading whitespace", " openshell"],
  ])("rejects %s instead of normalizing a trusted label", (_label, managedBy) => {
    expect(
      inspectDockerSandboxIdentities("openshell.ai/sandbox-name=alpha", LABELS, () => ({
        status: 0,
        stdout: `aaaa000000000000\t${managedBy}\tdefault\tsb-real`,
      })),
    ).toEqual({ status: "observed", rows: [], malformedRows: 1 });
  });

  it("preserves probe diagnostics for caller-side sanitization", () => {
    expect(
      inspectDockerSandboxIdentities("openshell.ai/sandbox-name=alpha", LABELS, () => ({
        status: 1,
        stderr: "daemon unavailable",
      })),
    ).toEqual({ status: "probe-failed", detail: "daemon unavailable" });
  });
});
