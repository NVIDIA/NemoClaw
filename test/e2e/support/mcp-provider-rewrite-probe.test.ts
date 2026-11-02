// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import vm from "node:vm";
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  buildMcpProviderRewriteAuthorization,
  buildMcpCredentialHandleAuthorizationPattern,
  MCP_PROVIDER_REWRITE_PROBE_SOURCE,
} from "../live/mcp-provider-rewrite-probe.ts";

describe("managed MCP provider rewrite probe", () => {
  const stableCredentialId = "a".repeat(64);

  it.each([
    "openshell:resolve:env:v0_FAKE_MCP_SECRET",
    "openshell:resolve:env:v1_FAKE_MCP_SECRET",
    "openshell:resolve:env:v14429878272859325890_FAKE_MCP_SECRET",
  ])("accepts an exact ordinary-static OpenShell credential revision [case %#]", (runtimeValue) => {
    expect(buildMcpProviderRewriteAuthorization("FAKE_MCP_SECRET", runtimeValue)).toBe(
      `Bearer ${runtimeValue}`,
    );
  });

  it("accepts an exact refresh-managed OpenShell stable credential handle", () => {
    const runtimeValue = `openshell:resolve:env:s${stableCredentialId}_FAKE_MCP_SECRET`;
    expect(buildMcpProviderRewriteAuthorization("FAKE_MCP_SECRET", runtimeValue)).toBe(
      `Bearer ${runtimeValue}`,
    );
  });

  it.each([
    undefined,
    "raw-secret",
    "openshell:resolve:env:v1_FAKE_MCP_SECRET\n",
    "openshell:resolve:env:FAKE_MCP_SECRET",
    "openshell:resolve:env:v_FAKE_MCP_SECRET",
    "openshell:resolve:env:v144298782728593258901_FAKE_MCP_SECRET",
    `openshell:resolve:env:s${"a".repeat(63)}_FAKE_MCP_SECRET`,
    `openshell:resolve:env:s${"a".repeat(65)}_FAKE_MCP_SECRET`,
    `openshell:resolve:env:s${"A".repeat(64)}_FAKE_MCP_SECRET`,
    `openshell:resolve:env:s${stableCredentialId}_OTHER_MCP_SECRET`,
    "openshell:resolve:env:vbad_FAKE_MCP_SECRET",
    `openshell:resolve:env:s${stableCredentialId}_FAKE_MCP_SECRET\nAuthorization: Bearer raw-secret`,
  ])("rejects an absent or unsafe runtime value [case %#]", (runtimeValue) => {
    expect(buildMcpProviderRewriteAuthorization("FAKE_MCP_SECRET", runtimeValue)).toBeNull();
  });

  it("embeds the reviewed helper and reads the fresh child environment", () => {
    expect(() => new vm.Script(MCP_PROVIDER_REWRITE_PROBE_SOURCE)).not.toThrow();
    expect(MCP_PROVIDER_REWRITE_PROBE_SOURCE).toContain("process.env[credentialKey]");
    expect(MCP_PROVIDER_REWRITE_PROBE_SOURCE).not.toContain(
      '"Bearer openshell:resolve:env:" + credentialKey',
    );
  });

  it.each([
    "Bearer openshell:resolve:env:v0_FAKE_MCP_SECRET",
    "Bearer openshell:resolve:env:v1_FAKE_MCP_SECRET",
    "Bearer openshell:resolve:env:v14429878272859325890_FAKE_MCP_SECRET",
  ])("accepts an ordinary-static Deep Agents credential revision [case %#]", (value) => {
    expect(value).toMatch(
      new RegExp(buildMcpCredentialHandleAuthorizationPattern("FAKE_MCP_SECRET"), "u"),
    );
  });

  it("accepts a refresh-managed Deep Agents stable credential handle", () => {
    const value = `Bearer openshell:resolve:env:s${stableCredentialId}_FAKE_MCP_SECRET`;
    expect(value).toMatch(
      new RegExp(buildMcpCredentialHandleAuthorizationPattern("FAKE_MCP_SECRET"), "u"),
    );
  });

  it.each([
    "Bearer openshell:resolve:env:FAKE_MCP_SECRET",
    "raw-secret",
    "Bearer openshell:resolve:env:v_FAKE_MCP_SECRET",
    `Bearer openshell:resolve:env:s${stableCredentialId}_OTHER_MCP_SECRET`,
    `Bearer openshell:resolve:env:s${"a".repeat(63)}_FAKE_MCP_SECRET`,
    `Bearer openshell:resolve:env:s${"a".repeat(65)}_FAKE_MCP_SECRET`,
    `Bearer openshell:resolve:env:s${"A".repeat(64)}_FAKE_MCP_SECRET`,
    "Bearer openshell:resolve:env:vbad_FAKE_MCP_SECRET",
    "Bearer openshell:resolve:env:v144298782728593258901_FAKE_MCP_SECRET",
  ])("rejects unsafe Deep Agents authorization [case %#]", (value) => {
    expect(value).not.toMatch(
      new RegExp(buildMcpCredentialHandleAuthorizationPattern("FAKE_MCP_SECRET"), "u"),
    );
  });
});

function executeRewriteProbe(expectation: string) {
  const request = Object.assign(new EventEmitter(), { end: vi.fn() });
  const send = vi.fn((_options: object, _callback: (response: EventEmitter) => void) => request);
  const exit = vi.fn();
  const output: string[] = [];
  vm.runInNewContext(MCP_PROVIDER_REWRITE_PROBE_SOURCE, {
    require: () => ({ request: send }),
    URL,
    Buffer,
    process: {
      argv: ["node", "-", "https://mcp.example.test/mcp", "tools/list", expectation],
      env: { FAKE_MCP_SECRET: "openshell:resolve:env:v1_FAKE_MCP_SECRET" },
      exit,
    },
    console: { log: (line: string) => output.push(line), error: vi.fn() },
  });
  return { request, send, exit, output };
}

describe("MCP request denial evidence", () => {
  it.each([
    ["deny", "EACCES", "connect", 0],
    ["deny-strict", "EACCES", "connect", 0],
    ["allow", "EACCES", "connect", 1],
    ["deny", "EACCES", "open", 1],
    ["deny", "ENOTFOUND", "getaddrinfo", 1],
    ["deny", "ECONNREFUSED", "connect", 1],
    ["deny", "ECONNRESET", "read", 1],
    ["deny-strict", "ECONNRESET", "connect", 1],
  ])("classifies %s with %s/%s as exit %s", (mode, code, syscall, status) => {
    const probe = executeRewriteProbe(String(mode));
    probe.request.emit("error", { code, syscall, message: "transport error" });
    expect(probe.exit).toHaveBeenCalledWith(status);
    expect(probe.output.join("\n")).toContain(JSON.stringify({ errorCode: code, syscall }));
  });
  it.each([
    ["allow", 200, '{"result":{}}', 0],
    ["deny", 200, '{"result":{}}', 1],
    ["deny", 403, '{"error":"policy_denied"}', 0],
    ["deny-strict", 403, '{"error":"policy_denied"}', 0],
    ["deny", 403, '{"error":"credential_endpoint_mismatch"}', 1],
    ["deny", 500, '{"error":"credential_unavailable"}', 1],
  ])("classifies %s HTTP %s %s as exit %s", (mode, status, body, expected) => {
    const probe = executeRewriteProbe(String(mode));
    const response = Object.assign(new EventEmitter(), {
      statusCode: status,
      setEncoding: vi.fn(),
    });
    probe.send.mock.calls[0]![1](response);
    response.emit("data", body);
    response.emit("end");
    expect(probe.exit).toHaveBeenCalledWith(expected);
    expect(probe.send.mock.calls[0]![0]).toMatchObject({
      autoSelectFamily: false,
      hostname: "mcp.example.test",
      path: "/mcp",
    });
  });
});
