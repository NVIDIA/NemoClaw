// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { AgentMcpAdapter } from "../../agent/defs";
import type { McpBridgeEntry } from "../../state/registry";
import {
  buildMcpToolDiscoveryCommand,
  classifyMcpToolDiscoveryResult,
  MCP_TOOL_DISCOVERY_RUNTIME_PATH,
  toolDiscoveryReadinessSkipDetail,
} from "./mcp-bridge-tool-discovery";
import { MCP_RUNTIME_SANITIZED_ENV_VARS } from "./mcp-bridge-runtime-command";

const marker = "__NEMOCLAW_SANDBOX_EXEC_STARTED___0123456789abcdef0123456789abcdef";
const entry = {
  server: "github",
  url: "https://api.githubcopilot.com/mcp/",
  env: ["GITHUB_TOKEN"],
} as McpBridgeEntry;
const unauthenticatedEntry = { ...entry, env: [] } as McpBridgeEntry;

function framedResult(value: unknown) {
  return {
    status: 0,
    stdout: `${marker}\n${JSON.stringify(value)}`,
    stderr: "",
  };
}

describe("MCP tool discovery host boundary (#6901)", () => {
  it.each(["HTTP_PROXY", "HTTPS_PROXY", "NODE_EXTRA_CA_CERTS"])(
    "launches the same shared runtime below every adapter policy ancestor [%s]",
    (preserved) => {
      const expectedAncestor: Record<AgentMcpAdapter, string> = {
        mcporter: "nemoclaw-start node -e",
        "hermes-config": "/opt/hermes/.venv/bin/python -I -c",
        "deepagents-config": "/opt/venv/bin/python3 -I -c",
      };

      (Object.keys(expectedAncestor) as AgentMcpAdapter[]).forEach((adapter) => {
        const built = buildMcpToolDiscoveryCommand(entry, adapter);
        expect(built).not.toBeNull();
        expect(built?.command).toContain(expectedAncestor[adapter]);
        expect(built?.command).toContain("/usr/local/bin/node");
        expect(built?.command).toContain(MCP_TOOL_DISCOVERY_RUNTIME_PATH);
        expect(MCP_TOOL_DISCOVERY_RUNTIME_PATH).toMatch(/\.mjs$/u);
        expect(built?.command).not.toContain("--experimental-strip-types");
        expect(built?.command).not.toContain("node_modules");
        expect(built?.command).not.toContain("--authorization");
        expect(built?.command).not.toContain("openshell:resolve:env:GITHUB_TOKEN");
        expect(built?.command).toContain("--credential-env");
        expect(built?.command).toContain("GITHUB_TOKEN");
        expect(built?.command).not.toContain("tools/call");
        expect(built?.command).toContain("rebuild the sandbox");
        expect(built?.command).toContain(`unset ${MCP_RUNTIME_SANITIZED_ENV_VARS.join(" ")}`);
      });
      expect(MCP_RUNTIME_SANITIZED_ENV_VARS).toEqual(
        expect.arrayContaining(["LD_PRELOAD", "NODE_OPTIONS", "NODE_PATH", "PYTHONPATH"]),
      );

      expect(MCP_RUNTIME_SANITIZED_ENV_VARS).not.toContain(preserved);
    },
  );

  it("isolates Python adapter wrappers from a sandbox-controlled subprocess module", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-python-isolation-"));
    const importedMarker = path.join(tmpDir, "shadow-imported");
    fs.writeFileSync(
      path.join(tmpDir, "subprocess.py"),
      `from pathlib import Path\nPath(${JSON.stringify(importedMarker)}).write_text("imported")\n`,
    );
    const runner =
      "import subprocess, sys; raise SystemExit(subprocess.run(sys.argv[1:], check=False).returncode)";

    try {
      const result = spawnSync("python3", ["-I", "-c", runner, process.execPath, "-e", ""], {
        cwd: tmpDir,
        encoding: "utf8",
      });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(fs.existsSync(importedMarker)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("passes only the credential key name and rejects missing or non-canonical inputs", () => {
    const authenticated = buildMcpToolDiscoveryCommand(entry, "mcporter");
    expect(authenticated).not.toBeNull();
    expect(authenticated?.command).not.toContain("Authorization");
    expect(buildMcpToolDiscoveryCommand(unauthenticatedEntry, "mcporter")).toBeNull();
    expect(
      buildMcpToolDiscoveryCommand(
        { ...unauthenticatedEntry, url: "https://api.githubcopilot.com:443/mcp/" },
        "mcporter",
      ),
    ).toBeNull();
  });

  it("accepts one framed, deterministic, names-only runtime result", () => {
    expect(
      classifyMcpToolDiscoveryResult(
        framedResult({
          protocol: 1,
          ok: true,
          count: 2,
          tools: ["alpha", "zeta"],
          truncated: false,
        }),
        entry,
        marker,
      ),
    ).toEqual({
      ok: true,
      count: 2,
      tools: ["alpha", "zeta"],
      truncated: false,
    });
  });

  it("accepts the bounded inventory when valid names require maximum JSON escaping", () => {
    const tools = Array.from(
      { length: 500 },
      (_, index) => `${"\\".repeat(250)}${String(index).padStart(6, "0")}`,
    );

    expect(
      classifyMcpToolDiscoveryResult(
        framedResult({
          protocol: 1,
          ok: true,
          count: tools.length,
          tools,
          truncated: false,
        }),
        entry,
        marker,
      ),
    ).toEqual({
      ok: true,
      count: tools.length,
      tools,
      truncated: false,
    });
  });

  it("retains a strict host cap above the maximum compact runtime inventory", () => {
    expect(
      classifyMcpToolDiscoveryResult(
        {
          status: 0,
          stdout: `${marker}\n${"x".repeat(256 * 1_024 + 1)}`,
          stderr: "",
        },
        entry,
        marker,
      ),
    ).toEqual({
      ok: false,
      count: 0,
      tools: [],
      truncated: false,
      detail: "tool discovery returned an oversized result",
    });
  });

  it.each([
    framedResult({ protocol: 1, ok: true, count: 1, tools: ["bad\nname"], truncated: false }),
    framedResult({
      protocol: 1,
      ok: true,
      count: 1,
      tools: ["bad\ud800name"],
      truncated: false,
    }),
    framedResult({
      protocol: 1,
      ok: true,
      count: 1,
      tools: ["safe\u202eevil"],
      truncated: false,
    }),
    framedResult({
      protocol: 1,
      ok: true,
      count: 1,
      tools: ["safe\u2066evil"],
      truncated: false,
    }),
    framedResult({
      protocol: 1,
      ok: true,
      count: 1,
      tools: ["safe\u2028evil"],
      truncated: false,
    }),
    framedResult({
      protocol: 1,
      ok: true,
      count: 2,
      tools: ["same", "same"],
      truncated: false,
    }),
    framedResult({
      protocol: 1,
      ok: true,
      count: 2,
      tools: ["zeta", "alpha"],
      truncated: false,
    }),
    { status: 0, stdout: JSON.stringify({ protocol: 1 }), stderr: "" },
  ])("fails closed on malformed, duplicate, unsorted, or unframed results [case %#]", (result) => {
    expect(classifyMcpToolDiscoveryResult(result, entry, marker)).toMatchObject({
      ok: false,
      count: 0,
      tools: [],
    });
  });

  it("does not surface process output when the image runtime cannot start", () => {
    const result = classifyMcpToolDiscoveryResult(
      {
        status: 1,
        stdout: `${marker}\nBearer should-not-leak`,
        stderr:
          "authorization: should-not-leak\n[SECURITY] proxy startup refused Authorization=should-not-leak",
      },
      entry,
      marker,
    );
    expect(result.detail).toContain("rebuild the sandbox");
    expect(result.detail).toContain("exit 1");
    expect(result.detail).toContain("proxy startup refused");
    expect(JSON.stringify(result)).not.toContain("should-not-leak");
  });

  it("gates network traffic on the existing policy and provider readiness", () => {
    const ready = {
      policyGatewayPresent: true,
      providerAttached: true,
      providerCredentialReady: true,
    };
    expect(toolDiscoveryReadinessSkipDetail({ ...ready, policyGatewayPresent: false })).toContain(
      "policy does not match",
    );
    expect(toolDiscoveryReadinessSkipDetail({ ...ready, policyGatewayPresent: null })).toContain(
      "could not be inspected",
    );
    expect(toolDiscoveryReadinessSkipDetail({ ...ready, providerAttached: null })).toContain(
      "attachment could not be inspected",
    );
    expect(toolDiscoveryReadinessSkipDetail({ ...ready, providerAttached: false })).toContain(
      "provider is not attached",
    );
    expect(
      toolDiscoveryReadinessSkipDetail({
        ...ready,
        providerCredentialReady: false,
      }),
    ).toContain("does not match the recorded credential binding");
    expect(toolDiscoveryReadinessSkipDetail(ready)).toBeUndefined();
  });
});
