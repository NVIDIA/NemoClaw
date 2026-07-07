// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { McpBridgeEntry } from "../../state/registry";

const mocks = vi.hoisted(() => ({
  executeSandboxCommand: vi.fn(),
}));

vi.mock("./process-recovery", () => ({
  executeSandboxCommand: mocks.executeSandboxCommand,
}));

import {
  buildCredentialResolutionProbeCommand,
  classifyCredentialResolutionProbe,
  credentialResolutionFailureWarning,
  MCP_PROBE_EXIT_MARKER,
  MCP_PROBE_HTTP_MARKER,
  probeCredentialResolution,
} from "./mcp-bridge-resolution-probe";

const baseEntry: McpBridgeEntry = {
  server: "github",
  agent: "openclaw",
  adapter: "mcporter",
  url: "https://api.githubcopilot.com/mcp/",
  env: ["GITHUB_TOKEN"],
  providerName: "alpha-mcp-github",
  providerId: "11111111-2222-4333-8444-555555555555",
  policyName: "mcp-bridge-github",
  addedAt: new Date(0).toISOString(),
};

function probeStdout(parts: { httpStatus?: number; curlExit: number; body?: string }): string {
  return [
    "",
    ...(parts.httpStatus !== undefined ? [`${MCP_PROBE_HTTP_MARKER}${parts.httpStatus}`] : []),
    `${MCP_PROBE_EXIT_MARKER}${parts.curlExit}`,
    ...(parts.body !== undefined ? [parts.body] : []),
  ].join("\n");
}

beforeEach(() => {
  mocks.executeSandboxCommand.mockReset();
});

afterEach(() => {
  delete process.env.GITHUB_TOKEN;
});

describe("MCP credential-resolution probe command", () => {
  it("wraps curl in the node runtime with the placeholder header and initialize body for mcporter (#6379)", () => {
    const command = buildCredentialResolutionProbeCommand(baseEntry, "mcporter");
    expect(command).not.toBeNull();
    expect(command).toContain("[ -f /tmp/nemoclaw-proxy-env.sh ] && . /tmp/nemoclaw-proxy-env.sh");
    expect(command).toContain("nemoclaw-start node -e");
    expect(command).toContain("'authorization: Bearer openshell:resolve:env:GITHUB_TOKEN'");
    expect(command).toContain('"method":"initialize"');
    expect(command).toContain(MCP_PROBE_HTTP_MARKER);
    expect(command).toContain(MCP_PROBE_EXIT_MARKER);
    expect(command?.trimEnd().endsWith("exit 0")).toBe(true);
  });

  it("wraps curl in the venv python runtimes for hermes-config and deepagents-config (#6379)", () => {
    const hermes = buildCredentialResolutionProbeCommand(baseEntry, "hermes-config");
    expect(hermes).toContain("/opt/hermes/.venv/bin/python -c");
    const deepagents = buildCredentialResolutionProbeCommand(baseEntry, "deepagents-config");
    expect(deepagents).toContain("/opt/venv/bin/python3 -c");
    for (const command of [hermes, deepagents]) {
      expect(command).toContain("subprocess.run(sys.argv[1:], check=False)");
      expect(command).toContain("'authorization: Bearer openshell:resolve:env:GITHUB_TOKEN'");
    }
  });

  it("returns null when the entry has no credential binding (#6379)", () => {
    expect(buildCredentialResolutionProbeCommand({ ...baseEntry, env: [] }, "mcporter")).toBeNull();
  });
});

describe("MCP credential-resolution probe classification", () => {
  it("classifies HTTP 200 as resolved on the wire (#6379)", () => {
    const probe = classifyCredentialResolutionProbe(
      { status: 0, stdout: probeStdout({ httpStatus: 200, curlExit: 0 }), stderr: "" },
      baseEntry,
    );
    expect(probe).toEqual({ ok: true, httpStatus: 200 });
  });

  it("classifies HTTP 401 and 403 as resolution failures with the status (#6379)", () => {
    for (const httpStatus of [400, 401, 403]) {
      const probe = classifyCredentialResolutionProbe(
        { status: 0, stdout: probeStdout({ httpStatus, curlExit: 0 }), stderr: "" },
        baseEntry,
      );
      expect(probe.ok).toBe(false);
      expect(probe.httpStatus).toBe(httpStatus);
    }
  });

  it("classifies HTTP 502 as indeterminate instead of blaming the credential rewrite (#6379)", () => {
    const probe = classifyCredentialResolutionProbe(
      { status: 0, stdout: probeStdout({ httpStatus: 502, curlExit: 0 }), stderr: "" },
      baseEntry,
    );
    expect(probe.ok).toBeNull();
    expect(probe.httpStatus).toBe(502);
    expect(probe.detail).toContain("could not be judged");
  });

  it("classifies a CONNECT-level proxy 403 as an indeterminate policy denial (#6379)", () => {
    const probe = classifyCredentialResolutionProbe(
      {
        status: 0,
        stdout: probeStdout({ curlExit: 56 }),
        stderr: "curl: (56) CONNECT tunnel failed, response 403",
      },
      baseEntry,
    );
    expect(probe.ok).toBeNull();
    expect(probe.detail).toContain("CONNECT 403");
  });

  it("classifies curl exit 28 as an indeterminate probe timeout (#6379)", () => {
    const probe = classifyCredentialResolutionProbe(
      { status: 0, stdout: probeStdout({ curlExit: 28 }), stderr: "" },
      baseEntry,
    );
    expect(probe.ok).toBeNull();
    expect(probe.detail).toContain("timed out");
  });

  it("classifies a missing command result as sandbox unreachable (#6379)", () => {
    expect(classifyCredentialResolutionProbe(null, baseEntry)).toEqual({
      ok: null,
      detail: "sandbox unreachable",
    });
  });

  it("redacts credential material from the failure detail excerpt (#6379)", () => {
    process.env.GITHUB_TOKEN = "ghp_super-secret-value-1234567890";
    const body = `{"error":"bad token ghp_super-secret-value-1234567890"}`;
    const probe = classifyCredentialResolutionProbe(
      { status: 0, stdout: probeStdout({ httpStatus: 401, curlExit: 0, body }), stderr: "" },
      baseEntry,
    );
    expect(probe.ok).toBe(false);
    expect(probe.detail).not.toContain("ghp_super-secret-value-1234567890");
    expect(probe.detail).toContain("***REDACTED***");
  });
});

describe("MCP credential-resolution probe execution gates", () => {
  it("skips without contacting the sandbox when the adapter is not declared (#6379)", () => {
    const probe = probeCredentialResolution("alpha", baseEntry, undefined);
    expect(probe).toEqual({ ok: null, detail: "MCP adapter is not declared" });
    expect(mocks.executeSandboxCommand).not.toHaveBeenCalled();
  });

  it("skips without contacting the sandbox while an add transaction is incomplete (#6379)", () => {
    const probe = probeCredentialResolution(
      "alpha",
      { ...baseEntry, addState: "preflighted" },
      "mcporter",
    );
    expect(probe).toEqual({ ok: null, detail: "add transaction incomplete" });
    expect(mocks.executeSandboxCommand).not.toHaveBeenCalled();
  });

  it("skips without contacting the sandbox when no credential binding exists (#6379)", () => {
    const probe = probeCredentialResolution("alpha", { ...baseEntry, env: [] }, "mcporter");
    expect(probe).toEqual({ ok: null, detail: "no credential binding to probe" });
    expect(mocks.executeSandboxCommand).not.toHaveBeenCalled();
  });

  it("executes the probe in the sandbox and classifies the outcome (#6379)", () => {
    mocks.executeSandboxCommand.mockReturnValue({
      status: 0,
      stdout: probeStdout({ httpStatus: 200, curlExit: 0 }),
      stderr: "",
    });
    const probe = probeCredentialResolution("alpha", baseEntry, "mcporter");
    expect(probe).toEqual({ ok: true, httpStatus: 200 });
    expect(mocks.executeSandboxCommand).toHaveBeenCalledTimes(1);
    const [, command] = mocks.executeSandboxCommand.mock.calls[0];
    expect(command).toContain("openshell:resolve:env:GITHUB_TOKEN");
  });
});

describe("MCP credential-resolution failure warning", () => {
  it("names the placeholder, the probe verdict, and the OpenShell host remediation (#6379)", () => {
    const warning = credentialResolutionFailureWarning("GITHUB_TOKEN", 403);
    expect(warning).toContain("openshell:resolve:env:GITHUB_TOKEN");
    expect(warning).toContain("HTTP 403");
    expect(warning).toContain("OpenShell issue 2161");
  });
});
