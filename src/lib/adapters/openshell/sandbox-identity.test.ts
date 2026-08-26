// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createOpenshellSandboxIdReader,
  fingerprintOpenShellSandboxId,
  fingerprintOpenShellSandboxLiveIdentity,
  isOpenShellSandboxId,
  parseOpenShellSandboxId,
} from "./sandbox-identity";

describe("OpenShell sandbox identity parsing", () => {
  it("accepts one exact durable ID with optional terminal color", () => {
    expect(parseOpenShellSandboxId("Name: alpha\nID: sandbox-alpha\n")).toBe("sandbox-alpha");
    expect(parseOpenShellSandboxId("\u001b[32mId: sandbox.alpha_2\u001b[0m\n")).toBe(
      "sandbox.alpha_2",
    );
  });

  it("rejects ambiguous or non-canonical IDs", () => {
    expect(parseOpenShellSandboxId("ID: first\nID: second\n")).toBeNull();
    expect(parseOpenShellSandboxId("ID: sandbox/alpha\n")).toBeNull();
    expect(parseOpenShellSandboxId("id: sandbox-alpha\n")).toBeNull();
  });

  it("fingerprints only one bounded durable ID (#9203)", () => {
    expect(fingerprintOpenShellSandboxLiveIdentity("Name: alpha\nId: sandbox-alpha\n")).toBe(
      createHash("sha256").update("sandbox-alpha").digest("hex"),
    );
    expect(fingerprintOpenShellSandboxLiveIdentity("Name: alpha\nID: sandbox-alpha\n")).toBe(
      createHash("sha256").update("sandbox-alpha").digest("hex"),
    );
    expect(fingerprintOpenShellSandboxLiveIdentity("Name: alpha\nPhase: Ready\n")).toBeNull();
    expect(fingerprintOpenShellSandboxLiveIdentity("ID: first\nID: second\n")).toBeNull();
    expect(fingerprintOpenShellSandboxId("sandbox-alpha")).toBe(
      createHash("sha256").update("sandbox-alpha").digest("hex"),
    );
    expect(fingerprintOpenShellSandboxId("sandbox/alpha")).toBeNull();
    expect(fingerprintOpenShellSandboxId("a".repeat(513))).toBeNull();
    expect(isOpenShellSandboxId("sandbox.alpha_2")).toBe(true);
    expect(isOpenShellSandboxId("sandbox/alpha")).toBe(false);
    expect(isOpenShellSandboxId("a".repeat(513))).toBe(false);
  });
});

describe("OpenShell sandbox identity reading", () => {
  it("reads each sandbox ID once per process (#9316)", () => {
    const runCommand = vi.fn(() => ({ status: 0, stdout: "Name: alpha\nID: sandbox-alpha\n" }));
    const readSandboxId = createOpenshellSandboxIdReader("/usr/bin/openshell", runCommand);

    expect(readSandboxId("alpha")).toBe("sandbox-alpha");
    expect(readSandboxId("alpha")).toBe("sandbox-alpha");
    expect(runCommand).toHaveBeenCalledExactlyOnceWith("/usr/bin/openshell", [
      "sandbox",
      "get",
      "alpha",
    ]);
  });

  it("caches a failed sandbox ID lookup as unavailable (#9316)", () => {
    const runCommand = vi.fn((): { status: number; stdout: string } => {
      throw new Error("OpenShell unavailable");
    });
    const readSandboxId = createOpenshellSandboxIdReader("/usr/bin/openshell", runCommand);

    expect(readSandboxId("alpha")).toBeNull();
    expect(readSandboxId("alpha")).toBeNull();
    expect(runCommand).toHaveBeenCalledOnce();
  });
});
