// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { namedOpenShellGateway, selectedOpenShellGateway } from "./sandbox-observer";
import type { CapturedOpenShellCommandResult } from "./sandbox-observer-cli";
import {
  classifyCliOpenShellSandboxPolicySetResult,
  createCliOpenShellSandboxPolicyReader,
  createSyncCliOpenShellSandboxPolicyWriter,
  createSyncCliOpenShellSandboxPolicyReader,
} from "./sandbox-policy-cli";

const POLICY = "version: 1\nnetwork_policies: {}";

function captured(overrides: Partial<CapturedOpenShellCommandResult> = {}) {
  return { status: 0, output: `Version: 4\nActive: 3\n---\n${POLICY}`, ...overrides };
}

describe("CLI OpenShell sandbox policy reader", () => {
  it("maps synchronous base reads to the recorded gateway", () => {
    const capture = vi.fn(() => captured());
    const reader = createSyncCliOpenShellSandboxPolicyReader({ capture });

    expect(
      reader.readSandboxPolicy({
        target: namedOpenShellGateway("nemoclaw"),
        sandboxName: "alpha",
        scope: "base",
      }),
    ).toEqual({ ok: true, value: { document: POLICY, appliedRevision: 3 } });
    expect(capture).toHaveBeenCalledWith(
      ["policy", "get", "-g", "nemoclaw", "--base", "alpha"],
      expect.objectContaining({ ignoreError: true, timeout: 15_000 }),
    );
  });

  it("maps effective, inspection, and revision reads to exact CLI arguments", async () => {
    const capture = vi
      .fn()
      .mockReturnValueOnce(captured())
      .mockReturnValueOnce(
        captured({
          output: JSON.stringify({
            scope: "sandbox",
            sandbox: "alpha",
            status: "effective",
            policy_source: "sandbox",
            hash: "sha256:policy",
            active_version: 4,
            policy: { version: 1, network_policies: {} },
          }),
        }),
      )
      .mockReturnValueOnce(captured({ output: `Version: 7\n---\n${POLICY}` }));
    const reader = createCliOpenShellSandboxPolicyReader({ capture, defaultTimeoutMs: 7_000 });

    await expect(
      reader.readSandboxPolicy({
        target: selectedOpenShellGateway(),
        sandboxName: "alpha",
        scope: "effective",
      }),
    ).resolves.toMatchObject({ ok: true, value: { document: POLICY } });
    await expect(
      reader.inspectSandboxPolicy({
        target: namedOpenShellGateway("nemoclaw"),
        sandboxName: "alpha",
      }),
    ).resolves.toMatchObject({ ok: true, value: { policySource: "sandbox" } });
    await expect(
      reader.readSandboxPolicyRevision({
        target: namedOpenShellGateway("nemoclaw"),
        sandboxName: "alpha",
        revision: 7,
      }),
    ).resolves.toEqual({ ok: true, value: { document: POLICY, revision: 7 } });
    expect(capture.mock.calls.map(([args]) => args)).toEqual([
      ["policy", "get", "--full", "alpha"],
      ["policy", "get", "-g", "nemoclaw", "--full", "--output", "json", "alpha"],
      ["policy", "get", "-g", "nemoclaw", "--rev", "7", "--base", "alpha"],
    ]);
  });

  it("fails closed on malformed output and invalid revisions", async () => {
    const capture = vi.fn(() => captured({ output: "Version: 3\n---\nnetwork_policies: [" }));
    const reader = createCliOpenShellSandboxPolicyReader({ capture });
    const request = {
      target: selectedOpenShellGateway(),
      sandboxName: "alpha",
      scope: "base" as const,
    };

    await expect(reader.readSandboxPolicy(request)).resolves.toMatchObject({
      ok: false,
      error: { kind: "schema" },
    });
    await expect(
      reader.readSandboxPolicyRevision({ ...request, revision: 0 }),
    ).resolves.toMatchObject({ ok: false, error: { reason: "invalid_request" } });
  });

  it.each([
    ["unauthorized credential-value", "authentication", undefined],
    ["handshake verification failed credential-value", "transport", "identity_mismatch"],
  ])("maps and redacts %s", async (diagnostic, kind, reason) => {
    const reader = createCliOpenShellSandboxPolicyReader({
      capture: vi.fn(() => captured({ status: 1, output: diagnostic })),
    });
    const result = await reader.readSandboxPolicy({
      target: selectedOpenShellGateway(),
      sandboxName: "alpha",
      scope: "base",
    });

    expect(result).toMatchObject({ ok: false, error: { kind, ...(reason ? { reason } : {}) } });
    expect(JSON.stringify(result)).not.toContain("credential-value");
  });

  it("maps timeouts without exposing subprocess diagnostics", async () => {
    const reader = createCliOpenShellSandboxPolicyReader({
      capture: vi.fn(() =>
        captured({
          status: null,
          output: "credential-value",
          error: Object.assign(new Error("credential-value"), { code: "ETIMEDOUT" }),
        }),
      ),
    });
    const result = await reader.readSandboxPolicy({
      target: selectedOpenShellGateway(),
      sandboxName: "alpha",
      scope: "base",
    });

    expect(result).toMatchObject({ ok: false, error: { kind: "timeout" } });
    expect(JSON.stringify(result)).not.toContain("credential-value");
  });

  it("preserves typed missing-binary guidance from the bounded capture boundary", async () => {
    const capture = vi.fn(() =>
      captured({
        status: null,
        output: "",
        error: Object.assign(new Error("OpenShell binary not found"), { code: "ENOENT" }),
      }),
    );
    const reader = createCliOpenShellSandboxPolicyReader({ capture });
    await expect(
      reader.readSandboxPolicy({
        target: namedOpenShellGateway("nemoclaw"),
        sandboxName: "alpha",
        scope: "base",
      }),
    ).resolves.toMatchObject({ ok: false, error: { kind: "command" } });
    expect(capture).toHaveBeenCalledWith(
      ["policy", "get", "-g", "nemoclaw", "--base", "alpha"],
      expect.objectContaining({ maxBuffer: 1024 * 1024, timeout: 15_000 }),
    );
  });
});

describe("CLI OpenShell sandbox policy writer", () => {
  it("maps a successful synchronous write to exact gateway-pinned arguments", () => {
    const capture = vi.fn(() => captured({ output: "" }));
    const writer = createSyncCliOpenShellSandboxPolicyWriter({ capture });

    expect(
      writer.setSandboxPolicy({
        target: namedOpenShellGateway("nemoclaw"),
        sandboxName: "my-dev-assistant-v2",
        policyPath: "/tmp/policy.yaml",
      }),
    ).toEqual({ outcome: { kind: "applied" }, status: 0 });
    expect(capture).toHaveBeenCalledWith(
      [
        "policy",
        "set",
        "-g",
        "nemoclaw",
        "--policy",
        "/tmp/policy.yaml",
        "--wait",
        "my-dev-assistant-v2",
      ],
      expect.objectContaining({ ignoreError: true, timeout: 15_000 }),
    );
  });

  it("classifies an authoritative policy refusal without exposing it as a transport error", () => {
    const stderr =
      "Error: code: 'Failed precondition', message: 'network policy rejected', " +
      "source: tonic::Status { code: FailedPrecondition, grpc_status: 9 }";
    const capture = vi.fn((_args: string[]) => captured({ status: 1, output: "", stderr }));
    const writer = createSyncCliOpenShellSandboxPolicyWriter({
      capture,
    });

    expect(
      writer.setSandboxPolicy({
        target: selectedOpenShellGateway(),
        sandboxName: "alpha",
        policyPath: "/tmp/policy.yaml",
      }),
    ).toEqual({
      outcome: { kind: "rejected", status: 1, message: "network policy rejected" },
      status: 1,
    });
    expect(capture.mock.calls[0]?.[0]).toEqual([
      "policy",
      "set",
      "--policy",
      "/tmp/policy.yaml",
      "--wait",
      "alpha",
    ]);
  });

  it("rejects an invalid sandbox name before invoking OpenShell", () => {
    const capture = vi.fn(() => captured({ output: "" }));
    const writer = createSyncCliOpenShellSandboxPolicyWriter({ capture });

    expect(() =>
      writer.setSandboxPolicy({
        target: selectedOpenShellGateway(),
        sandboxName: "alpha; whoami",
        policyPath: "/tmp/policy.yaml",
      }),
    ).toThrow("Invalid OpenShell sandbox name");
    expect(capture).not.toHaveBeenCalled();
  });

  it.each([
    [
      "an HTTP/2 reset",
      captured({
        status: 1,
        output: "",
        stderr: "Error: code: 'Internal error', message: 'h2 protocol error: http2 error'",
      }),
    ],
    [
      "a missing exit status",
      captured({
        status: null,
        output: "",
        error: Object.assign(new Error("spawnSync openshell ENOENT"), { code: "ENOENT" }),
      }),
    ],
    ["an unstructured nonzero exit", captured({ status: 1, output: "", stderr: "refused" })],
  ])("classifies %s as ambiguous", (_label, result) => {
    expect(classifyCliOpenShellSandboxPolicySetResult(result)).toMatchObject({
      kind: "ambiguous",
    });
  });
});
