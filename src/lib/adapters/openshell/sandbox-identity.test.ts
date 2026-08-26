// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createOpenshellSandboxIdReader,
  fingerprintOpenShellSandboxId,
  fingerprintOpenShellSandboxLiveIdentity,
  isOpenShellSandboxId,
  NEMOCLAW_CREATE_ATTEMPT_LABEL,
  NEMOCLAW_CREATE_ATTEMPT_NONCE_HEX_LENGTH,
  parseOpenShellSandboxId,
  resolveCreatedOpenShellSandboxId,
} from "./sandbox-identity";

const CREATE_ATTEMPT_NONCE = "a".repeat(NEMOCLAW_CREATE_ATTEMPT_NONCE_HEX_LENGTH);

function sandboxListJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify([
    {
      id: "sandbox-alpha",
      name: "alpha",
      labels: { [NEMOCLAW_CREATE_ATTEMPT_LABEL]: CREATE_ATTEMPT_NONCE },
      resource_version: 1,
      created_at: "2026-08-25T00:00:00Z",
      phase: "Ready",
      current_policy_version: 1,
      ...overrides,
    },
  ]);
}

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
    expect(fingerprintOpenShellSandboxLiveIdentity("Id: first\nId: second\n")).toBeNull();
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
  it("binds the first ID to an exact create-attempt label (#9833)", () => {
    const runCaptureOpenshell = vi.fn(() => sandboxListJson());

    expect(
      resolveCreatedOpenShellSandboxId({
        sandboxName: "alpha",
        gatewayName: "nemoclaw",
        createAttemptNonce: CREATE_ATTEMPT_NONCE,
        runCaptureOpenshell,
      }),
    ).toBe("sandbox-alpha");
    expect(runCaptureOpenshell).toHaveBeenCalledExactlyOnceWith(
      [
        "sandbox",
        "list",
        "-g",
        "nemoclaw",
        "--selector",
        `${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${CREATE_ATTEMPT_NONCE}`,
        "--output",
        "json",
        "--limit",
        "2",
      ],
      {
        ignoreError: false,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        killSignal: "SIGKILL",
        killProcessTreeOnTimeout: true,
      },
    );
  });

  it.each(["a".repeat(61), "a".repeat(63), "a".repeat(64), "g".repeat(62)])(
    "refuses a create-attempt nonce outside the label-compatible contract (#9833)",
    (createAttemptNonce) => {
      const runCaptureOpenshell = vi.fn();

      expect(() =>
        resolveCreatedOpenShellSandboxId({
          sandboxName: "alpha",
          gatewayName: "nemoclaw",
          createAttemptNonce,
          runCaptureOpenshell,
        }),
      ).toThrow("OpenShell sandbox create-attempt identity is invalid.");
      expect(runCaptureOpenshell).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["same-name replacement", sandboxListJson({ labels: {} })],
    ["different name", sandboxListJson({ name: "bravo" })],
    ["ambiguous rows", `${sandboxListJson().slice(0, -1)},${sandboxListJson().slice(1)}`],
    ["malformed row", sandboxListJson({ id: "invalid/id" })],
    ["oversized row", sandboxListJson({ id: "a".repeat(513) })],
  ])("refuses %s without disclosing captured metadata (#9833)", (_case, output) => {
    const outputCanary = "captured-metadata-canary";
    const capturedRows = (JSON.parse(output) as Array<Record<string, unknown>>).map((row) => ({
      ...row,
      diagnostic: outputCanary,
    }));
    const runCaptureOpenshell = vi.fn(() => JSON.stringify(capturedRows));

    let caught: unknown;
    try {
      resolveCreatedOpenShellSandboxId({
        sandboxName: "alpha",
        gatewayName: "nemoclaw",
        createAttemptNonce: CREATE_ATTEMPT_NONCE,
        runCaptureOpenshell,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).toContain(
      "OpenShell did not return the exact created identity for sandbox 'alpha'",
    );
    expect(String(caught)).not.toContain(outputCanary);
    expect(String(caught)).not.toContain(CREATE_ATTEMPT_NONCE);
  });

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
