// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  createCliOpenShellLegacyPodReadinessProbe,
  createCliOpenShellSandboxLookup,
  createCliOpenShellSandboxObserver as createObserver,
  createCliOpenShellSandboxObserverFromRunner,
  type CapturedSandboxCommandResult,
  type CliOpenShellSandboxObserverDeps,
  parseCliOpenShellSandboxInventory,
} from "./sandbox-observer-cli";
import { namedOpenShellGateway, selectedOpenShellGateway } from "./sandbox-observer";

function createCliOpenShellSandboxObserver(
  deps: Omit<CliOpenShellSandboxObserverDeps, "defaultTimeoutMs">,
) {
  return createObserver({ ...deps, defaultTimeoutMs: 15_000 });
}

function captured(
  status: number | null,
  stdout = "",
  stderr = "",
  error?: Error,
): CapturedSandboxCommandResult {
  return {
    status,
    output: `${stdout}${stderr}`.trim(),
    stdout,
    stderr,
    ...(error ? { error } : {}),
  };
}

describe("CLI OpenShell sandbox observer", () => {
  it("targets a named gateway and returns typed list observations (#9803)", async () => {
    const capture = vi.fn(() =>
      captured(
        0,
        [
          "NAME CREATED PHASE",
          "alpha 2m Ready",
          "beta 1m Provisioning",
          "gamma 30s CrashLoopBackOff",
        ].join("\n"),
      ),
    );
    const observer = createCliOpenShellSandboxObserver({ capture });

    const result = await observer.listSandboxes({
      target: namedOpenShellGateway("nemoclaw-18080"),
      timeoutMs: 4_321,
    });

    expect(capture).toHaveBeenCalledWith(["sandbox", "list", "-g", "nemoclaw-18080"], {
      ignoreError: true,
      includeStderr: true,
      includeStreams: true,
      timeout: 4_321,
    });
    expect(result).toEqual({
      ok: true,
      value: {
        sandboxes: [
          { name: "alpha", phase: "Ready", readiness: "ready" },
          { name: "beta", phase: "Provisioning", readiness: "not_ready" },
          { name: "gamma", phase: "CrashLoopBackOff", readiness: "terminal" },
        ],
      },
    });
  });

  it("contains table and ANSI compatibility inside the CLI implementation (#9803)", () => {
    expect(
      parseCliOpenShellSandboxInventory(
        "\u001b[1mNAME\u001b[0m CREATED PHASE\n" +
          "\u001b[1malpha\u001b[0m 2m \u001b[32mReady\u001b[0m\n" +
          "beta Ready NotReady 1m ago\n" +
          "gamma unknown 1m ago\n" +
          "delta Ready 2026-03-24 10:00:00 Provisioning\n" +
          "epsilon 1m Running\n" +
          "Error: command failed\n" +
          "No sandboxes found.",
      ),
    ).toEqual({
      sandboxes: [
        { name: "alpha", phase: "Ready", readiness: "ready" },
        { name: "beta", phase: "NotReady", readiness: "not_ready" },
        { name: "gamma", phase: "Unknown", readiness: "terminal" },
        { name: "delta", phase: "Provisioning", readiness: "not_ready" },
        { name: "epsilon", phase: "Running", readiness: "ready" },
      ],
    });
  });

  it("parses the captured DGX Spark readiness sequence inside the CLI implementation (#9803)", () => {
    const rows = [
      "my-sandbox   Provisioning   2s ago",
      "my-sandbox   Error          6s ago",
      "my-sandbox   Error          8s ago",
      "my-sandbox   Error          10s ago",
      "my-sandbox   Ready          14s ago",
    ];

    expect(rows.map((row) => parseCliOpenShellSandboxInventory(row).sandboxes[0]?.phase)).toEqual([
      "Provisioning",
      "Error",
      "Error",
      "Error",
      "Ready",
    ]);
  });

  it("parses successful list output from stdout without treating stderr as inventory (#9803)", async () => {
    const observer = createCliOpenShellSandboxObserver({
      capture: () => captured(0, "alpha Ready", "warning text"),
    });

    await expect(observer.listSandboxes({ target: selectedOpenShellGateway() })).resolves.toEqual({
      ok: true,
      value: {
        sandboxes: [{ name: "alpha", phase: "Ready", readiness: "ready" }],
      },
    });
  });

  it("keeps formatted get output on an explicit CLI-only compatibility path (#9803)", async () => {
    const capture = vi.fn(() => captured(0, "\u001b[1mName:\u001b[0m alpha\nPhase: Running\n"));
    const lookup = createCliOpenShellSandboxLookup({ capture });

    const result = await lookup({
      sandboxName: "alpha",
      target: namedOpenShellGateway("nemoclaw"),
      timeoutMs: 1_000,
    });

    expect(capture).toHaveBeenCalledWith(["sandbox", "get", "-g", "nemoclaw", "alpha"], {
      ignoreError: true,
      includeStderr: true,
      includeStreams: true,
      timeout: 1_000,
    });
    expect(result).toEqual({
      result: {
        ok: true,
        value: {
          state: "present",
          sandbox: { name: "alpha", phase: "Running", readiness: "ready" },
        },
      },
      displayOutput: "Name: alpha\nPhase: Running",
    });
  });

  it("canonicalizes lookup phase tokens case-insensitively (#9803)", async () => {
    const lookup = createCliOpenShellSandboxLookup({
      capture: () => captured(0, "Name: alpha\nPhase: ready\n"),
    });

    await expect(
      lookup({ sandboxName: "alpha", target: selectedOpenShellGateway() }),
    ).resolves.toEqual({
      result: {
        ok: true,
        value: {
          state: "present",
          sandbox: { name: "alpha", phase: "Ready", readiness: "ready" },
        },
      },
      displayOutput: "Name: alpha\nPhase: ready",
    });
  });

  it("keeps a missing sandbox distinct from authentication failure (#9803)", async () => {
    const capture = vi
      .fn()
      .mockReturnValueOnce(captured(1, "", "sandbox has no spec: NotFound"))
      .mockReturnValueOnce(
        captured(1, "", "Error: authentication failed: sandbox not found: bearer value"),
      );
    const lookup = createCliOpenShellSandboxLookup({ capture });
    const request = { sandboxName: "alpha", target: selectedOpenShellGateway() };

    await expect(lookup(request)).resolves.toEqual({
      result: { ok: true, value: { state: "missing" } },
      displayOutput: "",
    });
    await expect(lookup(request)).resolves.toEqual({
      result: {
        ok: false,
        error: {
          kind: "authentication",
          message: "OpenShell could not authenticate the sandbox observation.",
        },
      },
      displayOutput: "",
    });
  });

  it.each([
    ["transport", "unreachable", captured(1, "", "client error (Connect): Connection refused")],
    ["transport", "unreachable", captured(1, "", "Status: Disconnected")],
    ["transport", "unreachable", captured(1, "", "Unknown gateway 'nemoclaw'.")],
    ["transport", "identity_mismatch", captured(1, "", "handshake verification failed")],
    ["schema", undefined, captured(1, "", "protobuf decode error: invalid wire type")],
    ["command", "failed", captured(7, "", "unexpected opaque failure")],
    ["command", "invalid_request", captured(2, "", "unknown option")],
  ] as const)(
    "maps %s failures without retaining CLI diagnostics (#9803)",
    async (kind, reason, value) => {
      const observer = createCliOpenShellSandboxObserver({ capture: () => value });

      const result = await observer.listSandboxes({ target: selectedOpenShellGateway() });

      expect(result.ok).toBe(false);
      const mapped = result as Extract<typeof result, { ok: false }>;
      expect(mapped.error.kind).toBe(kind);
      expect(mapped.error).toMatchObject(reason ? { reason } : {});
      expect(mapped.error.message).not.toContain(value.stderr);
    },
  );

  it("maps a subprocess timeout without retaining its command text (#9803)", async () => {
    const timeout = new Error(
      "spawn openshell sandbox list token-value timed out",
    ) as NodeJS.ErrnoException;
    timeout.code = "ETIMEDOUT";
    const observer = createCliOpenShellSandboxObserver({
      capture: () => captured(null, "", "credential-bearing detail", timeout),
    });

    await expect(
      observer.listSandboxes({ target: selectedOpenShellGateway(), timeoutMs: 25 }),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "timeout", message: "OpenShell sandbox observation timed out." },
    });
  });

  it("normalizes a structured runner without exposing runner output to consumers (#9803)", async () => {
    const run = vi.fn(() => ({
      status: 0,
      stdout: Buffer.from("alpha Ready"),
      stderr: Buffer.from("warning text"),
    }));
    const observer = createCliOpenShellSandboxObserverFromRunner(run, 9_000);

    await expect(
      observer.listSandboxes({ target: namedOpenShellGateway("nemoclaw") }),
    ).resolves.toEqual({
      ok: true,
      value: {
        sandboxes: [{ name: "alpha", phase: "Ready", readiness: "ready" }],
      },
    });
    expect(run).toHaveBeenCalledWith(["sandbox", "list", "-g", "nemoclaw"], {
      ignoreError: true,
      suppressOutput: true,
      timeout: 9_000,
    });
  });

  it("keeps the legacy Kubernetes readiness command and phase parsing in the CLI implementation (#9803)", async () => {
    const capture = vi.fn(() => captured(0, "Running"));
    const probe = createCliOpenShellLegacyPodReadinessProbe({
      capture,
      defaultTimeoutMs: 7_000,
    });

    await expect(
      probe({
        target: namedOpenShellGateway("nemoclaw"),
        sandboxName: "alpha",
      }),
    ).resolves.toEqual({ ok: true, value: "ready" });
    expect(capture).toHaveBeenCalledWith(
      [
        "doctor",
        "exec",
        "-g",
        "nemoclaw",
        "--",
        "kubectl",
        "-n",
        "openshell",
        "get",
        "pod",
        "alpha",
        "-o",
        "jsonpath={.status.phase}",
      ],
      {
        ignoreError: true,
        includeStderr: true,
        includeStreams: true,
        timeout: 7_000,
      },
    );
  });

  it("keeps the legacy Kubernetes readiness command unscoped for the selected gateway (#9803)", async () => {
    const capture = vi.fn(() => captured(0, "Running"));
    const probe = createCliOpenShellLegacyPodReadinessProbe({ capture });

    await expect(
      probe({ target: selectedOpenShellGateway(), sandboxName: "alpha" }),
    ).resolves.toEqual({ ok: true, value: "ready" });
    expect(capture).toHaveBeenCalledWith(
      [
        "doctor",
        "exec",
        "--",
        "kubectl",
        "-n",
        "openshell",
        "get",
        "pod",
        "alpha",
        "-o",
        "jsonpath={.status.phase}",
      ],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("returns a typed legacy Kubernetes observation failure (#9803)", async () => {
    const probe = createCliOpenShellLegacyPodReadinessProbe({
      capture: () => captured(1, "", "authentication failed"),
    });

    await expect(
      probe({ target: selectedOpenShellGateway(), sandboxName: "alpha" }),
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: "authentication",
        message: "OpenShell could not authenticate the sandbox observation.",
      },
    });
  });
});
