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
    expect(observeOpenShellSandboxIdentity("alpha", list([row({ labels: { owner: 1 } })]))).toEqual(
      { kind: "unknown" },
    );
    expect(
      observeOpenShellSandboxIdentity("alpha", list([row({ resource_version: null })])),
    ).toEqual({ kind: "unknown" });
  });
});

describe("complete OpenShell 0.1.2 sandbox inventory", () => {
  const page = (sandboxes: unknown[], next_page_token: unknown = "") => ({
    status: 0,
    stdout: JSON.stringify({ sandboxes, next_page_token }),
    stderr: "",
  });

  it("reads one durable identity from a complete page", () => {
    expect(observeOpenShellSandboxIdentity("alpha", page([row()]))).toEqual({
      kind: "present",
      id: "sandbox-alpha",
      phase: "Ready",
    });
  });

  it("proves absence only from a complete valid inventory", () => {
    expect(classifyOpenShellSandboxPresence("alpha", page([]))).toBe("absent");
    expect(classifyOpenShellSandboxPresence("alpha", page([row({ name: "beta" })]))).toBe("absent");
  });

  it.each(["next", " ", null, 0, undefined])(
    "rejects a nonempty or invalid continuation token %s",
    (token) => {
      const response = {
        status: 0,
        stdout: JSON.stringify({ sandboxes: [], next_page_token: token }),
        stderr: "",
      };
      expect(classifyOpenShellSandboxPresence("alpha", response)).toBe("unknown");
    },
  );

  it("rejects partial presence rather than assuming unique identity", () => {
    expect(observeOpenShellSandboxIdentity("alpha", page([row()], "next"))).toEqual({
      kind: "unknown",
    });
  });

  it("retains row, duplicate and diagnostic rejection for complete pages", () => {
    expect(classifyOpenShellSandboxPresence("alpha", page([row(), row()]))).toBe("unknown");
    expect(classifyOpenShellSandboxPresence("alpha", page([row({ labels: null })]))).toBe(
      "unknown",
    );
    expect(classifyOpenShellSandboxPresence("alpha", { ...page([]), stderr: "warning" })).toBe(
      "unknown",
    );
    expect(classifyOpenShellSandboxPresence("alpha", { ...page([]), status: 1 })).toBe("unknown");
  });
});
