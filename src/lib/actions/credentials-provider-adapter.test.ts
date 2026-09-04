// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import readline from "node:readline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCliOpenShellProviderAdapter } from "../adapters/openshell/provider-adapter-cli";
import type {
  OpenShellProviderAdapter,
  OpenShellProviderError,
} from "../adapters/openshell/provider-adapter";
import { setGlobalCliActionRuntimeHooksForTest } from "./global";
import { runCredentialsAddAction } from "./credentials-add";
import { runCredentialsListAction } from "./credentials/list";
import { runCredentialsResetAction } from "./credentials/reset";

vi.mock("../onboard/gateway-teardown-authority", () => ({
  resolveGatewayCredentialMutationAuthority: vi.fn(() => ({})),
}));

vi.mock("../state/mcp-lifecycle-lock/credential-ownership", () => ({
  withMcpCredentialOwnershipLock: <T>(operation: () => Promise<T> | T) => operation(),
}));

vi.mock("../gateway-start-guidance", () => ({
  gatewayStartGuidance: () => "Start the gateway again with `nemoclaw onboard`.",
}));

function providerAdapter(
  overrides: Partial<OpenShellProviderAdapter> = {},
): OpenShellProviderAdapter {
  const listProviders: OpenShellProviderAdapter["listProviders"] = async () => ({
    ok: true,
    value: { names: [] },
  });
  const createProvider: OpenShellProviderAdapter["createProvider"] = async () => ({
    ok: true,
  });
  const getProvider: OpenShellProviderAdapter["getProvider"] = async (request) => ({
    ok: true,
    value: { name: request.providerName, type: "generic", credentialKeys: [], configKeys: [] },
  });
  const updateProvider: OpenShellProviderAdapter["updateProvider"] = async () => ({
    ok: true,
  });
  const importProviderProfile: OpenShellProviderAdapter["importProviderProfile"] = async () => ({
    ok: true,
  });
  const inspectProviderProfile: OpenShellProviderAdapter["inspectProviderProfile"] = async () => ({
    ok: true,
    value: { credentialKeys: [] },
  });
  const deleteProvider: OpenShellProviderAdapter["deleteProvider"] = async () => ({
    ok: true,
  });
  const detachProvider: OpenShellProviderAdapter["detachProvider"] = async () => ({
    ok: true,
  });
  return {
    listProviders: vi.fn(listProviders),
    createProvider: vi.fn(createProvider),
    getProvider: vi.fn(getProvider),
    updateProvider: vi.fn(updateProvider),
    importProviderProfile: vi.fn(importProviderProfile),
    inspectProviderProfile: vi.fn(inspectProviderProfile),
    deleteProvider: vi.fn(deleteProvider),
    detachProvider: vi.fn(detachProvider),
    ...overrides,
  };
}

describe("credential actions use typed OpenShell provider results", () => {
  beforeEach(() => {
    setGlobalCliActionRuntimeHooksForTest({
      recoverNamedGatewayRuntime: async () => ({ recovered: true }),
      recordExtraProvider: () => true,
      forgetExtraProvider: () => true,
      listManagedMcpCredentialReservations: () => [],
    });
  });

  afterEach(() => {
    setGlobalCliActionRuntimeHooksForTest({});
    vi.unstubAllEnvs();
  });

  it("registers validated credential material without returning its value (#9806)", async () => {
    vi.stubEnv("CUSTOM_TOKEN", "credential-value");
    const adapter = providerAdapter();

    const result = await runCredentialsAddAction(
      {
        provider: "custom-provider",
        type: "openai",
        credentials: ["CUSTOM_TOKEN"],
        configPairs: ["OPENAI_BASE_URL=https://93.184.216.34/v1"],
        fromExisting: false,
      },
      { providerAdapter: adapter },
    );

    expect(result.exitCode).toBe(0);
    expect(adapter.createProvider).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
      name: "custom-provider",
      type: "openai",
      credentials: [{ name: "CUSTOM_TOKEN", value: "credential-value" }],
      config: [{ key: "OPENAI_BASE_URL", value: "https://93.184.216.34/v1" }],
      fromExisting: false,
      timeoutMs: 30_000,
    });
    expect(JSON.stringify(result)).not.toContain("credential-value");
  });

  it("registers both Langfuse keys through the checked-in endpoint profile (#10840)", async () => {
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-lf-host-only");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-lf-host-only");
    let resolveImport: (() => void) | undefined;
    const importGate = new Promise<void>((resolve) => {
      resolveImport = resolve;
    });
    let importCompleted = false;
    const importProviderProfile = vi.fn(async () => {
      await importGate;
      importCompleted = true;
      return { ok: true as const };
    });
    const createProvider = vi.fn(async () => {
      expect(importCompleted).toBe(true);
      return { ok: true as const };
    });
    const adapter = providerAdapter({ importProviderProfile, createProvider });

    const resultPromise = runCredentialsAddAction(
      {
        provider: "my-hermes-langfuse",
        type: "langfuse-hermes-v1",
        credentials: ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"],
        configPairs: [],
        fromExisting: false,
      },
      { providerAdapter: adapter },
    );
    await vi.waitFor(() => expect(importProviderProfile).toHaveBeenCalledOnce());
    expect(createProvider).not.toHaveBeenCalled();
    resolveImport?.();
    const result = await resultPromise;

    expect(result.exitCode).toBe(0);
    expect(adapter.importProviderProfile).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
      profilePath: expect.stringMatching(/provider-profiles\/langfuse-hermes-v1\.yaml$/u),
      timeoutMs: 30_000,
    });
    expect(adapter.createProvider).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
      name: "my-hermes-langfuse",
      type: "langfuse-hermes-v1",
      credentials: [
        { name: "LANGFUSE_PUBLIC_KEY", value: "pk-lf-host-only" },
        { name: "LANGFUSE_SECRET_KEY", value: "sk-lf-host-only" },
      ],
      config: [],
      fromExisting: false,
      timeoutMs: 30_000,
    });
    expect(JSON.stringify(result)).not.toContain("pk-lf-host-only");
    expect(JSON.stringify(result)).not.toContain("sk-lf-host-only");
  });

  it("recommends a supported OpenAI base URL after rejecting a config key (#9806)", async () => {
    vi.stubEnv("CUSTOM_TOKEN", "host-only-value");
    const adapter = providerAdapter();

    const result = await runCredentialsAddAction(
      {
        provider: "custom-provider",
        type: "openai",
        credentials: ["CUSTOM_TOKEN"],
        configPairs: ["OPENAI-BASE-URL=https://93.184.216.34/v1"],
        fromExisting: false,
      },
      { providerAdapter: adapter },
    );

    expect(result.exitCode).toBe(1);
    expect(result.failureLines).toEqual([
      "  --config key must be alphanumeric / underscore (e.g. `--config OPENAI_BASE_URL=https://93.184.216.34/v1`).",
    ]);
    expect(adapter.createProvider).not.toHaveBeenCalled();
  });

  it.each([
    ["loopback IP literal", "http://127.0.0.1/v1"],
    ["link-local metadata IP literal", "http://169.254.169.254/latest"],
  ])("rejects an OpenAI base URL targeting a %s (#9806)", async (_case, baseUrl) => {
    vi.stubEnv("CUSTOM_TOKEN", "host-only-value");
    const adapter = providerAdapter();

    const result = await runCredentialsAddAction(
      {
        provider: "custom-provider",
        type: "openai",
        credentials: ["CUSTOM_TOKEN"],
        configPairs: [`OPENAI_BASE_URL=${baseUrl}`],
        fromExisting: false,
      },
      { providerAdapter: adapter },
    );

    expect(result.exitCode).toBe(1);
    expect(result.failureLines[0]).toBe(
      "  --config 'OPENAI_BASE_URL' failed endpoint security validation.",
    );
    expect(result.failureLines.join("\n")).toMatch(/private\/internal address/u);
    expect(JSON.stringify(result)).not.toContain("host-only-value");
    expect(adapter.importProviderProfile).not.toHaveBeenCalled();
    expect(adapter.createProvider).not.toHaveBeenCalled();
  });

  it("rejects a DNS OpenAI base URL before a later resolution can rebind (#9806)", async () => {
    vi.stubEnv("CUSTOM_TOKEN", "host-only-value");
    const adapter = providerAdapter();

    const result = await runCredentialsAddAction(
      {
        provider: "custom-provider",
        type: "openai",
        credentials: ["CUSTOM_TOKEN"],
        configPairs: ["OPENAI_BASE_URL=https://public-looking.example/v1"],
        fromExisting: false,
      },
      { providerAdapter: adapter },
    );

    expect(result.exitCode).toBe(1);
    expect(result.failureLines[0]).toBe(
      "  --config 'OPENAI_BASE_URL' accepts only a public IP-literal URL.",
    );
    expect(result.failureLines).toContain(
      "  DNS hostnames are not supported because OpenShell cannot enforce admission-time address pins for this credential-bearing path.",
    );
    expect(JSON.stringify(result)).not.toContain("host-only-value");
    expect(adapter.importProviderProfile).not.toHaveBeenCalled();
    expect(adapter.createProvider).not.toHaveBeenCalled();
  });

  it("rejects an untyped config value before provider creation (#9806)", async () => {
    vi.stubEnv("CUSTOM_TOKEN", "host-only-value");
    const adapter = providerAdapter();

    const result = await runCredentialsAddAction(
      {
        provider: "custom-provider",
        type: "generic",
        credentials: ["CUSTOM_TOKEN"],
        configPairs: ["region=ordinary-auth-value"],
        fromExisting: false,
      },
      { providerAdapter: adapter },
    );

    expect(result.exitCode).toBe(1);
    expect(result.failureLines).toContain(
      "  --config 'region' is not a supported non-secret setting for provider type 'generic'.",
    );
    expect(JSON.stringify(result)).not.toContain("ordinary-auth-value");
    expect(adapter.createProvider).not.toHaveBeenCalled();
  });

  it.each([
    ["userinfo", "https://user:password-value@example.test/v1"],
    ["query parameters", "https://example.test/v1?region=west"],
    ["a fragment", "https://example.test/v1#fragment-value"],
    ["a non-HTTP scheme", "file:///tmp/provider-value"],
  ])(
    "rejects an OpenAI base URL containing %s before provider creation (#9806)",
    async (_case, baseUrl) => {
      vi.stubEnv("CUSTOM_TOKEN", "host-only-value");
      const adapter = providerAdapter();

      const result = await runCredentialsAddAction(
        {
          provider: "custom-provider",
          type: "openai",
          credentials: ["CUSTOM_TOKEN"],
          configPairs: [`OPENAI_BASE_URL=${baseUrl}`],
          fromExisting: false,
        },
        { providerAdapter: adapter },
      );

      expect(result.exitCode).toBe(1);
      expect(result.failureLines).toContain(
        "  --config 'OPENAI_BASE_URL' must be an absolute HTTP(S) URL without credentials, query parameters, or a fragment.",
      );
      expect(JSON.stringify(result)).not.toContain(baseUrl);
      expect(adapter.createProvider).not.toHaveBeenCalled();
    },
  );

  it("imports the bundled OpenAI profile through the provider adapter (#9806)", async () => {
    vi.stubEnv("OPENAI_API_KEY", "host-only-value");
    const adapter = providerAdapter();

    const result = await runCredentialsAddAction(
      {
        provider: "openai-prod",
        type: "openai",
        credentials: ["OPENAI_API_KEY"],
        configPairs: [],
        fromExisting: false,
      },
      { providerAdapter: adapter },
    );

    expect(result.exitCode).toBe(0);
    expect(adapter.importProviderProfile).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
      profilePath: expect.stringMatching(/provider-profiles\/openai\.yaml$/u),
      timeoutMs: 30_000,
    });
    expect(adapter.createProvider).toHaveBeenCalledOnce();
  });

  it("canonicalizes a mixed-case bundled profile through provider creation (#9806)", async () => {
    const adapter = providerAdapter();

    const result = await runCredentialsAddAction(
      {
        provider: "openai-prod",
        type: "OpenAI",
        credentials: [],
        configPairs: [],
        fromExisting: true,
      },
      { providerAdapter: adapter },
    );

    expect(result.exitCode).toBe(0);
    expect(adapter.importProviderProfile).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
      profilePath: expect.stringMatching(/provider-profiles\/openai\.yaml$/u),
      timeoutMs: 30_000,
    });
    expect(adapter.inspectProviderProfile).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
      profileType: "openai",
      timeoutMs: 30_000,
    });
    expect(adapter.createProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "named", gatewayName: "nemoclaw" },
        type: "openai",
      }),
    );
  });

  it.each([
    {
      case: "timed out and a name-only inventory finds the provider",
      createError: {
        kind: "timeout",
        message: "The OpenShell provider operation timed out.",
      } as const,
      inventory: { ok: true, value: { names: ["custom-provider"] } } as const,
      expectedLines: [
        "  OpenShell reports a provider named 'custom-provider', but a name-only inventory cannot verify that this command created it.",
        "  Local provider ownership was not recorded.",
        "  Do not rebuild a sandbox from this result. Resolve the provider through a verified gateway operation, then retry.",
      ],
      forgetCalls: 1,
    },
    {
      case: "has no status and is confirmed present",
      createError: {
        kind: "command",
        reason: "uncertain",
        message: "OpenShell did not report whether the provider operation completed.",
      } as const,
      inventory: { ok: true, value: { names: ["custom-provider"] } } as const,
      expectedLines: [
        "  OpenShell reports a provider named 'custom-provider', but a name-only inventory cannot verify that this command created it.",
        "  Local provider ownership was not recorded.",
        "  Do not rebuild a sandbox from this result. Resolve the provider through a verified gateway operation, then retry.",
      ],
      forgetCalls: 1,
    },
    {
      case: "has no status and is confirmed absent",
      createError: {
        kind: "command",
        reason: "uncertain",
        message: "OpenShell did not report whether the provider operation completed.",
      } as const,
      inventory: { ok: true, value: { names: [] } } as const,
      expectedLines: ["  OpenShell confirms provider 'custom-provider' is absent."],
      forgetCalls: 1,
    },
    {
      case: "has no status and remains indeterminate",
      createError: {
        kind: "command",
        reason: "uncertain",
        message: "OpenShell did not report whether the provider operation completed.",
      } as const,
      inventory: {
        ok: false,
        error: { kind: "timeout", message: "The provider inventory query timed out." },
      } as const,
      expectedLines: [
        "  Could not determine whether provider 'custom-provider' was registered; local provider ownership was not recorded.",
        "  Do not rebuild a sandbox from this result. Resolve the provider through a verified gateway operation, then retry.",
      ],
      forgetCalls: 1,
    },
  ])("reconciles provider creation when the result $case (#9806)", async (testCase) => {
    vi.stubEnv("CUSTOM_TOKEN", "host-only-value");
    const forgetExtraProvider = vi.fn(() => true);
    setGlobalCliActionRuntimeHooksForTest({
      recoverNamedGatewayRuntime: async () => ({ recovered: true }),
      recordExtraProvider: () => true,
      forgetExtraProvider,
      listManagedMcpCredentialReservations: () => [],
    });
    const createProvider: OpenShellProviderAdapter["createProvider"] = async () => ({
      ok: false,
      error: testCase.createError,
    });
    const listProviders: OpenShellProviderAdapter["listProviders"] = async () => testCase.inventory;
    const adapter = providerAdapter({
      createProvider: vi.fn(createProvider),
      listProviders: vi.fn(listProviders),
    });

    const result = await runCredentialsAddAction(
      {
        provider: "custom-provider",
        type: "generic",
        credentials: ["CUSTOM_TOKEN"],
        configPairs: [],
        fromExisting: false,
      },
      { providerAdapter: adapter },
    );

    expect(result.exitCode).toBe(1);
    expect(adapter.listProviders).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
      timeoutMs: 30_000,
    });
    expect(result.failureLines).toEqual(expect.arrayContaining(testCase.expectedLines));
    expect(result.failureLines.join("\n")).not.toContain("<sandbox> rebuild");
    expect(forgetExtraProvider).toHaveBeenCalledTimes(testCase.forgetCalls);
  });

  it("does not create an OpenAI provider after profile import fails (#9806)", async () => {
    vi.stubEnv("OPENAI_API_KEY", "host-only-value");
    const importProviderProfile: OpenShellProviderAdapter["importProviderProfile"] = async () => ({
      ok: false,
      error: {
        kind: "command",
        reason: "profile_incompatible",
        message: "The OpenShell provider profile does not match the checked-in boundary.",
      },
    });
    const adapter = providerAdapter({ importProviderProfile: vi.fn(importProviderProfile) });

    const result = await runCredentialsAddAction(
      {
        provider: "openai-prod",
        type: "openai",
        credentials: ["OPENAI_API_KEY"],
        configPairs: [],
        fromExisting: false,
      },
      { providerAdapter: adapter },
    );

    expect(result.exitCode).toBe(1);
    expect(result.failureLines).toContain(
      "  OpenShell provider profile 'openai' does not match NemoClaw's checked-in credential boundary.",
    );
    expect(adapter.createProvider).not.toHaveBeenCalled();
  });

  it("does not create a provider from an incompatible bundled profile (#9806)", async () => {
    vi.stubEnv("TAVILY_API_KEY", "host-only-value");
    const importProviderProfile: OpenShellProviderAdapter["importProviderProfile"] = async () => ({
      ok: false,
      error: {
        kind: "command",
        reason: "profile_incompatible",
        message: "The OpenShell provider profile does not match the checked-in boundary.",
      },
    });
    const adapter = providerAdapter({ importProviderProfile: vi.fn(importProviderProfile) });

    const result = await runCredentialsAddAction(
      {
        provider: "tavily-prod",
        type: "tavily",
        credentials: ["TAVILY_API_KEY"],
        configPairs: [],
        fromExisting: false,
      },
      { providerAdapter: adapter },
    );

    expect(result.exitCode).toBe(1);
    expect(result.failureLines).toContain(
      "  OpenShell provider profile 'tavily' does not match NemoClaw's checked-in credential boundary.",
    );
    expect(adapter.createProvider).not.toHaveBeenCalled();
  });

  it.each([
    [
      "authentication",
      {
        kind: "authentication",
        message: "OpenShell could not authenticate the provider operation.",
      },
      ["  Restore OpenShell authentication for the selected gateway, then retry."],
    ],
    [
      "unreachable gateway",
      {
        kind: "transport",
        reason: "unreachable",
        message: "OpenShell could not reach the selected gateway.",
      },
      ["  Start the gateway again with `nemoclaw onboard`.", "  Then retry this command."],
    ],
    [
      "timeout",
      { kind: "timeout", message: "The OpenShell provider operation timed out." },
      ["  Confirm the selected OpenShell gateway is available, then retry."],
    ],
    [
      "schema mismatch",
      {
        kind: "schema",
        message: "The OpenShell CLI and gateway provider schemas do not match.",
      },
      ["  Update OpenShell with scripts/install-openshell.sh, then retry."],
    ],
    [
      "invalid bundled profile",
      {
        kind: "validation",
        message: "The checked-in OpenShell provider profile is invalid or unreadable.",
      },
      ["  Restore the bundled provider profile from this NemoClaw release, then retry."],
    ],
  ] satisfies ReadonlyArray<readonly [string, OpenShellProviderError, readonly string[]]>)(
    "gives actionable recovery for a typed %s profile import failure (#9806)",
    async (_case, error, recoveryLines) => {
      vi.stubEnv("OPENAI_API_KEY", "host-only-value");
      const importProviderProfile: OpenShellProviderAdapter["importProviderProfile"] =
        async () => ({
          ok: false,
          error,
        });
      const adapter = providerAdapter({ importProviderProfile: vi.fn(importProviderProfile) });

      const result = await runCredentialsAddAction(
        {
          provider: "openai-prod",
          type: "openai",
          credentials: ["OPENAI_API_KEY"],
          configPairs: [],
          fromExisting: false,
        },
        { providerAdapter: adapter },
      );

      expect(result.exitCode).toBe(1);
      expect(result.failureLines).toEqual([
        "  Could not import bundled provider profile 'openai'.",
        ...recoveryLines,
        `  ${error.message}`,
      ]);
      expect(adapter.createProvider).not.toHaveBeenCalled();
    },
  );

  it("does not create from existing credentials when profile identity is unverified (#9806)", async () => {
    const inspectProviderProfile: OpenShellProviderAdapter["inspectProviderProfile"] =
      async () => ({
        ok: false,
        error: {
          kind: "schema",
          message: "OpenShell returned an invalid provider profile.",
        },
      });
    const adapter = providerAdapter({ inspectProviderProfile: vi.fn(inspectProviderProfile) });

    const result = await runCredentialsAddAction(
      {
        provider: "custom-provider",
        type: "generic",
        credentials: [],
        configPairs: [],
        fromExisting: true,
      },
      { providerAdapter: adapter },
    );

    expect(result.exitCode).toBe(1);
    expect(result.failureLines).toContain(
      "  Refusing --from-existing because the provider profile credential keys could not be compared with managed MCP reservations.",
    );
    expect(result.failureLines).toContain("  OpenShell returned an invalid provider profile.");
    expect(adapter.inspectProviderProfile).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
      profileType: "generic",
      timeoutMs: 30_000,
    });
    expect(adapter.createProvider).not.toHaveBeenCalled();
  });

  it("creates from existing credentials when inspected keys do not overlap managed MCP reservations (#9806)", async () => {
    setGlobalCliActionRuntimeHooksForTest({
      recoverNamedGatewayRuntime: async () => ({ recovered: true }),
      recordExtraProvider: () => true,
      forgetExtraProvider: () => true,
      listManagedMcpCredentialReservations: () => [
        {
          sandboxName: "hermes",
          server: "maas-glean",
          credentialKeys: ["MAAS_GLEAN_TOKEN"],
        },
      ],
    });
    const inspectProviderProfile = vi.fn<OpenShellProviderAdapter["inspectProviderProfile"]>(
      async () => ({ ok: true, value: { credentialKeys: ["CUSTOM_TOKEN"] } }),
    );
    const adapter = providerAdapter({ inspectProviderProfile });

    const result = await runCredentialsAddAction(
      {
        provider: "custom-provider",
        type: "generic",
        credentials: [],
        configPairs: [],
        fromExisting: true,
      },
      { providerAdapter: adapter },
    );

    expect(result.exitCode).toBe(0);
    expect(adapter.inspectProviderProfile).toHaveBeenCalledOnce();
    expect(adapter.createProvider).toHaveBeenCalledOnce();
  });

  it("rejects existing credentials whose inspected key overlaps a managed MCP reservation (#9806)", async () => {
    setGlobalCliActionRuntimeHooksForTest({
      recoverNamedGatewayRuntime: async () => ({ recovered: true }),
      recordExtraProvider: () => true,
      forgetExtraProvider: () => true,
      listManagedMcpCredentialReservations: () => [
        {
          sandboxName: "hermes",
          server: "maas-glean",
          credentialKeys: ["MAAS_GLEAN_TOKEN"],
        },
      ],
    });
    const inspectProviderProfile = vi.fn<OpenShellProviderAdapter["inspectProviderProfile"]>(
      async () => ({ ok: true, value: { credentialKeys: ["MAAS_GLEAN_TOKEN"] } }),
    );
    const adapter = providerAdapter({ inspectProviderProfile });

    const result = await runCredentialsAddAction(
      {
        provider: "custom-provider",
        type: "generic",
        credentials: [],
        configPairs: [],
        fromExisting: true,
      },
      { providerAdapter: adapter },
    );

    expect(result.exitCode).toBe(1);
    expect(result.failureLines.join("\n")).toContain(
      "Credential key 'MAAS_GLEAN_TOKEN' is reserved by managed MCP server 'maas-glean' on sandbox 'hermes'",
    );
    expect(adapter.inspectProviderProfile).toHaveBeenCalledOnce();
    expect(adapter.createProvider).not.toHaveBeenCalled();
  });

  it("lists credentials separately from messaging bridge providers (#9806)", async () => {
    const listProviders: OpenShellProviderAdapter["listProviders"] = async () => ({
      ok: true,
      value: { names: ["alpha-telegram-bridge", "zeta", "alpha"] },
    });
    const adapter = providerAdapter({
      listProviders: vi.fn(listProviders),
    });

    const result = await runCredentialsListAction("nemoclaw", { providerAdapter: adapter });

    expect(result.exitCode).toBe(0);
    expect(adapter.listProviders).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
      timeoutMs: 30_000,
    });
    expect(result.outputLines).toContain("    alpha");
    expect(result.outputLines).toContain("    zeta");
    expect(result.outputLines.join("\n")).not.toContain("alpha-telegram-bridge");
    expect(result.outputLines).toContain("    Inspect: `nemoclaw <sandbox> channels list`");
    expect(result.outputLines).toContain(
      "    Retire and clear credentials: `nemoclaw <sandbox> channels remove <channel>`",
    );
    expect(result.outputLines).toContain(
      "    Pause without clearing credentials: `nemoclaw <sandbox> channels stop <channel>`",
    );
  });

  it.each([
    ["OSC control", "alpha\n\u001b]52;c;YXR0YWNr\u0007"],
    ["invalid name", "alpha\nbad/name"],
  ])("does not render an unsafe gateway provider inventory: %s (#9806)", async (_case, output) => {
    const adapter = createCliOpenShellProviderAdapter({
      run: () => ({ status: 0, stdout: output }),
    });

    const result = await runCredentialsListAction("nemoclaw", { providerAdapter: adapter });

    expect(result.exitCode).toBe(1);
    expect(result.failureLines).toContain("  OpenShell returned an invalid provider inventory.");
    expect(result.outputLines).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(output);
  });

  it("does not render terminal control strings from provider failures (#9806)", async () => {
    vi.stubEnv("CUSTOM_TOKEN", "host-only-value");
    const adapter = createCliOpenShellProviderAdapter({
      run: () => ({
        status: 1,
        stderr: "provider rejected \u001b]52;c;osc-payload\u0007\u001bP+dcs-payload\u001b\\request",
      }),
    });

    const results = [
      await runCredentialsAddAction(
        {
          provider: "custom-provider",
          type: "generic",
          credentials: ["CUSTOM_TOKEN"],
          configPairs: [],
          fromExisting: false,
        },
        { providerAdapter: adapter },
      ),
      await runCredentialsListAction("nemoclaw", { providerAdapter: adapter }),
      await runCredentialsResetAction(
        { provider: "custom-provider", confirmed: true },
        { providerAdapter: adapter },
      ),
    ];

    expect(JSON.stringify(results)).not.toMatch(/[\u001B\u0090-\u009F]/u);
    expect(JSON.stringify(results)).not.toContain("payload");
  });

  it.each([
    ["authentication", "OpenShell could not authenticate the provider operation.", null, undefined],
    ["schema", "The OpenShell CLI and gateway provider schemas do not match.", null, undefined],
    ["timeout", "The OpenShell provider operation timed out.", null, undefined],
    ["command", "OpenShell rejected the provider query.", null, undefined],
    ["transport", "OpenShell could not start the provider operation.", null, "process_start"],
    [
      "transport",
      "The selected OpenShell gateway identity does not match the recorded identity.",
      null,
      "identity_mismatch",
    ],
    [
      "transport",
      "OpenShell could not reach the selected gateway.",
      "Start the gateway again with `nemoclaw onboard`.",
      "unreachable",
    ],
  ] as const)(
    "uses the typed %s provider-list failure for recovery guidance (#9806)",
    async (kind, message, expectedGuidance, reason) => {
      const listProviders: OpenShellProviderAdapter["listProviders"] = async () => ({
        ok: false,
        error:
          kind === "command"
            ? { kind, reason: "failed", message }
            : kind === "transport"
              ? { kind, reason, message }
              : { kind, message },
      });
      const adapter = providerAdapter({ listProviders: vi.fn(listProviders) });

      const result = await runCredentialsListAction("nemoclaw", { providerAdapter: adapter });
      const failure = result.failureLines.join("\n");

      expect(result.exitCode).toBe(1);
      expect(failure).toContain(message);
      expect(result.failureLines).toEqual([
        "  Could not query OpenShell providers on gateway 'nemoclaw'.",
        `  ${message}`,
        ...(expectedGuidance ? [`  ${expectedGuidance}`] : []),
      ]);
    },
  );

  it("rejects an invalid reset provider before prompting or gateway mutation (#9806)", async () => {
    const recoverNamedGatewayRuntime = vi.fn(async () => ({ recovered: true }));
    setGlobalCliActionRuntimeHooksForTest({
      recoverNamedGatewayRuntime,
      recordExtraProvider: () => true,
      forgetExtraProvider: () => true,
      listManagedMcpCredentialReservations: () => [],
    });
    const promptSpy = vi.spyOn(readline, "createInterface").mockImplementation(() => {
      throw new Error("credentials reset prompted for an invalid provider name");
    });
    const adapter = providerAdapter();

    try {
      const result = await runCredentialsResetAction(
        { provider: "bad name/with*chars", confirmed: false },
        { providerAdapter: adapter },
      );

      expect(result).toEqual({
        exitCode: 1,
        outputLines: [],
        failureLines: [
          "  Provider name must be 1-128 chars, start with a letter, and use only letters, digits, '.', '_', or '-'.",
        ],
      });
      expect(promptSpy).not.toHaveBeenCalled();
      expect(recoverNamedGatewayRuntime).not.toHaveBeenCalled();
      expect(adapter.deleteProvider).not.toHaveBeenCalled();
    } finally {
      promptSpy.mockRestore();
    }
  });

  it("preserves detach-before-delete recovery with typed failures (#9806)", async () => {
    const operations: string[] = [];
    const deleteProvider = vi
      .fn<OpenShellProviderAdapter["deleteProvider"]>()
      .mockImplementationOnce(async () => {
        operations.push("delete:first");
        return {
          ok: false,
          error: {
            kind: "command",
            reason: "attached",
            message: "provider remains attached",
            attachedSandboxes: ["alpha"],
          },
        };
      })
      .mockImplementationOnce(async () => {
        operations.push("delete:retry");
        return { ok: true };
      });
    const detachProvider = vi.fn<OpenShellProviderAdapter["detachProvider"]>(async () => {
      operations.push("detach:alpha");
      return { ok: true };
    });
    const adapter = providerAdapter({ deleteProvider, detachProvider });

    const result = await runCredentialsResetAction(
      { provider: "custom-provider", confirmed: true },
      { providerAdapter: adapter },
    );

    expect(result.exitCode).toBe(0);
    expect(operations).toEqual(["delete:first", "detach:alpha", "delete:retry"]);
    expect(detachProvider).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
      providerName: "custom-provider",
      sandboxName: "alpha",
      timeoutMs: 30_000,
    });
    expect(deleteProvider).toHaveBeenNthCalledWith(1, {
      target: { kind: "named", gatewayName: "nemoclaw" },
      providerName: "custom-provider",
      timeoutMs: 30_000,
    });
    expect(deleteProvider).toHaveBeenNthCalledWith(2, {
      target: { kind: "named", gatewayName: "nemoclaw" },
      providerName: "custom-provider",
      timeoutMs: 30_000,
    });
    expect(result.outputLines).toContain(
      "  Provider 'custom-provider' was detached from sandbox(es): alpha during removal.",
    );
    expect(result.outputLines).toContain("    nemoclaw alpha rebuild");
  });

  it("reports recovery for sandboxes detached before final deletion fails (#9806)", async () => {
    const deleteProvider = vi
      .fn<OpenShellProviderAdapter["deleteProvider"]>()
      .mockResolvedValueOnce({
        ok: false,
        error: {
          kind: "command",
          reason: "attached",
          message: "provider remains attached",
          attachedSandboxes: ["alpha", "beta"],
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: {
          kind: "transport",
          reason: "unreachable",
          message: "OpenShell could not reach the selected gateway.",
        },
      });
    const detachProvider = vi.fn<OpenShellProviderAdapter["detachProvider"]>(async () => ({
      ok: true,
    }));
    const adapter = providerAdapter({ deleteProvider, detachProvider });

    const result = await runCredentialsResetAction(
      { provider: "custom-provider", confirmed: true },
      { providerAdapter: adapter },
    );

    const failure = result.failureLines.join("\n");
    expect(result.exitCode).toBe(1);
    expect(failure).toContain(
      "Provider 'custom-provider' was detached from sandbox(es): alpha, beta, but provider removal was not confirmed.",
    );
    expect(failure).toContain(
      "Rerun 'nemoclaw credentials reset custom-provider' to complete provider removal.",
    );
    expect(failure).toContain("nemoclaw alpha rebuild");
    expect(failure).toContain("nemoclaw beta rebuild");
  });

  it("reports the typed detach failure that blocks provider removal (#9806)", async () => {
    const deleteProvider = vi
      .fn<OpenShellProviderAdapter["deleteProvider"]>()
      .mockResolvedValueOnce({
        ok: false,
        error: {
          kind: "command",
          reason: "attached",
          message: "provider remains attached",
          attachedSandboxes: ["alpha"],
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "command", reason: "failed", message: "provider deletion failed" },
      });
    const detachProvider = vi.fn<OpenShellProviderAdapter["detachProvider"]>(async () => ({
      ok: false,
      error: {
        kind: "authentication",
        message: "OpenShell could not authenticate the provider operation.",
      },
    }));
    const adapter = providerAdapter({ deleteProvider, detachProvider });

    const result = await runCredentialsResetAction(
      { provider: "custom-provider", confirmed: true },
      { providerAdapter: adapter },
    );

    expect(result.exitCode).toBe(1);
    expect(result.failureLines).toContain(
      "  Could not detach provider 'custom-provider' from sandbox 'alpha': OpenShell could not authenticate the provider operation.",
    );
    expect(result.failureLines).toContain("  provider deletion failed");
  });

  it("reports rebuild guidance when final deletion succeeds after a concurrent detach (#9806)", async () => {
    const deleteProvider = vi
      .fn<OpenShellProviderAdapter["deleteProvider"]>()
      .mockResolvedValueOnce({
        ok: false,
        error: {
          kind: "command",
          reason: "attached",
          message: "provider remains attached",
          attachedSandboxes: ["alpha"],
        },
      })
      .mockResolvedValueOnce({ ok: true });
    const detachProvider = vi.fn<OpenShellProviderAdapter["detachProvider"]>(async () => ({
      ok: false,
      error: { kind: "command", reason: "failed", message: "detach raced" },
    }));
    const adapter = providerAdapter({ deleteProvider, detachProvider });

    const result = await runCredentialsResetAction(
      { provider: "custom-provider", confirmed: true },
      { providerAdapter: adapter },
    );

    expect(result.exitCode).toBe(0);
    expect(result.outputLines).toContain(
      "  Provider 'custom-provider' was detached from sandbox(es): alpha during removal.",
    );
    expect(result.outputLines).toContain("    nemoclaw alpha rebuild");
    expect(detachProvider).toHaveBeenCalledOnce();
  });

  it("cleans local state when concurrent deletion settles detach recovery (#9806)", async () => {
    const forgetExtraProvider = vi.fn(() => true);
    setGlobalCliActionRuntimeHooksForTest({
      recoverNamedGatewayRuntime: async () => ({ recovered: true }),
      recordExtraProvider: () => true,
      forgetExtraProvider,
      listManagedMcpCredentialReservations: () => [],
    });
    const deleteProvider = vi
      .fn<OpenShellProviderAdapter["deleteProvider"]>()
      .mockResolvedValueOnce({
        ok: false,
        error: {
          kind: "command",
          reason: "attached",
          message: "provider remains attached",
          attachedSandboxes: ["alpha"],
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "command", reason: "not_found", message: "provider not found" },
      });
    const detachProvider = vi.fn<OpenShellProviderAdapter["detachProvider"]>(async () => ({
      ok: false,
      error: {
        kind: "authentication",
        message: "OpenShell could not authenticate the provider operation.",
      },
    }));
    const adapter = providerAdapter({ deleteProvider, detachProvider });

    const result = await runCredentialsResetAction(
      { provider: "custom-provider", confirmed: true },
      { providerAdapter: adapter },
    );

    expect(result.exitCode).toBe(0);
    expect(result.outputLines).toContain(
      "  Provider 'custom-provider' is already absent from the OpenShell gateway. Local state was cleaned up.",
    );
    expect(result.outputLines.join("\n")).not.toContain("Detach it with");
    expect(detachProvider).toHaveBeenCalledOnce();
    expect(forgetExtraProvider).toHaveBeenCalledWith("custom-provider");
  });

  it("reports rebuild guidance when concurrent deletion follows a successful detach (#9806)", async () => {
    const forgetExtraProvider = vi.fn(() => true);
    setGlobalCliActionRuntimeHooksForTest({
      recoverNamedGatewayRuntime: async () => ({ recovered: true }),
      recordExtraProvider: () => true,
      forgetExtraProvider,
      listManagedMcpCredentialReservations: () => [],
    });
    const deleteProvider = vi
      .fn<OpenShellProviderAdapter["deleteProvider"]>()
      .mockResolvedValueOnce({
        ok: false,
        error: {
          kind: "command",
          reason: "attached",
          message: "provider remains attached",
          attachedSandboxes: ["alpha"],
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "command", reason: "not_found", message: "provider not found" },
      });
    const detachProvider = vi.fn<OpenShellProviderAdapter["detachProvider"]>(async () => ({
      ok: true,
    }));
    const adapter = providerAdapter({ deleteProvider, detachProvider });

    const result = await runCredentialsResetAction(
      { provider: "custom-provider", confirmed: true },
      { providerAdapter: adapter },
    );

    expect(result.exitCode).toBe(0);
    expect(result.outputLines).toContain(
      "  Provider 'custom-provider' is already absent from the OpenShell gateway. Local state was cleaned up.",
    );
    expect(result.outputLines).toContain(
      "  Provider 'custom-provider' was detached from sandbox(es): alpha during removal.",
    );
    expect(result.outputLines).toContain("    nemoclaw alpha rebuild");
    expect(detachProvider).toHaveBeenCalledOnce();
    expect(forgetExtraProvider).toHaveBeenCalledWith("custom-provider");
  });

  it("does not report rebuild guidance when the provider disappears before detach (#9806)", async () => {
    const forgetExtraProvider = vi.fn(() => true);
    setGlobalCliActionRuntimeHooksForTest({
      recoverNamedGatewayRuntime: async () => ({ recovered: true }),
      recordExtraProvider: () => true,
      forgetExtraProvider,
      listManagedMcpCredentialReservations: () => [],
    });
    const deleteProvider = vi
      .fn<OpenShellProviderAdapter["deleteProvider"]>()
      .mockResolvedValueOnce({
        ok: false,
        error: {
          kind: "command",
          reason: "attached",
          message: "provider remains attached",
          attachedSandboxes: ["alpha"],
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "command", reason: "not_found", message: "provider not found" },
      });
    const detachProvider = vi.fn<OpenShellProviderAdapter["detachProvider"]>(async () => ({
      ok: false,
      error: { kind: "command", reason: "not_found", message: "provider not found" },
    }));
    const adapter = providerAdapter({ deleteProvider, detachProvider });

    const result = await runCredentialsResetAction(
      { provider: "custom-provider", confirmed: true },
      { providerAdapter: adapter },
    );

    expect(result.exitCode).toBe(0);
    expect(result.outputLines).toContain(
      "  Provider 'custom-provider' is already absent from the OpenShell gateway. Local state was cleaned up.",
    );
    expect(result.outputLines.join("\n")).not.toContain("was detached from sandbox");
    expect(result.outputLines.join("\n")).not.toContain("nemoclaw alpha rebuild");
    expect(detachProvider).toHaveBeenCalledOnce();
    expect(forgetExtraProvider).toHaveBeenCalledWith("custom-provider");
  });

  it("reports final attachments after successful detach recovery (#9806)", async () => {
    const deleteProvider = vi
      .fn<OpenShellProviderAdapter["deleteProvider"]>()
      .mockResolvedValueOnce({
        ok: false,
        error: {
          kind: "command",
          reason: "attached",
          message: "provider remains attached",
          attachedSandboxes: ["alpha"],
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: {
          kind: "command",
          reason: "attached",
          message: "provider has a new attachment",
          attachedSandboxes: ["beta"],
        },
      });
    const detachProvider = vi.fn<OpenShellProviderAdapter["detachProvider"]>(async () => ({
      ok: true,
    }));
    const adapter = providerAdapter({ deleteProvider, detachProvider });

    const result = await runCredentialsResetAction(
      { provider: "custom-provider", confirmed: true },
      { providerAdapter: adapter },
    );

    expect(result.exitCode).toBe(1);
    expect(result.failureLines).toContain(
      "  'custom-provider' is still attached to sandbox(es): beta.",
    );
    expect(result.failureLines).toContain(
      "    openshell sandbox provider detach -g nemoclaw beta custom-provider",
    );
    expect(result.failureLines).toContain(
      "  Then rerun 'nemoclaw credentials reset custom-provider'.",
    );
  });

  it.each([
    ["absent", undefined],
    ["empty", []],
  ] as const)(
    "does not detach an unvalidated %s attachment list (#9806)",
    async (_label, attachedSandboxes) => {
      const deleteProvider = vi.fn<OpenShellProviderAdapter["deleteProvider"]>().mockResolvedValue({
        ok: false,
        error: {
          kind: "command",
          reason: "attached",
          message: "provider remains attached",
          ...(attachedSandboxes ? { attachedSandboxes: [...attachedSandboxes] } : {}),
        },
      });
      const detachProvider = vi.fn<OpenShellProviderAdapter["detachProvider"]>();
      const adapter = providerAdapter({ deleteProvider, detachProvider });

      const result = await runCredentialsResetAction(
        { provider: "custom-provider", confirmed: true },
        { providerAdapter: adapter },
      );

      expect(result.exitCode).toBe(1);
      expect(deleteProvider).toHaveBeenCalledOnce();
      expect(detachProvider).not.toHaveBeenCalled();
    },
  );

  it("does not partially detach a mixed valid and invalid attachment list (#9806)", async () => {
    const deleteProvider = vi.fn<OpenShellProviderAdapter["deleteProvider"]>().mockResolvedValue({
      ok: false,
      error: {
        kind: "command",
        reason: "attached",
        message: "provider remains attached",
        attachedSandboxes: ["alpha", "team.alpha"],
      },
    });
    const detachProvider = vi.fn<OpenShellProviderAdapter["detachProvider"]>();
    const adapter = providerAdapter({ deleteProvider, detachProvider });

    const result = await runCredentialsResetAction(
      { provider: "custom-provider", confirmed: true },
      { providerAdapter: adapter },
    );

    expect(result.exitCode).toBe(1);
    expect(deleteProvider).toHaveBeenCalledOnce();
    expect(detachProvider).not.toHaveBeenCalled();
  });
});
