// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";
import * as extraProviders from "../../state/registry/extra-providers";
import { ConfigCorruptError } from "../../state/config-io";
import * as providerCommand from "../../adapters/openshell/provider-command";
import type { McpSourceEntry } from "./mcp-bridge-contracts";
import { buildMcpCredentialRevisionObservationCommand } from "./mcp-bridge";
import {
  assertNoAttachedProviderCredentialCollisions,
  assertNoProviderCredentialCollisions,
  assertNoRegisteredProviderCredentialCollisions,
  providerMatchesCredential,
  providerMatchesManagedCredential,
} from "./mcp-bridge-provider-inspection";
import {
  attachProvider,
  assertMcpProviderRecoverable,
  detachMissingProviderReference,
  detachProvider,
  ensureMcpBridgeProviderProfile,
  MCP_BRIDGE_PROVIDER_TYPE,
  observeMcpCredentialRevision,
  refreshMcpProviderEnvironment,
  upsertMcpProvider,
  waitForAttachedMcpCredential,
  waitForDetachedMcpCredential,
} from "./mcp-bridge-provider";
import * as processRecovery from "./process-recovery";

const runtimeSelection = {
  gatewayName: "nemoclaw-8091",
  localTlsDir: "/recorded/gateway/tls",
  workspace: "default",
} as const;

function providerMetadataOutput(
  name: string,
  type: string,
  id: string,
  resourceVersion: number,
  credentialKey: string,
): string {
  return [
    `Name: ${name}`,
    `Id: ${id}`,
    `Type: ${type}`,
    `Resource version: ${resourceVersion}`,
    `Credential keys: ${credentialKey}`,
    "Config keys: <none>",
  ].join("\n");
}

describe("OpenShell MCP provider state", () => {
  afterEach(() => {
    providerCommand.setProviderCommandRuntimeHooksForTest({});
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
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
      providerMatchesCredential(inspection, "GITHUB_TOKEN", "11111111-2222-4333-8444-555555555555"),
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

  it("rejects a legacy generic provider before active MCP reconciliation", async () => {
    vi.spyOn(providerCommand, "runOpenshellProviderCommand").mockReturnValue({
      pid: 1234,
      status: 0,
      signal: null,
      output: [
        null,
        providerMetadataOutput(
          "alpha-mcp-github",
          "generic",
          "11111111-2222-4333-8444-555555555555",
          7,
          "GITHUB_TOKEN",
        ),
        "",
      ],
      stdout: providerMetadataOutput(
        "alpha-mcp-github",
        "generic",
        "11111111-2222-4333-8444-555555555555",
        7,
        "GITHUB_TOKEN",
      ),
      stderr: "",
    });
    const entry: McpSourceEntry = {
      server: "github",
      agent: "openclaw",
      adapter: "openclaw-config",
      url: "https://api.githubcopilot.com/mcp",
      env: ["GITHUB_TOKEN"],
      providerName: "alpha-mcp-github",
      providerId: "11111111-2222-4333-8444-555555555555",
      policyName: "mcp-bridge-github",
    };

    await expect(assertMcpProviderRecoverable(entry, runtimeSelection)).rejects.toThrow(
      /legacy generic profile.*cannot bind to an MCP endpoint/,
    );
  });

  it("republishes an exact provider only after policy binding without reading its credential", async () => {
    const id = "11111111-2222-4333-8444-555555555555";
    const providerResult = (resourceVersion: number) => ({
      pid: 1234,
      status: 0,
      signal: null,
      output: [
        null,
        providerMetadataOutput(
          "alpha-mcp-github",
          "nemoclaw-mcp-v1",
          id,
          resourceVersion,
          "GITHUB_TOKEN",
        ),
        "",
      ],
      stdout: providerMetadataOutput(
        "alpha-mcp-github",
        "nemoclaw-mcp-v1",
        id,
        resourceVersion,
        "GITHUB_TOKEN",
      ),
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

    await expect(
      refreshMcpProviderEnvironment(
        {
          server: "github",
          agent: "openclaw",
          adapter: "openclaw-config",
          url: "https://api.githubcopilot.com/mcp",
          env: ["GITHUB_TOKEN"],
          providerName: "alpha-mcp-github",
          providerId: id,
          policyName: "mcp-bridge-github",
        },
        {
          gatewayName: "nemoclaw-8080",
          workspace: "default",
        },
      ),
    ).resolves.toMatchObject({ resourceVersion: 8 });
    expect(run.mock.calls[1]?.[0]).toEqual(["provider", "update", "alpha-mcp-github"]);
    expect(run.mock.calls[1]?.[0]).not.toContain("--credential");
  });

  it("pins every managed MCP provider lifecycle read and write to the recorded runtime target (#10514)", async () => {
    vi.stubEnv("EXPECTED_TOKEN", "host-only-secret");
    vi.stubEnv("OPENSHELL_GATEWAY", "ambient-gateway");
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "http://ambient.invalid");
    vi.stubEnv("OPENSHELL_GATEWAY_INSECURE", "true");
    vi.stubEnv("OPENSHELL_WORKSPACE", "ambient-workspace");

    const runtimeSelection = { gatewayName: "nemoclaw-8091", workspace: "default" };
    const providerId = "11111111-2222-4333-8444-555555555555";
    const commandFamilies = new Set<string>();
    let providerExists = false;
    let providerAttached = false;
    let resourceVersion = 0;
    const providerOutput = () =>
      providerMetadataOutput(
        "alpha-mcp-fake",
        MCP_BRIDGE_PROVIDER_TYPE,
        providerId,
        resourceVersion,
        "EXPECTED_TOKEN",
      );
    const profileOutput = (id: string, inferenceCapable: boolean) =>
      JSON.stringify({
        id,
        credentials: [],
        endpoints: [],
        binaries: [],
        inference_capable: inferenceCapable,
      });

    const runOpenshell = vi.fn((args: string[], options: { env?: Record<string, string> }) => {
      const env = options.env ?? {};
      expect(
        Object.keys(env)
          .filter((name) => name.startsWith("OPENSHELL_"))
          .sort(),
      ).toEqual(["OPENSHELL_GATEWAY", "OPENSHELL_WORKSPACE"]);
      expect(env.OPENSHELL_GATEWAY).toBe(runtimeSelection.gatewayName);
      expect(env.OPENSHELL_WORKSPACE).toBe(runtimeSelection.workspace);

      const command = `${args[0]} ${args[1]} ${args[2] ?? ""}`;
      switch (command) {
        case "provider profile export":
          commandFamilies.add("profile");
          return {
            status: 0,
            stdout: profileOutput(args[3], args[3] === "openai"),
            stderr: "",
          };
        case "provider get alpha-mcp-fake":
          commandFamilies.add("get");
          return providerExists
            ? { status: 0, stdout: providerOutput(), stderr: "" }
            : { status: 1, stdout: "", stderr: `provider '${args[2]}' not found` };
        case "provider create --name":
          commandFamilies.add("create");
          providerExists = true;
          resourceVersion = 1;
          return { status: 0, stdout: "Created", stderr: "" };
        case "provider update alpha-mcp-fake":
          commandFamilies.add("update");
          resourceVersion += 1;
          return { status: 0, stdout: "Updated", stderr: "" };
        case "provider delete alpha-mcp-fake":
          commandFamilies.add("delete");
          providerExists = false;
          return { status: 0, stdout: "Deleted", stderr: "" };
        case "sandbox provider list":
          commandFamilies.add("list");
          return providerAttached
            ? {
                status: 0,
                stdout: `NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\nalpha-mcp-fake ${MCP_BRIDGE_PROVIDER_TYPE} 1 0\n`,
                stderr: "",
              }
            : {
                status: 0,
                stdout: "No providers attached to sandbox alpha.\n",
                stderr: "",
              };
        case "sandbox provider attach":
          commandFamilies.add("attach");
          providerAttached = true;
          return { status: 0, stdout: "Attached", stderr: "" };
        case "sandbox provider detach": {
          commandFamilies.add("detach");
          const changed = providerAttached;
          providerAttached = false;
          return {
            status: 0,
            stdout: changed
              ? "Detached provider alpha-mcp-fake from sandbox alpha."
              : "Provider alpha-mcp-fake was not attached to sandbox alpha.",
            stderr: "",
          };
        }
        default:
          throw new Error(`Unexpected OpenShell command: ${args.join(" ")}`);
      }
    });
    providerCommand.setProviderCommandRuntimeHooksForTest({ runOpenshell: runOpenshell as never });

    await ensureMcpBridgeProviderProfile(runtimeSelection);
    const created = await upsertMcpProvider("alpha-mcp-fake", [{ name: "EXPECTED_TOKEN" }], {
      allowExisting: false,
      runtimeSelection,
    });
    const entry: McpSourceEntry = {
      server: "fake",
      agent: "openclaw",
      adapter: "openclaw-config",
      url: "https://mcp.example.test/mcp",
      env: ["EXPECTED_TOKEN"],
      providerName: "alpha-mcp-fake",
      providerId: created.inspection.id ?? undefined,
      policyName: "mcp-bridge-fake",
    };
    await attachProvider("alpha", entry, runtimeSelection);
    await refreshMcpProviderEnvironment(entry, runtimeSelection);
    await expect(detachProvider("alpha", entry, { runtimeSelection })).resolves.toBe("detached");

    expect(commandFamilies).toEqual(
      new Set(["profile", "get", "create", "attach", "list", "update", "detach"]),
    );
  });

  it("rejects a multi-key bridge before provider collision inspection", async () => {
    const providerCommandRun = vi.spyOn(providerCommand, "runOpenshellProviderCommand");
    const entry: McpSourceEntry = {
      server: "example",
      agent: "openclaw",
      adapter: "openclaw-config",
      url: "https://8.8.8.8/mcp",
      env: ["PRIMARY_TOKEN", "SECONDARY_TOKEN"],
      providerName: "alpha-mcp-example",
      providerId: "11111111-2222-4333-8444-555555555555",
      policyName: "mcp-bridge-example",
    };

    await expect(
      assertNoAttachedProviderCredentialCollisions("alpha", [entry], runtimeSelection),
    ).rejects.toThrow("MCP server 'example' has no complete authenticated credential binding");
    await expect(
      assertNoRegisteredProviderCredentialCollisions([entry], {
        listExtraProviders: () => ["foreign-registered"],
      }),
    ).rejects.toThrow("MCP server 'example' has no complete authenticated credential binding");
    expect(providerCommandRun).not.toHaveBeenCalled();
  });

  it.each([
    {
      state: "corrupt with current authority",
      error: new ConfigCorruptError("/fixture/registry.json"),
      current: true,
      live: true,
      listStatus: 0,
      listOutput: "No providers attached to sandbox alpha.\n",
      expected: "ok",
      checks: 1,
      extraReads: 1,
    },
    {
      state: "corrupt with stale authority",
      error: new ConfigCorruptError("/fixture/registry.json"),
      current: false,
      live: true,
      listStatus: 0,
      listOutput: "No providers attached to sandbox alpha.\n",
      expected: "identity changed",
      checks: 1,
      extraReads: 1,
    },
    {
      state: "permission failure",
      error: Object.assign(new Error("registry permission denied"), { code: "EACCES" }),
      current: true,
      live: true,
      listStatus: 0,
      listOutput: "No providers attached to sandbox alpha.\n",
      expected: "registry permission denied",
      checks: 0,
      extraReads: 1,
    },
    {
      state: "unknown failure",
      error: new Error("unknown registry read failure"),
      current: true,
      live: true,
      listStatus: 0,
      listOutput: "No providers attached to sandbox alpha.\n",
      expected: "unknown registry read failure",
      checks: 0,
      extraReads: 1,
    },
    {
      state: "corrupt without live authority",
      error: new ConfigCorruptError("/fixture/registry.json"),
      current: true,
      live: false,
      listStatus: 0,
      listOutput: "No providers attached to sandbox alpha.\n",
      expected: "ConfigCorruptError",
      checks: 0,
      extraReads: 1,
    },
    {
      state: "corrupt with unavailable attachment proof",
      error: new ConfigCorruptError("/fixture/registry.json"),
      current: true,
      live: true,
      listStatus: 1,
      listOutput: "",
      expected: "Could not",
      checks: 0,
      extraReads: 0,
    },
    {
      state: "corrupt with a live credential collision",
      error: new ConfigCorruptError("/fixture/registry.json"),
      current: true,
      live: true,
      listStatus: 0,
      listOutput: "NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\nforeign-provider nemoclaw-mcp-v1 1 0\n",
      expected: "already supplied by attached provider",
      checks: 0,
      extraReads: 0,
    },
  ])(
    "checks complete live collision evidence before handling $state",
    async ({ error, current, live, listStatus, listOutput, expected, checks, extraReads }) => {
      const entry: McpSourceEntry = {
        server: "github",
        agent: "hermes",
        adapter: "hermes-config",
        url: "https://8.8.8.8/mcp",
        env: ["HOSTLESS_TOKEN"],
        providerName: "alpha-mcp-github",
        policyName: "mcp-bridge-github",
      };
      const extra = vi.spyOn(extraProviders, "listExtraProviders").mockImplementation(() => {
        throw error;
      });
      const assertCurrent = vi.fn();
      const proof = {
        true: () => undefined,
        false: () => {
          throw new Error("identity changed");
        },
      };
      assertCurrent.mockImplementation(proof[String(current) as "true" | "false"]);
      const target = {
        sandbox: { name: "alpha", agent: "hermes" },
        runtimeSelection,
        ...(live ? { liveIdentity: { sandboxId: "exact-id", assertCurrent } } : {}),
      };
      const metadata = providerMetadataOutput(
        "foreign-provider",
        "nemoclaw-mcp-v1",
        "11111111-2222-4333-8444-555555555555",
        7,
        "HOSTLESS_TOKEN",
      );
      const responses = [
        { status: listStatus, stdout: listOutput, stderr: "Could not inspect attachments" },
        { status: 0, stdout: metadata, stderr: "" },
      ];
      vi.spyOn(providerCommand, "runOpenshellProviderCommand").mockImplementation(
        () => responses.shift() as never,
      );
      const result = await assertNoProviderCredentialCollisions(
        "alpha",
        [entry],
        runtimeSelection,
        target,
      ).then(
        () => "ok",
        (failure: unknown) => String(failure),
      );
      expect(result).toContain(expected);
      expect(assertCurrent).toHaveBeenCalledTimes(checks);
      expect(extra).toHaveBeenCalledTimes(extraReads);
    },
  );

  it.each([
    { scope: "sandbox name", name: "beta", selection: runtimeSelection },
    {
      scope: "gateway",
      name: "alpha",
      selection: { ...runtimeSelection, gatewayName: "nemoclaw-9090" },
    },
    { scope: "workspace", name: "alpha", selection: { ...runtimeSelection, workspace: "other" } },
    {
      scope: "TLS directory",
      name: "alpha",
      selection: { ...runtimeSelection, localTlsDir: "/other/tls" },
    },
  ])(
    "refuses corrupt-registry omission with authority for another $scope",
    async ({ name, selection }) => {
      const error = new ConfigCorruptError("/fixture/registry.json");
      vi.spyOn(extraProviders, "listExtraProviders").mockImplementation(() => {
        throw error;
      });
      const assertCurrent = vi.fn();
      const entry: McpSourceEntry = {
        server: "github",
        agent: "hermes",
        adapter: "hermes-config",
        url: "https://8.8.8.8/mcp",
        env: ["HOSTLESS_TOKEN"],
        providerName: "alpha-mcp-github",
        policyName: "mcp-bridge-github",
      };
      vi.spyOn(providerCommand, "runOpenshellProviderCommand").mockReturnValue({
        status: 0,
        stdout: "No providers attached to sandbox alpha.\n",
        stderr: "",
      } as never);
      await expect(
        assertNoProviderCredentialCollisions("alpha", [entry], runtimeSelection, {
          sandbox: { name, agent: "hermes" },
          runtimeSelection: selection,
          liveIdentity: { sandboxId: "exact-id", assertCurrent },
        }),
      ).rejects.toBe(error);
      expect(assertCurrent).not.toHaveBeenCalled();
    },
  );

  it("rejects a registered provider that will collide on the next rebuild (#9388)", async () => {
    const entry: McpSourceEntry = {
      server: "test-dir1",
      agent: "hermes",
      adapter: "hermes-config",
      url: "https://8.8.8.8/mcp",
      env: ["TEST_DIR1_TOKEN"],
      providerName: "hermes-mcp-test-dir1",
      policyName: "mcp-bridge-test-dir1",
    };

    await expect(
      assertNoRegisteredProviderCredentialCollisions([entry], {
        listExtraProviders: () => ["test-dir1"],
        inspectProvider: async () => ({
          exists: true,
          id: "99999999-8888-4777-8666-555555555555",
          resourceVersion: 1,
          type: "nemoclaw-mcp-v1",
          credentialKeys: ["TEST_DIR1_TOKEN"],
        }),
      }),
    ).rejects.toThrow(
      "Credential key 'TEST_DIR1_TOKEN' is already supplied by configured extra provider 'test-dir1'",
    );
  });

  it("pins attachment collision inspection to the recorded runtime target (#10514)", async () => {
    const runtimeSelection = { gatewayName: "nemoclaw-9090", workspace: "default" };
    const run = vi
      .spyOn(providerCommand, "runOpenshellProviderCommand")
      .mockReturnValueOnce({
        pid: 1234,
        status: 0,
        signal: null,
        output: [
          null,
          "NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\nforeign-provider nemoclaw-mcp-v1 1 0\n",
          "",
        ],
        stdout: "NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\nforeign-provider nemoclaw-mcp-v1 1 0\n",
        stderr: "",
      })
      .mockReturnValueOnce({
        pid: 1234,
        status: 0,
        signal: null,
        output: [
          null,
          providerMetadataOutput(
            "foreign-provider",
            "nemoclaw-mcp-v1",
            "99999999-8888-4777-8666-555555555555",
            1,
            "GITHUB_TOKEN",
          ),
          "",
        ],
        stdout: providerMetadataOutput(
          "foreign-provider",
          "nemoclaw-mcp-v1",
          "99999999-8888-4777-8666-555555555555",
          1,
          "GITHUB_TOKEN",
        ),
        stderr: "",
      });
    const entry: McpSourceEntry = {
      server: "github",
      agent: "openclaw",
      adapter: "openclaw-config",
      url: "https://api.githubcopilot.com/mcp",
      env: ["GITHUB_TOKEN"],
      providerName: "alpha-mcp-github",
      providerId: "11111111-2222-4333-8444-555555555555",
      policyName: "mcp-bridge-github",
    };

    await expect(
      assertNoAttachedProviderCredentialCollisions("alpha", [entry], runtimeSelection),
    ).rejects.toThrow("Credential key 'GITHUB_TOKEN' is already supplied by attached provider");
    expect(run).toHaveBeenCalledTimes(2);
    expect(
      run.mock.calls.every(
        ([, options]) =>
          options?.runtimeSelection?.gatewayName === runtimeSelection.gatewayName &&
          options.runtimeSelection.workspace === runtimeSelection.workspace,
      ),
    ).toBe(true);
  });

  it("pins registered collision inspection to the recorded runtime target (#10514)", async () => {
    const runtimeSelection = { gatewayName: "nemoclaw-9090", workspace: "default" };
    const run = vi.spyOn(providerCommand, "runOpenshellProviderCommand").mockReturnValue({
      pid: 1234,
      status: 0,
      signal: null,
      output: [
        null,
        providerMetadataOutput(
          "foreign-provider",
          "nemoclaw-mcp-v1",
          "99999999-8888-4777-8666-555555555555",
          1,
          "GITHUB_TOKEN",
        ),
        "",
      ],
      stdout: providerMetadataOutput(
        "foreign-provider",
        "nemoclaw-mcp-v1",
        "99999999-8888-4777-8666-555555555555",
        1,
        "GITHUB_TOKEN",
      ),
      stderr: "",
    });
    const entry: McpSourceEntry = {
      server: "github",
      agent: "openclaw",
      adapter: "openclaw-config",
      url: "https://api.githubcopilot.com/mcp",
      env: ["GITHUB_TOKEN"],
      providerName: "alpha-mcp-github",
      providerId: "11111111-2222-4333-8444-555555555555",
      policyName: "mcp-bridge-github",
    };

    await expect(
      assertNoRegisteredProviderCredentialCollisions([entry], {
        listExtraProviders: () => ["foreign-provider"],
        runtimeSelection,
      }),
    ).rejects.toThrow(
      "Credential key 'GITHUB_TOKEN' is already supplied by configured extra provider",
    );
    expect(run).toHaveBeenCalledWith(
      ["provider", "get", "foreign-provider"],
      expect.objectContaining({ runtimeSelection }),
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
      observeMcpCredentialRevision(
        "alpha",
        {
          server: "github",
          agent: "openclaw",
          adapter: "openclaw-config",
          url: "https://mcp.example.test/mcp",
          env: ["GITHUB_TOKEN"],
          providerName: "alpha-mcp-github-0123456789abcdef",
          providerId: "11111111-2222-4333-8444-555555555555",
          policyName: "mcp-bridge-github",
        },
        runtimeSelection,
      ),
    ).toBe("v11");
    const proofCommand = exec.mock.calls[0]?.[1] ?? "";
    expect(proofCommand).toContain("\n");
    expect(proofCommand).toContain("GITHUB_TOKEN");
    expect(proofCommand).not.toMatch(/\/tmp|snapshot/);
    expect(proofCommand).not.toContain("base64 -d");
    expect(exec).toHaveBeenCalledWith("alpha", proofCommand, undefined, {
      allowLocalDockerFallback: false,
      runtimeSelection,
    });

    exec.mockReturnValue({ status: 0, stdout: "raw-secret", stderr: "" });
    expect(() =>
      observeMcpCredentialRevision(
        "alpha",
        {
          server: "github",
          agent: "openclaw",
          adapter: "openclaw-config",
          url: "https://mcp.example.test/mcp",
          env: ["GITHUB_TOKEN"],
          providerName: "alpha-mcp-github-0123456789abcdef",
          providerId: "11111111-2222-4333-8444-555555555555",
          policyName: "mcp-bridge-github",
        },
        runtimeSelection,
      ),
    ).toThrow(/Could not observe the current OpenShell credential revision/);
  });

  it("waits for native multiline OpenShell exec to expose an attached revision", async () => {
    const exec = vi
      .spyOn(processRecovery, "executeSandboxExecCommand")
      .mockReturnValueOnce({ status: 0, stdout: "canonical", stderr: "" })
      .mockReturnValue({ status: 0, stdout: "v11", stderr: "" });
    const refreshAfterObservedAbsence = vi.fn();

    const revision = await waitForAttachedMcpCredential(
      "alpha",
      {
        server: "github",
        agent: "openclaw",
        adapter: "openclaw-config",
        url: "https://mcp.example.test/mcp",
        env: ["GITHUB_TOKEN"],
        providerName: "alpha-mcp-github-0123456789abcdef",
        providerId: "11111111-2222-4333-8444-555555555555",
        policyName: "mcp-bridge-github",
      },
      runtimeSelection,
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

  it("waits for a post-policy credential revision to settle before returning", async () => {
    const entry: McpSourceEntry = {
      server: "github",
      agent: "openclaw",
      adapter: "openclaw-config",
      url: "https://mcp.example.test/mcp",
      env: ["GITHUB_TOKEN"],
      providerName: "alpha-mcp-github-0123456789abcdef",
      providerId: "11111111-2222-4333-8444-555555555555",
      policyName: "mcp-bridge-github",
    };
    const exec = vi
      .spyOn(processRecovery, "executeSandboxExecCommand")
      .mockReturnValueOnce({ status: 0, stdout: "v11", stderr: "" })
      .mockReturnValue({ status: 0, stdout: "v12", stderr: "" });

    await expect(waitForAttachedMcpCredential("alpha", entry, runtimeSelection)).resolves.toBe(
      "v12",
    );
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it("rejects a stable pre-update revision until the opaque provider mutation is projected", async () => {
    const entry: McpSourceEntry = {
      server: "github",
      agent: "openclaw",
      adapter: "openclaw-config",
      url: "https://mcp.example.test/mcp",
      env: ["GITHUB_TOKEN"],
      providerName: "alpha-mcp-github-0123456789abcdef",
      providerId: "11111111-2222-4333-8444-555555555555",
      policyName: "mcp-bridge-github",
    };
    const exec = vi
      .spyOn(processRecovery, "executeSandboxExecCommand")
      .mockReturnValueOnce({ status: 0, stdout: "v15566468742889590075", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "v15566468742889590075", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "v7480654703696766813", stderr: "" })
      .mockReturnValue({ status: 0, stdout: "v7480654703696766813", stderr: "" });

    await expect(
      waitForAttachedMcpCredential("alpha", entry, runtimeSelection, {
        previousRevision: "v15566468742889590075",
      }),
    ).resolves.toBe("v7480654703696766813");
    expect(exec).toHaveBeenCalledTimes(4);
  });

  it("does not accept an identityless placeholder as attachment readiness", async () => {
    vi.stubEnv("NEMOCLAW_MCP_PROVIDER_SYNC_TIMEOUT_SECONDS", "1");
    vi.spyOn(processRecovery, "executeSandboxExecCommand").mockReturnValue({
      status: 0,
      stdout: "canonical",
      stderr: "",
    });
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(1_000);

    await expect(
      waitForAttachedMcpCredential(
        "alpha",
        {
          server: "github",
          agent: "deepagents-code",
          adapter: "deepagents-config",
          url: "https://mcp.example.test/mcp",
          env: ["GITHUB_TOKEN"],
          providerName: "alpha-mcp-github-0123456789abcdef",
          providerId: "11111111-2222-4333-8444-555555555555",
          policyName: "mcp-bridge-github",
        },
        runtimeSelection,
      ),
    ).rejects.toThrow(/last bounded observation: canonical/);
  });

  it("reports an absent attached credential without attempting policy recovery", async () => {
    vi.stubEnv("NEMOCLAW_MCP_PROVIDER_SYNC_TIMEOUT_SECONDS", "1");
    const exec = vi.spyOn(processRecovery, "executeSandboxExecCommand").mockReturnValue({
      status: 0,
      stdout: "absent",
      stderr: "",
    });
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(1_000);

    await expect(
      waitForAttachedMcpCredential(
        "alpha",
        {
          server: "github",
          agent: "openclaw",
          adapter: "openclaw-config",
          url: "https://mcp.example.test/mcp",
          env: ["GITHUB_TOKEN"],
          providerName: "alpha-mcp-github-0123456789abcdef",
          providerId: "11111111-2222-4333-8444-555555555555",
          policyName: "mcp-bridge-github",
        },
        runtimeSelection,
      ),
    ).rejects.toThrow(/last bounded observation: absent/);
    expect(exec).toHaveBeenCalledOnce();
  });

  it("runs one provider-owned refresh after a fresh exec reports the credential absent", async () => {
    const entry: McpSourceEntry = {
      server: "github",
      agent: "openclaw",
      adapter: "openclaw-config",
      url: "https://mcp.example.test/mcp",
      env: ["GITHUB_TOKEN"],
      providerName: "alpha-mcp-github-0123456789abcdef",
      providerId: "11111111-2222-4333-8444-555555555555",
      policyName: "mcp-bridge-github",
    };
    const exec = vi
      .spyOn(processRecovery, "executeSandboxExecCommand")
      .mockReturnValueOnce({ status: 0, stdout: "absent", stderr: "" })
      .mockReturnValue({ status: 0, stdout: "v12", stderr: "" });
    const refreshAfterObservedAbsence = vi.fn();

    await expect(
      waitForAttachedMcpCredential("alpha", entry, runtimeSelection, {
        refreshAfterObservedAbsence,
      }),
    ).resolves.toBe("v12");
    expect(refreshAfterObservedAbsence).toHaveBeenCalledOnce();
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it("does not repeat the provider refresh when the credential remains absent", async () => {
    vi.stubEnv("NEMOCLAW_MCP_PROVIDER_SYNC_TIMEOUT_SECONDS", "1");
    const exec = vi.spyOn(processRecovery, "executeSandboxExecCommand").mockReturnValue({
      status: 0,
      stdout: "absent",
      stderr: "",
    });
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(1_000);
    const refreshAfterObservedAbsence = vi.fn();

    await expect(
      waitForAttachedMcpCredential(
        "alpha",
        {
          server: "github",
          agent: "openclaw",
          adapter: "openclaw-config",
          url: "https://mcp.example.test/mcp",
          env: ["GITHUB_TOKEN"],
          providerName: "alpha-mcp-github-0123456789abcdef",
          providerId: "11111111-2222-4333-8444-555555555555",
          policyName: "mcp-bridge-github",
        },
        runtimeSelection,
        { refreshAfterObservedAbsence },
      ),
    ).rejects.toThrow(/post-absence provider refresh attempted: yes/u);
    expect(refreshAfterObservedAbsence).toHaveBeenCalledOnce();
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["unavailable", null, "transport-unavailable"],
    ["malformed", { status: 0, stdout: "raw-secret", stderr: "" }, "invalid-bounded-output"],
    ["rejected", { status: 1, stdout: "", stderr: "" }, "proof-command-exit-1"],
  ])("does not refresh when a credential observation is %s", async (_case, result, diagnostic) => {
    vi.stubEnv("NEMOCLAW_MCP_PROVIDER_SYNC_TIMEOUT_SECONDS", "1");
    vi.spyOn(processRecovery, "executeSandboxExecCommand").mockReturnValue(result);
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(1_000);
    const refreshAfterObservedAbsence = vi.fn();

    let failure: unknown;
    try {
      await waitForAttachedMcpCredential(
        "alpha",
        {
          server: "github",
          agent: "openclaw",
          adapter: "openclaw-config",
          url: "https://mcp.example.test/mcp",
          env: ["GITHUB_TOKEN"],
          providerName: "alpha-mcp-github-0123456789abcdef",
          providerId: "11111111-2222-4333-8444-555555555555",
          policyName: "mcp-bridge-github",
        },
        runtimeSelection,
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

  it("propagates a provider refresh failure after observed absence", async () => {
    vi.spyOn(processRecovery, "executeSandboxExecCommand").mockReturnValue({
      status: 0,
      stdout: "absent",
      stderr: "",
    });
    const refreshAfterObservedAbsence = vi.fn(() => {
      throw new Error("provider refresh failed");
    });

    await expect(
      waitForAttachedMcpCredential(
        "alpha",
        {
          server: "github",
          agent: "openclaw",
          adapter: "openclaw-config",
          url: "https://mcp.example.test/mcp",
          env: ["GITHUB_TOKEN"],
          providerName: "alpha-mcp-github-0123456789abcdef",
          providerId: "11111111-2222-4333-8444-555555555555",
          policyName: "mcp-bridge-github",
        },
        runtimeSelection,
        { refreshAfterObservedAbsence },
      ),
    ).rejects.toThrow("provider refresh failed");
    expect(refreshAfterObservedAbsence).toHaveBeenCalledOnce();
  });

  it("does not accept a stale revision after the provider refresh", async () => {
    vi.stubEnv("NEMOCLAW_MCP_PROVIDER_SYNC_TIMEOUT_SECONDS", "1");
    const exec = vi
      .spyOn(processRecovery, "executeSandboxExecCommand")
      .mockReturnValueOnce({ status: 0, stdout: "absent", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "v11", stderr: "" });
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(1_000);
    const refreshAfterObservedAbsence = vi.fn();

    await expect(
      waitForAttachedMcpCredential(
        "alpha",
        {
          server: "github",
          agent: "openclaw",
          adapter: "openclaw-config",
          url: "https://mcp.example.test/mcp",
          env: ["GITHUB_TOKEN"],
          providerName: "alpha-mcp-github-0123456789abcdef",
          providerId: "11111111-2222-4333-8444-555555555555",
          policyName: "mcp-bridge-github",
        },
        runtimeSelection,
        { previousRevision: "v11", refreshAfterObservedAbsence },
      ),
    ).rejects.toThrow(
      /last bounded observation: v11; post-absence provider refresh attempted: yes/u,
    );
    expect(refreshAfterObservedAbsence).toHaveBeenCalledOnce();
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("fails detach verification when the strict OpenShell exec is unavailable", () => {
    vi.stubEnv("NEMOCLAW_MCP_PROVIDER_SYNC_TIMEOUT_SECONDS", "1");
    const exec = vi.spyOn(processRecovery, "executeSandboxExecCommand").mockReturnValue(null);
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(1_000);

    expect(() =>
      waitForDetachedMcpCredential(
        "alpha",
        {
          server: "github",
          agent: "openclaw",
          adapter: "openclaw-config",
          url: "https://mcp.example.test/mcp",
          env: ["GITHUB_TOKEN"],
          providerName: "alpha-mcp-github-0123456789abcdef",
          providerId: "11111111-2222-4333-8444-555555555555",
          policyName: "mcp-bridge-github",
        },
        runtimeSelection,
      ),
    ).toThrow(/did not confirm credential 'GITHUB_TOKEN' was revoked/);

    const proofCommand = exec.mock.calls[0]?.[1] ?? "";
    expect(proofCommand).toContain("GITHUB_TOKEN+x");
    expect(proofCommand).not.toContain("base64 -d");
    expect(exec).toHaveBeenCalledWith("alpha", proofCommand, undefined, {
      allowLocalDockerFallback: false,
      runtimeSelection,
    });
  });

  it("requires a changed credential revision after provider updates", async () => {
    const entry: McpSourceEntry = {
      server: "github",
      agent: "openclaw",
      adapter: "openclaw-config",
      url: "https://mcp.example.test/mcp",
      env: ["GITHUB_TOKEN"],
      providerName: "alpha-mcp-github-0123456789abcdef",
      providerId: "11111111-2222-4333-8444-555555555555",
      policyName: "mcp-bridge-github",
    };
    const exec = vi.spyOn(processRecovery, "executeSandboxExecCommand").mockReturnValue({
      status: 0,
      stdout: "v12",
      stderr: "",
    });

    await expect(
      waitForAttachedMcpCredential("alpha", entry, runtimeSelection, {
        previousRevision: "v11",
      }),
    ).resolves.toBe("v12");
    expect(exec).toHaveBeenCalledTimes(2);

    vi.stubEnv("NEMOCLAW_MCP_PROVIDER_SYNC_TIMEOUT_SECONDS", "1");
    exec.mockClear();
    exec.mockReturnValue({ status: 0, stdout: "v11", stderr: "" });
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(1_000);
    await expect(
      waitForAttachedMcpCredential("alpha", entry, runtimeSelection, {
        previousRevision: "v11",
      }),
    ).rejects.toThrow(/did not synchronize the expected credential revision/);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
