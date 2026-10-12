// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  createCliOpenShellGpuDiagnostics,
  type CliOpenShellGpuDiagnosticsDeps,
} from "./gpu-diagnostics-cli";

const namedRequest = {
  target: { kind: "named", gatewayName: "owned" } as const,
  sandboxName: "alpha",
  timeoutMs: 30_000,
  redact: (value: string) => value.replaceAll(/fixture-secret|password/gu, "<REDACTED>"),
};

function success(overrides: Record<string, unknown> = {}) {
  return {
    error: undefined,
    signal: null,
    status: 0,
    stderr: "",
    stdout: "evidence",
    ...overrides,
  };
}

function createDiagnostics(deps: CliOpenShellGpuDiagnosticsDeps = {}) {
  return createCliOpenShellGpuDiagnostics({
    resolveBinary: () => "/fixture/bin/openshell",
    ...deps,
  });
}

describe("CLI OpenShell Docker GPU diagnostics (#11832)", () => {
  it("collects the fixed named-gateway artifacts with bounded output and a filtered environment", () => {
    const capture = vi.fn<NonNullable<CliOpenShellGpuDiagnosticsDeps["capture"]>>(() => success());
    const diagnostics = createDiagnostics({
      capture,
      environment: {
        HOME: "/fixture/home",
        PATH: "/fixture/bin",
        OPENSHELL_GATEWAY: "fixture-gateway",
        OPENSHELL_LOCAL_TLS_DIR: "/fixture/tls",
        OPENSHELL_WORKSPACE: "/fixture/workspace",
        OPENSHELL_UNSUPPORTED: "must-not-leak",
        NVIDIA_INFERENCE_API_KEY: "nvapi-fixture-secret",
      },
      hostCwd: "/fixture/repo",
    });

    const artifacts = diagnostics.collect(namedRequest);

    expect(artifacts.map((artifact) => artifact.name)).toEqual([
      "openshell-sandbox-get.txt",
      "openshell-sandbox-list.txt",
      "openshell-logs.txt",
    ]);
    expect(capture.mock.calls.map((call) => call[1])).toEqual([
      ["sandbox", "get", "-g", "owned", "alpha"],
      ["sandbox", "list", "-g", "owned"],
      ["doctor", "logs", "-g", "owned", "--name", "nemoclaw"],
    ]);
    expect(capture.mock.calls[0]?.[2]).toEqual({
      cwd: "/fixture/repo",
      encoding: "utf8",
      env: {
        HOME: "/fixture/home",
        PATH: "/fixture/bin",
        OPENSHELL_GATEWAY: "fixture-gateway",
        OPENSHELL_LOCAL_TLS_DIR: "/fixture/tls",
        OPENSHELL_WORKSPACE: "/fixture/workspace",
      },
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    expect(capture.mock.calls.map((call) => call[2].timeout)).toEqual([30_000, 30_000, 30_000]);
    expect(JSON.stringify(capture.mock.calls)).not.toContain("nvapi-fixture-secret");
  });

  it("preserves the selected-gateway command shape", () => {
    const capture = vi.fn<NonNullable<CliOpenShellGpuDiagnosticsDeps["capture"]>>(() => success());
    const diagnostics = createDiagnostics({ capture });

    diagnostics.collect({ ...namedRequest, target: { kind: "selected" } });

    expect(capture.mock.calls.map((call) => call[1])).toEqual([
      ["sandbox", "get", "alpha"],
      ["sandbox", "list"],
      ["doctor", "logs", "--name", "nemoclaw"],
    ]);
  });

  it("rejects invalid requests and endpoint overrides before execution", () => {
    const capture = vi.fn();
    const diagnostics = createDiagnostics({ capture });
    const overridden = createDiagnostics({
      capture,
      environment: { OPENSHELL_GATEWAY_ENDPOINT: "https://user:fixture-secret@example.test" },
    });

    const invalidName = diagnostics.collect({ ...namedRequest, sandboxName: "bad\nname" });
    const invalidTimeout = diagnostics.collect({ ...namedRequest, timeoutMs: 0 });
    const endpointOverride = overridden.collect(namedRequest);

    expect(
      [invalidName, invalidTimeout, endpointOverride].map((artifacts) => artifacts[0]?.outcome),
    ).toEqual([
      { kind: "failed", error: expect.objectContaining({ kind: "configuration" }) },
      { kind: "failed", error: expect.objectContaining({ kind: "configuration" }) },
      { kind: "failed", error: expect.objectContaining({ kind: "configuration" }) },
    ]);
    expect(JSON.stringify(endpointOverride)).not.toContain("fixture-secret");
    expect(capture).not.toHaveBeenCalled();
  });

  it.each([
    ["unavailable", Object.assign(new Error("missing"), { code: "ENOENT" })],
    ["timeout", Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })],
    ["capture", Object.assign(new Error("too much output"), { code: "ENOBUFS" })],
    ["invocation", Object.assign(new Error("permission denied"), { code: "EACCES" })],
  ] as const)("maps a %s failure without suppressing later artifacts", (kind, error) => {
    const capture = vi.fn(() => success({ error, status: null }));
    const artifacts = createDiagnostics({ capture }).collect(namedRequest);

    expect(artifacts).toHaveLength(3);
    expect(artifacts.every((artifact) => artifact.outcome.kind === "failed")).toBe(true);
    expect(artifacts.every((artifact) => artifact.content === "")).toBe(true);
    expect(artifacts[0]?.outcome).toMatchObject({ kind: "failed", error: { kind } });
    expect(capture).toHaveBeenCalledTimes(3);
  });

  it("returns typed unavailable failures without starting a process", () => {
    const capture = vi.fn();
    const artifacts = createCliOpenShellGpuDiagnostics({
      capture,
      resolveBinary: () => null,
    }).collect(namedRequest);

    expect(artifacts[0]?.outcome).toMatchObject({
      kind: "failed",
      error: { kind: "unavailable" },
    });
    expect(capture).not.toHaveBeenCalled();
  });

  it("omits partial output from process errors while redacting their typed messages", () => {
    const error = Object.assign(new Error("TOKEN=fixture-secret"), { code: "EACCES" });
    const artifacts = createDiagnostics({
      capture: () =>
        success({
          error,
          status: null,
          stdout: "API_TOKEN=fixture-secret\n",
          stderr: "proxy https://user:password@example.test",
        }),
    }).collect(namedRequest);

    expect(JSON.stringify(artifacts)).not.toContain("fixture-secret");
    expect(JSON.stringify(artifacts)).not.toContain("password");
    expect(artifacts.every((artifact) => artifact.content === "")).toBe(true);
  });

  it("writes trimmed stdout only for status zero and omits stderr", () => {
    const artifacts = createDiagnostics({
      capture: () =>
        success({
          stdout: "  API_TOKEN=fixture-secret\n",
          stderr: "proxy https://user:password@example.test",
        }),
    }).collect(namedRequest);

    expect(artifacts[0]).toEqual({
      name: "openshell-sandbox-get.txt",
      content: "API_TOKEN=<REDACTED>",
      outcome: { kind: "completed", exitCode: 0 },
    });
    expect(JSON.stringify(artifacts)).not.toContain("password");
  });

  it("omits partial stdout and stderr when a command exits nonzero", () => {
    const artifacts = createDiagnostics({
      capture: () =>
        success({
          status: 7,
          stdout: "partial stdout",
          stderr: "partial stderr",
        }),
    }).collect(namedRequest);

    expect(artifacts.every((artifact) => artifact.content === "")).toBe(true);
    expect(artifacts[0]?.outcome).toEqual({
      kind: "failed",
      error: { kind: "invocation", message: "OpenShell GPU diagnostic exited with code 7" },
    });
    expect(JSON.stringify(artifacts)).not.toContain("partial");
  });

  it("clamps later commands to the shared deadline and skips work after it expires", () => {
    const capture = vi.fn<NonNullable<CliOpenShellGpuDiagnosticsDeps["capture"]>>(() => success());
    const now = vi.fn().mockReturnValueOnce(500).mockReturnValueOnce(1_200).mockReturnValue(1_500);
    const artifacts = createDiagnostics({ capture, now }).collect({
      ...namedRequest,
      timeoutMs: 1_000,
      deadlineMs: 1_500,
    });

    expect(capture.mock.calls.map((call) => call[2].timeout)).toEqual([1_000, 300]);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(artifacts[2]).toEqual({
      name: "openshell-logs.txt",
      content: "",
      outcome: {
        kind: "failed",
        error: { kind: "timeout", message: "OpenShell GPU diagnostic deadline expired" },
      },
    });
  });
});
