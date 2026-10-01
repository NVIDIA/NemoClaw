// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  createCliOpenShellDebugDiagnostics,
  type CliOpenShellDebugDiagnosticsDeps,
} from "./debug-diagnostics-cli";
import type { OpenShellBufferedCommandRunner } from "./sandbox-command-cli";

const namedRequest = {
  target: { kind: "named", gatewayName: "owned" } as const,
  sandboxName: "alpha",
  quick: false,
  timeoutMs: 30_000,
};

function createDiagnostics(deps: Omit<CliOpenShellDebugDiagnosticsDeps, "redact"> = {}) {
  return createCliOpenShellDebugDiagnostics({
    ...deps,
    redact: (value) => value.replaceAll(/fixture-secret|password/gu, "<REDACTED>"),
  });
}

describe("CLI OpenShell debug diagnostics (#11832)", () => {
  it("collects the fixed named-gateway artifacts with bounded output", async () => {
    const runBuffered = vi.fn<OpenShellBufferedCommandRunner>(async () => ({
      status: 0,
      stdout: "fixture output",
      stderr: "",
    }));
    const diagnostics = createDiagnostics({
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
      resolveBinary: () => "/fixture/bin/openshell",
      runBuffered,
    });

    const artifacts = await diagnostics.collect(namedRequest);

    expect(artifacts.map((artifact) => artifact.name)).toEqual([
      "openshell-status",
      "openshell-sandbox-list",
      "openshell-sandbox-get",
      "openshell-logs",
      "openshell-gateway-info",
    ]);
    expect(runBuffered.mock.calls.map((call) => call[1])).toEqual([
      ["status", "-g", "owned"],
      ["sandbox", "list", "-g", "owned"],
      ["sandbox", "get", "-g", "owned", "alpha"],
      ["logs", "-g", "owned", "alpha"],
      ["gateway", "info", "-g", "owned"],
    ]);
    expect(runBuffered.mock.calls[0]?.[2]).toEqual({
      environment: {
        HOME: "/fixture/home",
        PATH: "/fixture/bin",
        OPENSHELL_GATEWAY: "fixture-gateway",
        OPENSHELL_LOCAL_TLS_DIR: "/fixture/tls",
        OPENSHELL_WORKSPACE: "/fixture/workspace",
      },
      hostCwd: "/fixture/repo",
      outputLimitBytes: 1024 * 1024,
      timeoutKillSignal: "SIGKILL",
      timeoutMilliseconds: 30_000,
    });
    expect(JSON.stringify(runBuffered.mock.calls)).not.toContain("nvapi-fixture-secret");
  });

  it("omits gateway info in quick mode and supports selected-gateway arguments", async () => {
    const runBuffered = vi.fn<OpenShellBufferedCommandRunner>(async () => ({
      status: 0,
      stdout: "",
      stderr: "",
    }));
    const diagnostics = createDiagnostics({
      resolveBinary: () => "/fixture/openshell",
      runBuffered,
    });

    const artifacts = await diagnostics.collect({
      ...namedRequest,
      target: { kind: "selected" },
      quick: true,
    });

    expect(artifacts).toHaveLength(4);
    expect(runBuffered.mock.calls.map((call) => call[1])).toEqual([
      ["status"],
      ["sandbox", "list"],
      ["sandbox", "get", "alpha"],
      ["logs", "alpha"],
    ]);
  });

  it("rejects invalid targets and endpoint overrides before execution", async () => {
    const runBuffered = vi.fn<OpenShellBufferedCommandRunner>();
    const invalidName = createDiagnostics({
      resolveBinary: () => "/fixture/openshell",
      runBuffered,
    });
    const endpointOverride = createDiagnostics({
      environment: { OPENSHELL_GATEWAY_ENDPOINT: "https://user:fixture-secret@example.test" },
      resolveBinary: () => "/fixture/openshell",
      runBuffered,
    });

    const invalid = await invalidName.collect({ ...namedRequest, sandboxName: "bad\nname" });
    const overridden = await endpointOverride.collect(namedRequest);

    expect(invalid[0]?.outcome).toMatchObject({
      kind: "failed",
      error: { kind: "configuration" },
    });
    expect(overridden[0]?.outcome).toMatchObject({
      kind: "failed",
      error: { kind: "configuration" },
    });
    expect(JSON.stringify(overridden)).not.toContain("fixture-secret");
    expect(runBuffered).not.toHaveBeenCalled();
  });

  it("returns typed unavailable, timeout, and capture failures", async () => {
    const unavailable = createDiagnostics({ resolveBinary: () => null });
    const timeout = createDiagnostics({
      resolveBinary: () => "/fixture/openshell",
      runBuffered: async () => ({ status: null, stdout: "partial", stderr: "", timedOut: true }),
    });
    const capture = createDiagnostics({
      resolveBinary: () => "/fixture/openshell",
      runBuffered: async () => ({
        status: null,
        stdout: "",
        stderr: "",
        error: Object.assign(new Error("too much output"), {
          code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        }),
      }),
    });

    expect((await unavailable.collect(namedRequest))[0]?.outcome).toMatchObject({
      kind: "failed",
      error: { kind: "unavailable" },
    });
    expect((await timeout.collect(namedRequest))[0]?.outcome).toMatchObject({
      kind: "failed",
      error: { kind: "timeout" },
    });
    expect((await capture.collect(namedRequest))[0]?.outcome).toMatchObject({
      kind: "failed",
      error: { kind: "capture" },
    });
  });

  it("redacts output before returning an artifact", async () => {
    const diagnostics = createDiagnostics({
      resolveBinary: () => "/fixture/openshell",
      runBuffered: async () => ({
        status: 1,
        stdout: "API_TOKEN=fixture-secret",
        stderr: "proxy https://user:password@example.test",
      }),
    });

    const artifacts = await diagnostics.collect({ ...namedRequest, quick: true });

    expect(artifacts[0]).toMatchObject({ outcome: { kind: "completed", exitCode: 1 } });
    expect(JSON.stringify(artifacts)).not.toContain("fixture-secret");
    expect(JSON.stringify(artifacts)).not.toContain("password");
  });
});
