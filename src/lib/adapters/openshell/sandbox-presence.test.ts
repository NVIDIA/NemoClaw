// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  classifyOpenShellSandboxPresence,
  observeOpenShellSandboxIdentity,
} from "./sandbox-presence";

function list(rows: unknown[]) {
  return { status: 0, stdout: JSON.stringify(rows), stderr: "" };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "sandbox-alpha",
    name: "alpha",
    labels: {},
    resource_version: 1,
    created_at: "2026-08-25T00:00:00Z",
    phase: "Ready",
    current_policy_version: 1,
    ...overrides,
  };
}

describe("structured OpenShell sandbox identity", () => {
  it("returns one exact durable ID and phase", () => {
    expect(observeOpenShellSandboxIdentity("alpha", list([row()]))).toEqual({
      kind: "present",
      id: "sandbox-alpha",
      phase: "Ready",
    });
    expect(classifyOpenShellSandboxPresence("alpha", list([row()]))).toBe("present");
  });

  it("distinguishes absence from malformed or ambiguous authority", () => {
    expect(observeOpenShellSandboxIdentity("alpha", list([row({ name: "beta" })]))).toEqual({
      kind: "absent",
    });
    expect(observeOpenShellSandboxIdentity("alpha", list([row(), row()]))).toEqual({
      kind: "unknown",
    });
    expect(observeOpenShellSandboxIdentity("alpha", list([row({ id: "sandbox/alpha" })]))).toEqual({
      kind: "unknown",
    });
    expect(observeOpenShellSandboxIdentity("alpha", list([row({ id: "a".repeat(513) })]))).toEqual({
      kind: "unknown",
    });
  });

  it("fails closed on command diagnostics or malformed rows", () => {
    expect(
      observeOpenShellSandboxIdentity("alpha", {
        status: 0,
        stdout: JSON.stringify([row()]),
        stderr: "warning",
      }),
    ).toEqual({ kind: "unknown" });
    expect(observeOpenShellSandboxIdentity("alpha", list([row({ phase: "" })]))).toEqual({
      kind: "unknown",
    });
  });
});
