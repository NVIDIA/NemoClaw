// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";
import * as providerCommand from "../../adapters/openshell/provider-command";
import type { McpBridgeEntry } from "../../state/registry";
import {
  buildMcpCredentialRevisionObservationCommand,
  parseMcpProviderAttachmentNames,
  parseMcpProviderMetadata,
  providerDetachChangedState,
} from "./mcp-bridge";
import { commandOutput } from "./mcp-bridge-output";
import {
  assertNoAttachedProviderCredentialCollisions,
  assertNoRegisteredProviderCredentialCollisions,
  providerMatchesCredential,
  providerMatchesManagedCredential,
} from "./mcp-bridge-provider-inspection";
import {
  assertMcpProviderRecoverable,
  observeMcpCredentialRevision,
  refreshMcpProviderEnvironment,
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
  Type: nemoclaw-mcp-v1
  Resource version: 7
  Credential keys: GITHUB_TOKEN
  Config keys: <none>
`),
    ).toEqual({
      id: "11111111-2222-4333-8444-555555555555",
      resourceVersion: 7,
      type: "nemoclaw-mcp-v1",
      credentialKeys: ["GITHUB_TOKEN"],
    });
    expect(parseMcpProviderMetadata("Type: nemoclaw-mcp-v1\nCredential keys: <none>\n")).toEqual({
      id: null,
      resourceVersion: null,
      type: "nemoclaw-mcp-v1",
      credentialKeys: [],
    });
  });

  it("parses ANSI-decorated OpenShell provider metadata after redaction", () => {
    const output = commandOutput({
      status: 0,
      stdout: [
        "\u001b[2mProvider:\u001b[0m",
        "\u001b[2m  Id:\u001b[0m 11111111-2222-4333-8444-555555555555",
        "\u001b[2m  Type:\u001b[0m nemoclaw-mcp-v1",
        "\u001b[2m  Resource version:\u001b[0m 7",
        "\u001b[2m  Credential keys:\u001b[0m GITHUB_TOKEN",
      ].join("\n"),
      stderr: "",
    });

    expect(parseMcpProviderMetadata(output)).toEqual({
      id: "11111111-2222-4333-8444-555555555555",
      resourceVersion: 7,
      type: "nemoclaw-mcp-v1",
      credentialKeys: ["GITHUB_TOKEN"],
    });
    expect(output).not.toContain("\u001b");
    expect(output).not.toMatch(/\[[0-9;]*m/);
  });

  it("accepts an exact legacy generic provider only for cleanup", () => {
    const inspection = {
      exists: true,
      id: "11111111-2222-4333-8444-555555555555",
      resourceVersion: 7,
      type: "generic",
      credentialKeys: ["GITHUB_TOKEN"],
    };

    expect(
      providerMatchesCredential(
        inspection,
        "GITHUB_TOKEN",
        "11111111-2222-4333-8444-555555555555",
      ),
    ).toBe(false);
    expect(
      providerMatchesManagedCredential(
        inspection,
        "GITHUB_TOKEN",
        "11111111-2222-4333-8444-555555555555",
        { allowLegacyGeneric: true },
      ),
    ).toBe(true);
  });

  it("rejects a legacy generic provider before active MCP reconciliation", () => {
    vi.spyOn(providerCommand, "runOpenshellProviderCommand").mockReturnValue({
      pid: 1234,
      status: 0,
      signal: null,
      output: [
        null,
        "Id: 11111111-2222-4333-8444-555555555555\nType: generic\nResource version: 7\nCredential keys: GITHUB_TOKEN\n",
        "",
      ],
      stdout:
        "Id: 11111111-2222-4333-8444-555555555555\nType: generic\nResource version: 7\nCredential keys: GITHUB_TOKEN\n",
      stderr: "",
    });
    const entry: McpBridgeEntry = {
      server: "github",
      agent: "openclaw",
      adapter: "mcporter",
      url: "https://api.githubcopilot.com/mcp",
      env: ["GITHUB_TOKEN"],
      providerName: "alpha-mcp-github",
      providerId: "11111111-2222-4333-8444-555555555555",
      policyName: "mcp-bridge-github",
      addedAt: "2026-08-19T00:00:00.000Z",
    };

    expect(() => assertMcpProviderRecoverable(entry)).toThrow(
      /legacy generic profile.*cannot bind to an MCP endpoint/,
    );
  });

  it("republishes an exact provider only after policy binding without reading its credential", () => {
    const id = "11111111-2222-4333-8444-555555555555";
    const providerResult = (resourceVersion: number) => ({
      pid: 1234,
      status: 0,
      signal: null,
      output: [
        null,
        `Id: ${id}\nType: nemoclaw-mcp-v1\nResource version: ${resourceVersion}\nCredential keys: GITHUB_TOKEN\n`,
        "",
      ],
      stdout: `Id: ${id}\nType: nemoclaw-mcp-v1\nResource version: ${resourceVersion}\nCredential keys: GITHUB_TOKEN\n`,
      stderr: "",
    });
    const run = vi
      .spyOn(providerCommand, "runOpenshellProviderCommand")
      .mockReturnValueOnce(providerResult(7))
      .mockReturnValueOnce({
        pid: 1234,
        status: 0,
        signal: null,
        output: [null, "", ""],
        stdout: "",
        stderr: "",
      })
      .mockReturnValueOnce(providerResult(8));

    expect(
      refreshMcpProviderEnvironment({
        server: "github",
        agent: "openclaw",
        adapter: "mcporter",
        url: "https://api.githubcopilot.com/mcp",
        env: ["GITHUB_TOKEN"],
        providerName: "alpha-mcp-github",
        providerId: id,
        policyName: "mcp-bridge-github",
        addedAt: "2026-08-19T00:00:00.000Z",
      }),
    ).toMatchObject({ resourceVersion: 8 });
    expect(run.mock.calls[1]?.[0]).toEqual(["provider", "update", "alpha-mcp-github"]);
    expect(run.mock.calls[1]?.[0]).not.toContain("--credential");
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

  it("rejects a multi-key bridge before provider collision inspection", () => {
    const providerCommandRun = vi.spyOn(providerCommand, "runOpenshellProviderCommand");
    const entry: McpBridgeEntry = {
      server: "example",
      agent: "openclaw",
      adapter: "mcporter",
      url: "https://8.8.8.8/mcp",
      env: ["PRIMARY_TOKEN", "SECONDARY_TOKEN"],
      providerName: "alpha-mcp-example",
      providerId: "11111111-2222-4333-8444-555555555555",
      policyName: "mcp-bridge-example",
      addedAt: "2026-06-01T00:00:00.000Z",
    };

    expect(() => assertNoAttachedProviderCredentialCollisions("alpha", [entry])).toThrow(
      "MCP server 'example' has no complete authenticated credential binding",
    );
    expect(() =>
      assertNoRegisteredProviderCredentialCollisions([entry], {
        listExtraProviders: () => ["foreign-registered"],
      }),
    ).toThrow("MCP server 'example' has no complete authenticated credential binding");
    expect(providerCommandRun).not.toHaveBeenCalled();
  });

  it("rejects a registered provider that will collide on the next rebuild (#9388)", () => {
    const entry: McpBridgeEntry = {
      server: "test-dir1",
      agent: "hermes",
      adapter: "hermes-config",
      url: "https://8.8.8.8/mcp",
      env: ["TEST_DIR1_TOKEN"],
      providerName: "hermes-mcp-test-dir1",
      policyName: "mcp-bridge-test-dir1",
      addedAt: "2026-08-18T00:00:00.000Z",
    };

    expect(() =>
      assertNoRegisteredProviderCredentialCollisions([entry], {
        listExtraProviders: () => ["test-dir1"],
        inspectProvider: () => ({
          exists: true,
          id: "99999999-8888-4777-8666-555555555555",
          resourceVersion: 1,
          type: "nemoclaw-mcp-v1",
          credentialKeys: ["TEST_DIR1_TOKEN"],
        }),
      }),
    ).toThrow(
      "Credential key 'TEST_DIR1_TOKEN' is already supplied by registered provider 'test-dir1'",
    );
  });

  it.each([
    { value: undefined, observation: "absent" },
    { value: "openshell:resolve:env:GITHUB_TOKEN", observation: "canonical" },
    { value: "openshell:resolve:env:v11_GITHUB_TOKEN", observation: "v11" },
    { value: "openshell:resolve:env:v0_GITHUB_TOKEN", observation: "v0" },
  ] as const)("emits the bounded $observation credential revision", ({ value, observation }) => {
    const command = buildMcpCredentialRevisionObservationCommand("GITHUB_TOKEN");
    const result = spawnSync("/bin/sh", ["-c", command], {
      encoding: "utf8",
      env: value === undefined ? {} : { GITHUB_TOKEN: value },
    });
    expect(result.status, value).toBe(0);
    expect(result.stdout.trim()).toBe(observation);
    expect(result.stderr).toBe("");
  });

  it.each([
    "raw-secret",
    "openshell:resolve:env:v_GITHUB_TOKEN",
    "openshell:resolve:env:v11_OTHER_TOKEN",
    "openshell:resolve:env:v11x_GITHUB_TOKEN",
    `openshell:resolve:env:v${"1".repeat(21)}_GITHUB_TOKEN`,
  ])("rejects an unbounded credential revision [case %#]", (value) => {
    const command = buildMcpCredentialRevisionObservationCommand("GITHUB_TOKEN");
    const result = spawnSync("/bin/sh", ["-c", command], {
      encoding: "utf8",
      env: { GITHUB_TOKEN: value },
    });
    expect(result.status, value).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("keeps credential revision observation in memory", () => {
    const command = buildMcpCredentialRevisionObservationCommand("GITHUB_TOKEN");
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

  it("waits for native multiline OpenShell exec to expose an attached revision", () => {
    const exec = vi
      .spyOn(processRecovery, "executeSandboxExecCommand")
      .mockReturnValueOnce({ status: 0, stdout: "canonical", stderr: "" })
      .mockReturnValue({ status: 0, stdout: "v11", stderr: "" });
    const refreshAfterObservedAbsence = vi.fn();

    const revision = waitForAttachedMcpCredential(
      "alpha",
      {
        server: "github",
        agent: "openclaw",
        adapter: "mcporter",
        url: "https://mcp.example.test/mcp",
        env: ["GITHUB_TOKEN"],
        providerName: "alpha-mcp-github-0123456789abcdef",
        providerId: "11111111-2222-4333-8444-555555555555",
        policyName: "mcp-bridge-github",
        addedAt: "2026-06-01T00:00:00.000Z",
      },
      { refreshAfterObservedAbsence },
    );

    const proofCommand = exec.mock.calls[0]?.[1] ?? "";
    expect(proofCommand).toContain("\n");
    expect(proofCommand).toContain("valid_placeholder");
    expect(proofCommand).toContain("GITHUB_TOKEN");
    expect(proofCommand).not.toContain("base64 -d");
    expect(refreshAfterObservedAbsence).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledTimes(3);
    expect(revision).toBe("v11");
  });

  it("waits for a post-policy credential revision to settle before returning", () => {
    const entry: McpBridgeEntry = {
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
    const exec = vi
      .spyOn(processRecovery, "executeSandboxExecCommand")
      .mockReturnValueOnce({ status: 0, stdout: "v11", stderr: "" })
      .mockReturnValue({ status: 0, stdout: "v12", stderr: "" });

    expect(waitForAttachedMcpCredential("alpha", entry)).toBe("v12");
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it("rejects a stable pre-update revision until the opaque provider mutation is projected", () => {
    const entry: McpBridgeEntry = {
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
    const exec = vi
      .spyOn(processRecovery, "executeSandboxExecCommand")
      .mockReturnValueOnce({ status: 0, stdout: "v15566468742889590075", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "v15566468742889590075", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "v7480654703696766813", stderr: "" })
      .mockReturnValue({ status: 0, stdout: "v7480654703696766813", stderr: "" });

    expect(
      waitForAttachedMcpCredential("alpha", entry, {
        previousRevision: "v15566468742889590075",
      }),
    ).toBe("v7480654703696766813");
    expect(exec).toHaveBeenCalledTimes(4);
  });

  it("does not accept an identityless placeholder as attachment readiness", () => {
    vi.stubEnv("NEMOCLAW_MCP_PROVIDER_SYNC_TIMEOUT_SECONDS", "1");
    vi.spyOn(processRecovery, "executeSandboxExecCommand").mockReturnValue({
      status: 0,
      stdout: "canonical",
      stderr: "",
    });
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(1_000);

    expect(() =>
      waitForAttachedMcpCredential("alpha", {
        server: "github",
        agent: "deepagents-code",
        adapter: "deepagents-config",
        url: "https://mcp.example.test/mcp",
        env: ["GITHUB_TOKEN"],
        providerName: "alpha-mcp-github-0123456789abcdef",
        providerId: "11111111-2222-4333-8444-555555555555",
        policyName: "mcp-bridge-github",
        addedAt: "2026-06-01T00:00:00.000Z",
      }),
    ).toThrow(/last bounded observation: canonical/);
  });

  it("reports an absent attached credential without attempting policy recovery", () => {
    vi.stubEnv("NEMOCLAW_MCP_PROVIDER_SYNC_TIMEOUT_SECONDS", "1");
    const exec = vi.spyOn(processRecovery, "executeSandboxExecCommand").mockReturnValue({
      status: 0,
      stdout: "absent",
      stderr: "",
    });
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(1_000);

    expect(() =>
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
      }),
    ).toThrow(/last bounded observation: absent/);
    expect(exec).toHaveBeenCalledOnce();
  });

  it("runs one provider-owned refresh after a fresh exec reports the credential absent", () => {
    const entry: McpBridgeEntry = {
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
    const exec = vi
      .spyOn(processRecovery, "executeSandboxExecCommand")
      .mockReturnValueOnce({ status: 0, stdout: "absent", stderr: "" })
      .mockReturnValue({ status: 0, stdout: "v12", stderr: "" });
    const refreshAfterObservedAbsence = vi.fn();

    expect(waitForAttachedMcpCredential("alpha", entry, { refreshAfterObservedAbsence })).toBe(
      "v12",
    );
    expect(refreshAfterObservedAbsence).toHaveBeenCalledOnce();
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it("does not repeat the provider refresh when the credential remains absent", () => {
    vi.stubEnv("NEMOCLAW_MCP_PROVIDER_SYNC_TIMEOUT_SECONDS", "1");
    const exec = vi.spyOn(processRecovery, "executeSandboxExecCommand").mockReturnValue({
      status: 0,
      stdout: "absent",
      stderr: "",
    });
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(1_000);
    const refreshAfterObservedAbsence = vi.fn();

    expect(() =>
      waitForAttachedMcpCredential(
        "alpha",
        {
          server: "github",
          agent: "openclaw",
          adapter: "mcporter",
          url: "https://mcp.example.test/mcp",
          env: ["GITHUB_TOKEN"],
          providerName: "alpha-mcp-github-0123456789abcdef",
          providerId: "11111111-2222-4333-8444-555555555555",
          policyName: "mcp-bridge-github",
          addedAt: "2026-06-01T00:00:00.000Z",
        },
        { refreshAfterObservedAbsence },
      ),
    ).toThrow(/post-absence provider refresh attempted: yes/u);
    expect(refreshAfterObservedAbsence).toHaveBeenCalledOnce();
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["unavailable", null, "transport-unavailable"],
    ["malformed", { status: 0, stdout: "raw-secret", stderr: "" }, "invalid-bounded-output"],
    ["rejected", { status: 1, stdout: "", stderr: "" }, "proof-command-exit-1"],
  ])("does not refresh when a credential observation is %s", (_case, result, diagnostic) => {
    vi.stubEnv("NEMOCLAW_MCP_PROVIDER_SYNC_TIMEOUT_SECONDS", "1");
    vi.spyOn(processRecovery, "executeSandboxExecCommand").mockReturnValue(result);
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(1_000);
    const refreshAfterObservedAbsence = vi.fn();

    let failure: unknown;
    try {
      waitForAttachedMcpCredential(
        "alpha",
        {
          server: "github",
          agent: "openclaw",
          adapter: "mcporter",
          url: "https://mcp.example.test/mcp",
          env: ["GITHUB_TOKEN"],
          providerName: "alpha-mcp-github-0123456789abcdef",
          providerId: "11111111-2222-4333-8444-555555555555",
          policyName: "mcp-bridge-github",
          addedAt: "2026-06-01T00:00:00.000Z",
        },
        { refreshAfterObservedAbsence },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(`last bounded observation: ${diagnostic}`);
    expect((failure as Error).message).not.toContain("raw-secret");
    expect(refreshAfterObservedAbsence).not.toHaveBeenCalled();
  });

  it("propagates a provider refresh failure after observed absence", () => {
    vi.spyOn(processRecovery, "executeSandboxExecCommand").mockReturnValue({
      status: 0,
      stdout: "absent",
      stderr: "",
    });
    const refreshAfterObservedAbsence = vi.fn(() => {
      throw new Error("provider refresh failed");
    });

    expect(() =>
      waitForAttachedMcpCredential(
        "alpha",
        {
          server: "github",
          agent: "openclaw",
          adapter: "mcporter",
          url: "https://mcp.example.test/mcp",
          env: ["GITHUB_TOKEN"],
          providerName: "alpha-mcp-github-0123456789abcdef",
          providerId: "11111111-2222-4333-8444-555555555555",
          policyName: "mcp-bridge-github",
          addedAt: "2026-06-01T00:00:00.000Z",
        },
        { refreshAfterObservedAbsence },
      ),
    ).toThrow("provider refresh failed");
    expect(refreshAfterObservedAbsence).toHaveBeenCalledOnce();
  });

  it("does not accept a stale revision after the provider refresh", () => {
    vi.stubEnv("NEMOCLAW_MCP_PROVIDER_SYNC_TIMEOUT_SECONDS", "1");
    const exec = vi
      .spyOn(processRecovery, "executeSandboxExecCommand")
      .mockReturnValueOnce({ status: 0, stdout: "absent", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "v11", stderr: "" });
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(1_000);
    const refreshAfterObservedAbsence = vi.fn();

    expect(() =>
      waitForAttachedMcpCredential(
        "alpha",
        {
          server: "github",
          agent: "openclaw",
          adapter: "mcporter",
          url: "https://mcp.example.test/mcp",
          env: ["GITHUB_TOKEN"],
          providerName: "alpha-mcp-github-0123456789abcdef",
          providerId: "11111111-2222-4333-8444-555555555555",
          policyName: "mcp-bridge-github",
          addedAt: "2026-06-01T00:00:00.000Z",
        },
        { previousRevision: "v11", refreshAfterObservedAbsence },
      ),
    ).toThrow(/last bounded observation: v11; post-absence provider refresh attempted: yes/u);
    expect(refreshAfterObservedAbsence).toHaveBeenCalledOnce();
    expect(exec).toHaveBeenCalledTimes(2);
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

    expect(waitForAttachedMcpCredential("alpha", entry, { previousRevision: "v11" })).toBe("v12");
    expect(exec).toHaveBeenCalledTimes(2);

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
