// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMcpCredentialRevisionObservationCommand,
  parseMcpProviderAttachmentNames,
  parseMcpProviderMetadata,
  providerDetachChangedState,
} from "./mcp-bridge";
import { commandOutput } from "./mcp-bridge-output";
import {
  observeMcpCredentialRevision,
  waitForAttachedMcpCredential,
  waitForDetachedMcpCredential,
} from "./mcp-bridge-provider";
import * as processRecovery from "./process-recovery";

describe("OpenShell MCP provider state", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("parses provider type and credential keys without values", () => {
    expect(
      parseMcpProviderMetadata(`
Provider:

  Id: 11111111-2222-4333-8444-555555555555
  Name: alpha-mcp-github
  Type: generic
  Resource version: 7
  Credential keys: GITHUB_TOKEN
  Config keys: <none>
`),
    ).toEqual({
      id: "11111111-2222-4333-8444-555555555555",
      resourceVersion: 7,
      type: "generic",
      credentialKeys: ["GITHUB_TOKEN"],
    });
    expect(parseMcpProviderMetadata("Type: generic\nCredential keys: <none>\n")).toEqual({
      id: null,
      resourceVersion: null,
      type: "generic",
      credentialKeys: [],
    });
  });

  it("parses ANSI-decorated OpenShell provider metadata after redaction", () => {
    const output = commandOutput({
      status: 0,
      stdout: [
        "\u001b[2mProvider:\u001b[0m",
        "\u001b[2m  Id:\u001b[0m 11111111-2222-4333-8444-555555555555",
        "\u001b[2m  Type:\u001b[0m generic",
        "\u001b[2m  Resource version:\u001b[0m 7",
        "\u001b[2m  Credential keys:\u001b[0m GITHUB_TOKEN",
      ].join("\n"),
      stderr: "",
    });

    expect(parseMcpProviderMetadata(output)).toEqual({
      id: "11111111-2222-4333-8444-555555555555",
      resourceVersion: 7,
      type: "generic",
      credentialKeys: ["GITHUB_TOKEN"],
    });
    expect(output).not.toContain("\u001b");
    expect(output).not.toMatch(/\[[0-9;]*m/);
  });

  it("distinguishes a real detach from OpenShell's idempotent success", () => {
    expect(
      providerDetachChangedState(0, "✓ Detached provider alpha-mcp-github from sandbox alpha"),
    ).toBe(true);
    expect(
      providerDetachChangedState(0, "Provider alpha-mcp-github was not attached to sandbox alpha."),
    ).toBe(false);
  });

  it("parses the stock OpenShell sandbox provider table", () => {
    expect(
      parseMcpProviderAttachmentNames(`
NAME              TYPE     CREDENTIAL_KEYS   CONFIG_KEYS
alpha-mcp-github  generic  1                 0
alpha-mcp-slack   generic  1                 0
`),
    ).toEqual(["alpha-mcp-github", "alpha-mcp-slack"]);
    expect(parseMcpProviderAttachmentNames("No providers attached to sandbox alpha.\n")).toEqual(
      [],
    );
    expect(() => parseMcpProviderAttachmentNames("unexpected output\n")).toThrow(
      /attachment table header/,
    );
  });

  it("emits only bounded credential revision observations", () => {
    const command = buildMcpCredentialRevisionObservationCommand("GITHUB_TOKEN");
    for (const [value, observation] of [
      [undefined, "absent"],
      ["openshell:resolve:env:GITHUB_TOKEN", "canonical"],
      ["openshell:resolve:env:v11_GITHUB_TOKEN", "v11"],
      ["openshell:resolve:env:v0_GITHUB_TOKEN", "v0"],
    ] as const) {
      const result = spawnSync("/bin/sh", ["-c", command], {
        encoding: "utf8",
        env: value === undefined ? {} : { GITHUB_TOKEN: value },
      });
      expect(result.status, value).toBe(0);
      expect(result.stdout.trim()).toBe(observation);
      expect(result.stderr).toBe("");
    }

    for (const value of [
      "raw-secret",
      "openshell:resolve:env:v_GITHUB_TOKEN",
      "openshell:resolve:env:v11_OTHER_TOKEN",
      "openshell:resolve:env:v11x_GITHUB_TOKEN",
      `openshell:resolve:env:v${"1".repeat(21)}_GITHUB_TOKEN`,
    ]) {
      const result = spawnSync("/bin/sh", ["-c", command], {
        encoding: "utf8",
        env: { GITHUB_TOKEN: value },
      });
      expect(result.status, value).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    }
    expect(command).not.toMatch(/\/tmp|snapshot|cat\s|exec\s+[0-9]*>/);
  });

  it("uses an OpenShell-only exec for provider credential proofs", () => {
    const exec = vi.spyOn(processRecovery, "executeSandboxExecCommand").mockReturnValue({
      status: 0,
      stdout: "v11",
      stderr: "",
    });

    expect(
      observeMcpCredentialRevision("alpha", {
        server: "github",
        agent: "openclaw",
        adapter: "mcporter",
        url: "https://mcp.example.test/mcp",
        env: ["GITHUB_TOKEN"],
        providerName: "alpha-mcp-github-0123456789abcdef",
        providerId: "11111111-2222-4333-8444-555555555555",
        policyName: "mcp-bridge-github",
        addedAt: "2026-06-01T00:00:00.000Z",
      }),
    ).toBe("v11");
    const proofCommand = exec.mock.calls[0]?.[1] ?? "";
    expect(proofCommand).toContain("\n");
    expect(proofCommand).toContain("GITHUB_TOKEN");
    expect(proofCommand).not.toMatch(/\/tmp|snapshot/);
    expect(proofCommand).not.toContain("base64 -d");
    expect(exec).toHaveBeenCalledWith("alpha", proofCommand, undefined, {
      allowLocalDockerFallback: false,
    });

    exec.mockReturnValue({ status: 0, stdout: "raw-secret", stderr: "" });
    expect(() =>
      observeMcpCredentialRevision("alpha", {
        server: "github",
        agent: "openclaw",
        adapter: "mcporter",
        url: "https://mcp.example.test/mcp",
        env: ["GITHUB_TOKEN"],
        providerName: "alpha-mcp-github-0123456789abcdef",
        providerId: "11111111-2222-4333-8444-555555555555",
        policyName: "mcp-bridge-github",
        addedAt: "2026-06-01T00:00:00.000Z",
      }),
    ).toThrow(/Could not observe the current OpenShell credential revision/);
  });

  it("uses native multiline OpenShell exec for attachment readiness", () => {
    const exec = vi.spyOn(processRecovery, "executeSandboxExecCommand").mockReturnValue({
      status: 0,
      stdout: "canonical",
      stderr: "",
    });

    waitForAttachedMcpCredential("alpha", {
      server: "github",
      agent: "openclaw",
      adapter: "mcporter",
      url: "https://mcp.example.test/mcp",
      env: ["GITHUB_TOKEN"],
      providerName: "alpha-mcp-github-0123456789abcdef",
      providerId: "11111111-2222-4333-8444-555555555555",
      policyName: "mcp-bridge-github",
      addedAt: "2026-06-01T00:00:00.000Z",
    });

    const proofCommand = exec.mock.calls[0]?.[1] ?? "";
    expect(proofCommand).toContain("\n");
    expect(proofCommand).toContain("valid_placeholder");
    expect(proofCommand).toContain("GITHUB_TOKEN");
    expect(proofCommand).not.toContain("base64 -d");
  });

  it("fails detach verification when the strict OpenShell exec is unavailable", () => {
    vi.stubEnv("NEMOCLAW_MCP_PROVIDER_SYNC_TIMEOUT_SECONDS", "1");
    const exec = vi.spyOn(processRecovery, "executeSandboxExecCommand").mockReturnValue(null);
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(1_000);

    expect(() =>
      waitForDetachedMcpCredential("alpha", {
        server: "github",
        agent: "openclaw",
        adapter: "mcporter",
        url: "https://mcp.example.test/mcp",
        env: ["GITHUB_TOKEN"],
        providerName: "alpha-mcp-github-0123456789abcdef",
        providerId: "11111111-2222-4333-8444-555555555555",
        policyName: "mcp-bridge-github",
        addedAt: "2026-06-01T00:00:00.000Z",
      }),
    ).toThrow(/did not confirm credential 'GITHUB_TOKEN' was revoked/);

    const proofCommand = exec.mock.calls[0]?.[1] ?? "";
    expect(proofCommand).toContain("GITHUB_TOKEN+x");
    expect(proofCommand).not.toContain("base64 -d");
    expect(exec).toHaveBeenCalledWith("alpha", proofCommand, undefined, {
      allowLocalDockerFallback: false,
    });
  });

  it("requires a changed credential revision after provider updates", () => {
    const entry = {
      server: "github",
      agent: "openclaw",
      adapter: "mcporter",
      url: "https://mcp.example.test/mcp",
      env: ["GITHUB_TOKEN"],
      providerName: "alpha-mcp-github-0123456789abcdef",
      providerId: "11111111-2222-4333-8444-555555555555",
      policyName: "mcp-bridge-github",
      addedAt: "2026-06-01T00:00:00.000Z",
    };
    const exec = vi.spyOn(processRecovery, "executeSandboxExecCommand").mockReturnValue({
      status: 0,
      stdout: "v12",
      stderr: "",
    });

    waitForAttachedMcpCredential("alpha", entry, { previousRevision: "v11" });
    expect(exec).toHaveBeenCalledTimes(1);

    vi.stubEnv("NEMOCLAW_MCP_PROVIDER_SYNC_TIMEOUT_SECONDS", "1");
    exec.mockClear();
    exec.mockReturnValue({ status: 0, stdout: "v11", stderr: "" });
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(1_000);
    expect(() => waitForAttachedMcpCredential("alpha", entry, { previousRevision: "v11" })).toThrow(
      /did not synchronize the expected credential revision/,
    );
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
