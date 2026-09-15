// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { namedOpenShellGateway, selectedOpenShellGateway } from "./sandbox-observer";
import type { CapturedOpenShellCommandResult } from "./sandbox-observer-cli";
import {
  classifyCliOpenShellSandboxPolicySetResult,
  createCliOpenShellSandboxPolicyReader,
  createCliOpenShellSandboxPolicyWriter,
} from "./sandbox-policy-cli";

const POLICY = "version: 1\nnetwork_policies: {}";

function captured(overrides: Partial<CapturedOpenShellCommandResult> = {}) {
  return { status: 0, output: `Version: 4\nActive: 3\n---\n${POLICY}`, ...overrides };
}

describe("CLI OpenShell sandbox policy reader", () => {
  it("maps base reads to the recorded gateway", async () => {
    const capture = vi.fn(() => captured());
    const reader = createCliOpenShellSandboxPolicyReader({ capture });

    expect(
      await reader.readSandboxPolicy({
        target: namedOpenShellGateway("nemoclaw"),
        sandboxName: "alpha",
        scope: "base",
      }),
    ).toEqual({
      ok: true,
      value: {
        document: POLICY,
        appliedRevision: 3,
        metadata: [
          { field: "Version", value: "4" },
          { field: "Active", value: "3" },
        ],
      },
    });
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
      expect.objectContaining({ outputLimitBytes: 1024 * 1024, timeout: 15_000 }),
    );
  });
});

describe("CLI OpenShell sandbox policy writer", () => {
  it("maps a successful write to exact gateway-pinned arguments", async () => {
    const capture = vi.fn(() => captured({ output: "" }));
    const writer = createCliOpenShellSandboxPolicyWriter({ capture });

    expect(
      await writer.setSandboxPolicy({
        target: namedOpenShellGateway("nemoclaw"),
        sandboxName: "my-dev-assistant-v2",
        document: POLICY,
      }),
    ).toEqual({ outcome: { kind: "applied" }, status: 0 });
    expect(capture).toHaveBeenCalledWith(
      [
        "policy",
        "set",
        "-g",
        "nemoclaw",
        "--policy",
        expect.any(String),
        "--wait",
        "my-dev-assistant-v2",
      ],
      expect.objectContaining({ ignoreError: true, timeout: 15_000 }),
    );
  });

  it("rejects malformed documents before creating submission material or capturing", async () => {
    const capture = vi.fn();
    const makeDirectory = vi.spyOn(fs, "mkdtempSync");
    try {
      const result = await createCliOpenShellSandboxPolicyWriter({ capture }).setSandboxPolicy({
        target: selectedOpenShellGateway(),
        sandboxName: "alpha",
        document: "network_policies: [",
      });
      expect(result).toEqual({
        status: 1,
        outcome: { kind: "rejected", status: 1, message: "Invalid sandbox policy document." },
      });
      expect(capture).not.toHaveBeenCalled();
      expect(makeDirectory).not.toHaveBeenCalled();
    } finally {
      makeDirectory.mockRestore();
    }
  });

  it("retains private submission material until capture finishes on success", async () => {
    let settle!: () => void;
    let policyPath = "";
    const capture = vi.fn(async (args: string[]) => {
      policyPath = args[args.indexOf("--policy") + 1]!;
      await new Promise<void>((resolve) => {
        settle = resolve;
      });
      expect(fs.readFileSync(policyPath, "utf8")).toBe(POLICY);
      return captured({ output: "" });
    });
    const pending = createCliOpenShellSandboxPolicyWriter({ capture }).setSandboxPolicy({
      target: selectedOpenShellGateway(),
      sandboxName: "alpha",
      document: POLICY,
    });
    expect(fs.statSync(policyPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(policyPath)).mode & 0o777).toBe(0o700);
    settle();
    await expect(pending).resolves.toEqual({ outcome: { kind: "applied" }, status: 0 });
    expect(fs.existsSync(path.dirname(policyPath))).toBe(false);
  });

  it("retains private submission material until capture finishes on capture failure", async () => {
    let settle!: () => void;
    let policyPath = "";
    const capture = vi.fn(async (args: string[]) => {
      policyPath = args[args.indexOf("--policy") + 1]!;
      await new Promise<void>((resolve) => {
        settle = resolve;
      });
      expect(fs.readFileSync(policyPath, "utf8")).toBe(POLICY);
      throw new Error("capture failed");
    });
    const pending = createCliOpenShellSandboxPolicyWriter({ capture }).setSandboxPolicy({
      target: selectedOpenShellGateway(),
      sandboxName: "alpha",
      document: POLICY,
    });
    expect(fs.statSync(policyPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(policyPath)).mode & 0o777).toBe(0o700);
    settle();
    await expect(pending).rejects.toThrow("capture failed");
    expect(fs.existsSync(path.dirname(policyPath))).toBe(false);
  });

  it("classifies an authoritative policy refusal without exposing it as a transport error", async () => {
    const stderr =
      "Error: code: 'Failed precondition', message: 'network policy rejected', " +
      "source: tonic::Status { code: FailedPrecondition, grpc_status: 9 }";
    const capture = vi.fn((_args: string[]) => captured({ status: 1, output: "", stderr }));
    const writer = createCliOpenShellSandboxPolicyWriter({
      capture,
    });

    expect(
      await writer.setSandboxPolicy({
        target: selectedOpenShellGateway(),
        sandboxName: "alpha",
        document: POLICY,
      }),
    ).toEqual({
      status: 1,
      outcome: { kind: "rejected", status: 1, message: "network policy rejected" },
    });
    expect(capture.mock.calls[0]?.[0]).toEqual([
      "policy",
      "set",
      "--policy",
      expect.any(String),
      "--wait",
      "alpha",
    ]);
  });

  it("rejects an invalid sandbox name before invoking OpenShell", async () => {
    const capture = vi.fn(() => captured({ output: "" }));
    const writer = createCliOpenShellSandboxPolicyWriter({ capture });

    await expect(
      (async () =>
        await writer.setSandboxPolicy({
          target: selectedOpenShellGateway(),
          sandboxName: "alpha; whoami",
          document: POLICY,
        }))(),
    ).rejects.toThrow("Invalid OpenShell sandbox name");
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

it("reports retained policy material and preserves a simultaneous capture failure", async () => {
  const captureFailure = new Error("capture failed");
  let directory = "";
  const capture = vi.fn(async (args: string[]) => {
    directory = path.dirname(args[args.indexOf("--policy") + 1]!);
    throw captureFailure;
  });
  const remove = vi.spyOn(fs, "rmSync").mockImplementation(() => {
    throw Object.assign(new Error("removal failed"), { code: "EACCES" });
  });
  try {
    await expect(
      createCliOpenShellSandboxPolicyWriter({ capture }).setSandboxPolicy({
        target: selectedOpenShellGateway(),
        sandboxName: "alpha",
        document: POLICY,
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("Could not remove the temporary policy directory"),
      cause: captureFailure,
    });
    expect(fs.existsSync(path.join(directory, "policy.yaml"))).toBe(true);
  } finally {
    remove.mockRestore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("does not report success when submitted policy material cannot be removed", async () => {
  let directory = "";
  const capture = vi.fn(async (args: string[]) => {
    directory = path.dirname(args[args.indexOf("--policy") + 1]!);
    return captured({ output: "" });
  });
  const remove = vi.spyOn(fs, "rmSync").mockImplementation(() => {
    throw Object.assign(new Error("removal failed"), { code: "EACCES" });
  });
  try {
    await expect(
      createCliOpenShellSandboxPolicyWriter({ capture }).setSandboxPolicy({
        target: selectedOpenShellGateway(),
        sandboxName: "alpha",
        document: POLICY,
      }),
    ).rejects.toThrow("It still holds the composed sandbox policy; remove it before retrying.");
    expect(fs.existsSync(path.join(directory, "policy.yaml"))).toBe(true);
  } finally {
    remove.mockRestore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
