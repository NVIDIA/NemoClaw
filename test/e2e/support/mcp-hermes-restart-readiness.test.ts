// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  buildHermesManagedRuntimeReadinessScript,
  installMcpTestCaInSandbox,
} from "../live/mcp-bridge-sandbox.ts";

const TEST_CA_ENV = "NEMOCLAW_MCP_TLS_CA_CERT";
const previousTestCa = process.env[TEST_CA_ENV];
const restoreTestCa =
  previousTestCa === undefined
    ? () => Reflect.deleteProperty(process.env, TEST_CA_ENV)
    : () => {
        process.env[TEST_CA_ENV] = previousTestCa;
      };

function successfulProbe(command: string[] = []): ShellProbeResult {
  return {
    command,
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    artifacts: { stdout: "", stderr: "", result: "" },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  restoreTestCa();
});

describe("Hermes MCP CA restart readiness", () => {
  it("requires the managed same-UID helper and API health without changing the root marker", () => {
    const script = buildHermesManagedRuntimeReadinessScript();

    expect(script).toContain("/usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py' probe");
    expect(script).toContain("http://127.0.0.1:8642/health");
    expect(script).toContain("200|401");
    expect(script).not.toContain("hermes-root-lifecycle");
    expect(script).not.toMatch(/\b(?:chown|chmod|install|rm)\b/);

    const syntax = spawnSync("/bin/bash", ["-n"], { input: script, encoding: "utf8" });
    expect(syntax.status, syntax.stderr).toBe(0);
  });

  it("waits for the self-supervised Hermes runtime instead of invoking host recovery", async () => {
    process.env[TEST_CA_ENV] = "/tmp/test-mcp-ca.crt";
    const events: string[] = [];
    const hostRecover = vi.fn(async () => {
      throw new Error("host recovery must not run for the same-UID Hermes topology");
    });
    const host = {
      command: vi.fn(async () => {
        events.push("install-and-restart");
        return successfulProbe(["bash"]);
      }),
      nemoclaw: hostRecover,
    } as unknown as HostCliClient;
    const expectedReadinessScripts = ["true", buildHermesManagedRuntimeReadinessScript()];
    const readinessEvents = ["sandbox-ready", "managed-runtime-ready"];
    let readinessCall = 0;
    const sandbox = {
      execShell: vi.fn(async (_name: string, script: string) => {
        events.push(readinessEvents[readinessCall] ?? "unexpected-readiness-call");
        expect(script).toBe(expectedReadinessScripts[readinessCall]);
        readinessCall += 1;
        return successfulProbe(["openshell", "sandbox", "exec"]);
      }),
      exec: vi.fn(async (_name: string, command: string[]) => {
        events.push("managed-lifecycle-probe");
        expect(command).toEqual([
          "/usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py",
          "probe",
        ]);
        return successfulProbe(["openshell", "sandbox", "exec"]);
      }),
    } as unknown as SandboxClient;

    await installMcpTestCaInSandbox(host, sandbox, "e2e-mcp-hermes", "hermes", {
      verifyManagedAgentRuntime: true,
    });

    expect(events).toEqual([
      "install-and-restart",
      "sandbox-ready",
      "managed-runtime-ready",
      "managed-lifecycle-probe",
    ]);
    expect(hostRecover).not.toHaveBeenCalled();
  });
});
