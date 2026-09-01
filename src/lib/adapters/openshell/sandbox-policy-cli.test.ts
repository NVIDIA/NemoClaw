// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import * as openshellRuntime from "./runtime";
import { namedOpenShellGateway, selectedOpenShellGateway } from "./sandbox-observer";
import {
  type CapturedPolicyCommandResult,
  createCliOpenShellSandboxPolicyRead,
  createCliOpenShellSandboxPolicyReader,
  createSyncCliOpenShellSandboxPolicyReader,
  readCliOpenShellSandboxPolicy,
} from "./sandbox-policy-cli";

const POLICY = "version: 1\nnetwork_policies: {}";

function result(overrides: Partial<CapturedPolicyCommandResult> = {}): CapturedPolicyCommandResult {
  return {
    status: 0,
    output: `Version: 4\nActive: 3\n---\n${POLICY}`,
    ...overrides,
  };
}

describe("CLI OpenShell sandbox policy reader", () => {
  it("supports synchronous transactional policy reads through the same boundary", () => {
    const capture = vi.fn(() => result());
    const reader = createSyncCliOpenShellSandboxPolicyReader({ capture });

    expect(
      reader.readSandboxPolicy({
        target: namedOpenShellGateway("nemoclaw"),
        sandboxName: "alpha",
        scope: "base",
      }),
    ).toMatchObject({ ok: true, value: { document: POLICY } });
    expect(capture).toHaveBeenCalledWith(
      ["policy", "get", "-g", "nemoclaw", "--base", "alpha"],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("maps a named-gateway base read to exact CLI arguments (#9805)", async () => {
    const capture = vi.fn(() => result());
    const reader = createCliOpenShellSandboxPolicyReader({ capture });

    await expect(
      reader.readSandboxPolicy({
        target: namedOpenShellGateway("nemoclaw-8091"),
        sandboxName: "alpha",
        scope: "base",
        timeoutMs: 2_500,
      }),
    ).resolves.toEqual({
      ok: true,
      value: {
        document: POLICY,
        appliedRevision: 3,
      },
    });
    expect(capture).toHaveBeenCalledWith(
      ["policy", "get", "-g", "nemoclaw-8091", "--base", "alpha"],
      {
        ignoreError: true,
        includeStderr: true,
        includeStreams: true,
        timeout: 2_500,
      },
    );
  });

  it("maps an effective read to the private --full CLI flag (#9805)", async () => {
    const capture = vi.fn(() =>
      result({
        output: "Version: 9\nActive: 9\n---\nversion: 1\nnetwork_policies:\n  _provider_nvidia: {}",
      }),
    );
    const reader = createCliOpenShellSandboxPolicyReader({ capture, defaultTimeoutMs: 7_000 });

    const read = await reader.readSandboxPolicy({
      target: selectedOpenShellGateway(),
      sandboxName: "alpha",
      scope: "effective",
    });

    expect(read).toEqual({
      ok: true,
      value: {
        document: "version: 1\nnetwork_policies:\n  _provider_nvidia: {}",
        appliedRevision: 9,
      },
    });
    expect(capture).toHaveBeenCalledWith(
      ["policy", "get", "--full", "alpha"],
      expect.objectContaining({ timeout: 7_000 }),
    );
  });

  it("maps policy inspection to machine-readable full-policy arguments (#9805)", async () => {
    const capture = vi.fn(() =>
      result({
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
    );
    const reader = createCliOpenShellSandboxPolicyReader({ capture });

    await expect(
      reader.inspectSandboxPolicy({
        target: namedOpenShellGateway("nemoclaw-8091"),
        sandboxName: "alpha",
      }),
    ).resolves.toEqual({
      ok: true,
      value: {
        policySource: "sandbox",
        effectivePolicy: { version: 1, network_policies: {} },
        policyIdentity: { hash: "sha256:policy", activeVersion: 4 },
      },
    });
    expect(capture).toHaveBeenCalledWith(
      ["policy", "get", "-g", "nemoclaw-8091", "--full", "--output", "json", "alpha"],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("reads an immutable base-policy revision through the typed boundary (#9805)", async () => {
    const capture = vi.fn(() =>
      result({ output: "Version: 7\n---\nversion: 1\nnetwork_policies: {}" }),
    );
    const reader = createCliOpenShellSandboxPolicyReader({ capture });

    await expect(
      reader.readSandboxPolicyRevision({
        target: namedOpenShellGateway("nemoclaw"),
        sandboxName: "alpha",
        revision: 7,
      }),
    ).resolves.toEqual({
      ok: true,
      value: { document: POLICY, revision: 7 },
    });
    expect(capture).toHaveBeenCalledWith(
      ["policy", "get", "-g", "nemoclaw", "--rev", "7", "--base", "alpha"],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("fails closed on invalid inspection metadata and revision requests (#9805)", async () => {
    const capture = vi.fn(() => result({ output: "not-json" }));
    const reader = createCliOpenShellSandboxPolicyReader({ capture });

    await expect(
      reader.inspectSandboxPolicy({
        target: selectedOpenShellGateway(),
        sandboxName: "alpha",
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: "schema",
        message: "OpenShell returned invalid sandbox policy metadata.",
      },
    });
    await expect(
      reader.readSandboxPolicyRevision({
        target: selectedOpenShellGateway(),
        sandboxName: "alpha",
        revision: 0,
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: "command",
        reason: "invalid_request",
        message: "The requested OpenShell sandbox policy revision is invalid.",
      },
    });
    expect(capture).toHaveBeenCalledOnce();
  });

  it("parses ANSI-formatted policy metadata and content (#9805)", async () => {
    const capture = vi.fn(() =>
      result({
        output: `\u001b[1mVersion:\u001b[0m 6\n\u001b[1mActive:\u001b[0m 5\n\u001b[2m---\u001b[0m\n${POLICY}`,
      }),
    );
    const reader = createCliOpenShellSandboxPolicyReader({ capture });

    const read = await reader.readSandboxPolicy({
      target: selectedOpenShellGateway(),
      sandboxName: "alpha",
      scope: "base",
    });

    expect(read).toMatchObject({
      ok: true,
      value: { document: POLICY, appliedRevision: 5 },
    });
  });

  it("accepts a versionless base document without inventing revisions (#9805)", async () => {
    const capture = vi.fn(() => result({ output: "network_policies: {}" }));
    const reader = createCliOpenShellSandboxPolicyReader({ capture });

    const read = await reader.readSandboxPolicy({
      target: selectedOpenShellGateway(),
      sandboxName: "alpha",
      scope: "base",
    });

    expect(read).toMatchObject({
      ok: true,
      value: { appliedRevision: null },
    });
  });

  it.each([
    ["empty output", ""],
    ["metadata without a document", "Version: 3\nHash: abc"],
    ["malformed YAML", "Version: 3\n---\nnetwork_policies: ["],
    ["a diagnostic mapping", "error: gateway unavailable"],
  ])("rejects %s as a policy schema failure (#9805)", async (_label, output) => {
    const reader = createCliOpenShellSandboxPolicyReader({
      capture: vi.fn(() => result({ output })),
    });

    await expect(
      reader.readSandboxPolicy({
        target: selectedOpenShellGateway(),
        sandboxName: "alpha",
        scope: "base",
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: "schema",
        message: "OpenShell returned an invalid sandbox policy document.",
      },
    });
  });

  it("does not classify policy content as an authentication failure (#9805)", async () => {
    const document =
      "version: 1\nnetwork_policies:\n  note:\n    description: unauthorized requests are denied";
    const reader = createCliOpenShellSandboxPolicyReader({
      capture: vi.fn(() => result({ output: `Version: 1\n---\n${document}` })),
    });

    const read = await reader.readSandboxPolicy({
      target: selectedOpenShellGateway(),
      sandboxName: "alpha",
      scope: "base",
    });

    expect(read).toMatchObject({ ok: true, value: { document } });
  });

  it("maps a timeout without exposing subprocess diagnostics (#9805)", async () => {
    const error = Object.assign(new Error("token=credential-value"), { code: "ETIMEDOUT" });
    const reader = createCliOpenShellSandboxPolicyReader({
      capture: vi.fn(() => result({ status: null, error, output: "credential-value" })),
    });

    const read = await reader.readSandboxPolicy({
      target: selectedOpenShellGateway(),
      sandboxName: "alpha",
      scope: "base",
    });

    expect(read).toEqual({
      ok: false,
      error: { kind: "timeout", message: "The OpenShell sandbox policy read timed out." },
    });
    expect(JSON.stringify(read)).not.toContain("credential-value");
  });

  it("maps an unavailable canonical capture boundary to the command diagnostic (#9805)", async () => {
    const capture = vi
      .spyOn(openshellRuntime, "captureResolvedOpenshell")
      .mockImplementation(() => {
        throw new Error("OpenShell is unavailable");
      });

    await expect(
      readCliOpenShellSandboxPolicy({
        target: namedOpenShellGateway("nemoclaw"),
        sandboxName: "alpha",
        scope: "base",
      }),
    ).resolves.toMatchObject({
      result: {
        ok: false,
        error: {
          kind: "command",
          reason: "failed",
        },
      },
      displayOutput: "",
    });
    expect(capture).toHaveBeenCalledWith(["policy", "get", "-g", "nemoclaw", "--base", "alpha"], {
      ignoreError: true,
      includeStderr: true,
      includeStreams: true,
      timeout: 15_000,
    });
    capture.mockRestore();
  });

  it("classifies a stdout-only failure when stderr is empty (#9805)", async () => {
    const diagnostic = "Error: unauthorized: token=credential-value";
    const reader = createCliOpenShellSandboxPolicyReader({
      capture: vi.fn(() =>
        result({ status: 1, stdout: diagnostic, stderr: "", output: diagnostic }),
      ),
    });

    const read = await reader.readSandboxPolicy({
      target: selectedOpenShellGateway(),
      sandboxName: "alpha",
      scope: "base",
    });

    expect(read).toEqual({
      ok: false,
      error: {
        kind: "authentication",
        message: "OpenShell could not authenticate the sandbox policy read.",
      },
    });
    expect(JSON.stringify(read)).not.toContain("credential-value");
  });

  it.each([
    [
      "authentication",
      "Error: unauthorized: token=credential-value",
      {
        kind: "authentication",
        message: "OpenShell could not authenticate the sandbox policy read.",
      },
    ],
    [
      "gateway identity mismatch",
      "Error: handshake verification failed: credential-value",
      {
        kind: "transport",
        reason: "identity_mismatch",
        message: "The selected OpenShell gateway identity does not match the recorded identity.",
      },
    ],
    [
      "an unreachable gateway",
      "Error: connection refused: credential-value",
      {
        kind: "transport",
        reason: "unreachable",
        message: "OpenShell could not reach the selected gateway.",
      },
    ],
    [
      "a protobuf mismatch",
      "Error: invalid wire type: credential-value",
      { kind: "schema", message: "The OpenShell CLI and gateway policy schemas do not match." },
    ],
  ] as const)("maps %s to a redacted typed failure (#9805)", async (_label, stderr, expected) => {
    const reader = createCliOpenShellSandboxPolicyReader({
      capture: vi.fn(() => result({ status: 1, stderr, output: stderr })),
    });

    const read = await reader.readSandboxPolicy({
      target: selectedOpenShellGateway(),
      sandboxName: "alpha",
      scope: "base",
    });

    expect(read).toEqual({ ok: false, error: expected });
    expect(JSON.stringify(read)).not.toContain("credential-value");
  });

  it("keeps successful raw CLI output private to the CLI compatibility read (#9805)", async () => {
    const raw = `Version: 4\nActive: 3\n---\n${POLICY}`;
    const read = createCliOpenShellSandboxPolicyRead({
      capture: vi.fn(() => result({ output: raw })),
    });

    await expect(
      read({
        target: selectedOpenShellGateway(),
        sandboxName: "alpha",
        scope: "base",
      }),
    ).resolves.toMatchObject({ result: { ok: true }, displayOutput: raw });
  });
});
