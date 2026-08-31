// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import { MESSAGING_CREDENTIAL_PROVIDER_TYPE } from "../../messaging/provider-profile";
import {
  attachProvidersAfterSandboxCreation,
  publishAttachedProvidersBeforeDockerSandboxCreation,
  validateAttachedMessagingProvidersBeforeSandboxCreation,
} from "./provider-publication";

type ProviderState = {
  type: string;
  credentialKey: string;
  configKeys: string;
};

const providerName = "my-assistant-telegram-bridge";
const exactState: ProviderState = {
  type: MESSAGING_CREDENTIAL_PROVIDER_TYPE,
  credentialKey: "TELEGRAM_BOT_TOKEN",
  configKeys: "<none>",
};
const exactProfile = {
  status: 0,
  stdout: JSON.stringify({
    id: MESSAGING_CREDENTIAL_PROVIDER_TYPE,
    credentials: [],
    endpoints: [],
    binaries: [],
    inference_capable: false,
  }),
  stderr: "",
};

function typedProviderAdapter(
  overrides: Partial<OpenShellProviderAdapter> = {},
): OpenShellProviderAdapter {
  const adapter: OpenShellProviderAdapter = {
    listProviders: vi.fn(async () => ({ ok: true as const, value: { names: [] } })),
    createProvider: vi.fn(async () => ({
      ok: true as const,
      value: { state: "created" as const },
    })),
    getProvider: vi.fn(async (request: Parameters<OpenShellProviderAdapter["getProvider"]>[0]) => ({
      ok: true as const,
      value: { name: request.providerName, type: "openai", credentialKeys: [], configKeys: [] },
    })),
    updateProvider: vi.fn(async () => ({
      ok: true as const,
      value: { state: "updated" as const },
    })),
    importProviderProfile: vi.fn(async () => ({
      ok: true as const,
      value: { state: "imported" as const },
    })),
    ensureEndpointlessProviderProfile: vi.fn(async () => ({
      ok: true as const,
      value: { state: "ready" as const },
    })),
    inspectProviderProfile: vi.fn(async () => ({
      ok: true as const,
      value: { credentialKeys: [] },
    })),
    deleteProvider: vi.fn(async () => ({
      ok: true as const,
      value: { state: "deleted" as const },
    })),
    detachProvider: vi.fn(async () => ({
      ok: true as const,
      value: { state: "detached" as const },
    })),
  };
  return { ...adapter, ...overrides };
}

function providerOutput(name: string, state: ProviderState): string {
  return [
    `Name: ${name}`,
    `Type: ${state.type}`,
    `Credential keys: ${state.credentialKey}`,
    `Config keys: ${state.configKeys}`,
    "",
  ].join("\n");
}

function createHarness(
  initialState: ProviderState | null = exactState,
  postUpdateState: ProviderState = initialState || exactState,
  profileImportResult = { status: 0, stdout: "", stderr: "" },
  profileExportResult = exactProfile,
) {
  let updated = false;
  const cleanupCreateSources = vi.fn();
  const runOpenshell = vi.fn((args: string[]) => {
    switch (`${args[0]} ${args[1]}`) {
      case "provider profile":
        return args.includes("import") ? profileImportResult : profileExportResult;
      case "provider get":
        return initialState
          ? {
              status: 0,
              stdout: providerOutput(args.at(-1) || "", updated ? postUpdateState : initialState),
            }
          : { status: 2, stderr: "transport unavailable" };
      case "provider update":
        updated = true;
        return { status: 0 };
      default:
        return { status: 0 };
    }
  });

  return {
    cleanupCreateSources,
    runOpenshell,
    deps: {
      cleanupCreateSources,
      runOpenshell,
    } as unknown as Parameters<typeof publishAttachedProvidersBeforeDockerSandboxCreation>[1],
  };
}

function publicationInput(
  overrides: Partial<
    Parameters<typeof publishAttachedProvidersBeforeDockerSandboxCreation>[0]
  > = {},
): Parameters<typeof publishAttachedProvidersBeforeDockerSandboxCreation>[0] {
  return {
    openshellDriver: "docker",
    inferenceProvider: null,
    messagingProviders: [providerName],
    messagingProviderRequests: [
      {
        name: providerName,
        envKey: "TELEGRAM_BOT_TOKEN",
        providerType: MESSAGING_CREDENTIAL_PROVIDER_TYPE,
        credentialConfigured: false,
        channel: "telegram",
      },
    ],
    extraProviders: [],
    gatewayName: "nemoclaw",
    ...overrides,
  };
}

async function prepareProviders(
  input: Parameters<typeof publishAttachedProvidersBeforeDockerSandboxCreation>[0],
  deps: Parameters<typeof publishAttachedProvidersBeforeDockerSandboxCreation>[1],
): Promise<void> {
  await validateAttachedMessagingProvidersBeforeSandboxCreation(input, deps);
  await publishAttachedProvidersBeforeDockerSandboxCreation(input, deps);
}

describe("sandbox provider preparation", () => {
  it("refuses name-addressed deferred provider attachment before mutation (#9833)", () => {
    expect(() =>
      attachProvidersAfterSandboxCreation({
        sandboxName: "alpha",
        gatewayName: "nemoclaw",
        providerNames: ["inference", "alpha-telegram"],
      }),
    ).toThrow("OpenShell cannot attach providers to the immutable identity of sandbox 'alpha'");
  });

  it("allows an empty deferred attachment set without a mutable-name operation (#9833)", () => {
    expect(() =>
      attachProvidersAfterSandboxCreation({
        sandboxName: "alpha",
        gatewayName: "nemoclaw",
        providerNames: [],
      }),
    ).not.toThrow();
  });

  it("confirms an exact messaging binding before and after publication (#9875)", async () => {
    const harness = createHarness();

    await prepareProviders(publicationInput(), harness.deps);

    expect(harness.runOpenshell.mock.calls.map(([args]) => args)).toEqual([
      [
        "provider",
        "profile",
        "-g",
        "nemoclaw",
        "export",
        MESSAGING_CREDENTIAL_PROVIDER_TYPE,
        "--output",
        "json",
      ],
      ["provider", "get", "-g", "nemoclaw", providerName],
      ["provider", "update", "-g", "nemoclaw", providerName],
      ["provider", "get", "-g", "nemoclaw", providerName],
    ]);
    expect(harness.cleanupCreateSources).not.toHaveBeenCalled();
  });

  it.each<{ case: string; state: ProviderState | null }>([
    {
      case: "generic provider type",
      state: { ...exactState, type: "generic" },
    },
    {
      case: "wrong credential key",
      state: { ...exactState, credentialKey: "WRONG_TOKEN" },
    },
    {
      case: "non-empty configuration",
      state: { ...exactState, configKeys: "UNEXPECTED_CONFIG" },
    },
    {
      case: "canonical probe ambiguity",
      state: null,
    },
  ])("rejects $case before publication (#9875)", async ({ state }) => {
    const harness = createHarness(state);

    await expect(prepareProviders(publicationInput(), harness.deps)).rejects.toThrowError(
      `OpenShell did not confirm messaging provider '${providerName}' before sandbox creation.`,
    );
    expect(harness.runOpenshell).toHaveBeenCalledTimes(2);
    expect(harness.cleanupCreateSources).toHaveBeenCalledOnce();
  });

  it("rejects a messaging binding that changes during publication (#9875)", async () => {
    const harness = createHarness(exactState, { ...exactState, type: "generic" });

    await expect(prepareProviders(publicationInput(), harness.deps)).rejects.toThrowError(
      `OpenShell did not confirm messaging provider '${providerName}' after publication.`,
    );
    expect(harness.runOpenshell.mock.calls.map(([args]) => args)).toEqual([
      [
        "provider",
        "profile",
        "-g",
        "nemoclaw",
        "export",
        MESSAGING_CREDENTIAL_PROVIDER_TYPE,
        "--output",
        "json",
      ],
      ["provider", "get", "-g", "nemoclaw", providerName],
      ["provider", "update", "-g", "nemoclaw", providerName],
      ["provider", "get", "-g", "nemoclaw", providerName],
    ]);
    expect(harness.cleanupCreateSources).toHaveBeenCalledOnce();
  });

  it("preserves publication for providers outside the credential profile (#9875)", async () => {
    const harness = createHarness();
    const arbitraryProvider = "operator-provider";

    await prepareProviders(
      publicationInput({
        messagingProviders: [],
        messagingProviderRequests: [],
        extraProviders: [arbitraryProvider],
      }),
      harness.deps,
    );

    expect(harness.runOpenshell.mock.calls.map(([args]) => args)).toEqual([
      ["provider", "update", "-g", "nemoclaw", arbitraryProvider],
    ]);
    expect(harness.cleanupCreateSources).not.toHaveBeenCalled();
  });

  it("publishes an existing inference provider through the typed adapter (#9806)", async () => {
    const adapter = typedProviderAdapter();
    const cleanupCreateSources = vi.fn();
    const runOpenshell = vi.fn(() => {
      throw new Error("raw provider CLI must stay behind the adapter");
    });

    await publishAttachedProvidersBeforeDockerSandboxCreation(
      publicationInput({
        inferenceProvider: "inference",
        messagingProviders: [],
        messagingProviderRequests: [],
      }),
      { cleanupCreateSources, providerAdapter: adapter, runOpenshell: runOpenshell as never },
    );

    expect(adapter.getProvider).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
      providerName: "inference",
    });
    expect(adapter.updateProvider).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
      providerName: "inference",
      credentials: [],
      config: [],
    });
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(cleanupCreateSources).not.toHaveBeenCalled();
  });

  it("cleans up when the typed provider update fails (#9806)", async () => {
    const updateProvider: OpenShellProviderAdapter["updateProvider"] = vi.fn(async () => ({
      ok: false as const,
      error: {
        kind: "command" as const,
        reason: "failed" as const,
        message: "OpenShell could not update the selected provider.",
      },
    }));
    const adapter = typedProviderAdapter({ updateProvider });
    const cleanupCreateSources = vi.fn();

    await expect(
      publishAttachedProvidersBeforeDockerSandboxCreation(
        publicationInput({
          inferenceProvider: "inference",
          messagingProviders: [],
          messagingProviderRequests: [],
        }),
        {
          cleanupCreateSources,
          providerAdapter: adapter,
          runOpenshell: vi.fn() as never,
        },
      ),
    ).rejects.toThrowError(
      "OpenShell did not publish attached provider 'inference' before Docker sandbox creation.",
    );
    expect(cleanupCreateSources).toHaveBeenCalledOnce();
  });

  it("skips publication when the typed lookup reports absence (#9806)", async () => {
    const getProvider: OpenShellProviderAdapter["getProvider"] = vi.fn(async () => ({
      ok: false as const,
      error: {
        kind: "command" as const,
        reason: "not_found" as const,
        message: "OpenShell provider 'inference' was not found.",
      },
    }));
    const adapter = typedProviderAdapter({ getProvider });

    await publishAttachedProvidersBeforeDockerSandboxCreation(
      publicationInput({
        inferenceProvider: "inference",
        messagingProviders: [],
        messagingProviderRequests: [],
      }),
      {
        cleanupCreateSources: vi.fn(),
        providerAdapter: adapter,
        runOpenshell: vi.fn() as never,
      },
    );

    expect(adapter.updateProvider).not.toHaveBeenCalled();
  });

  it("preserves the optional publication skip for a typed lookup failure (#9806)", async () => {
    const getProvider: OpenShellProviderAdapter["getProvider"] = vi.fn(async () => ({
      ok: false as const,
      error: {
        kind: "transport" as const,
        reason: "unreachable" as const,
        message: "OpenShell could not reach the selected gateway.",
      },
    }));
    const adapter = typedProviderAdapter({ getProvider });
    const cleanupCreateSources = vi.fn();

    await publishAttachedProvidersBeforeDockerSandboxCreation(
      publicationInput({
        inferenceProvider: "inference",
        messagingProviders: [],
        messagingProviderRequests: [],
      }),
      {
        cleanupCreateSources,
        providerAdapter: adapter,
        runOpenshell: vi.fn() as never,
      },
    );
    expect(adapter.updateProvider).not.toHaveBeenCalled();
    expect(cleanupCreateSources).not.toHaveBeenCalled();
  });

  it("rejects an incompatible messaging binding before a portable Hermes create (#9875)", async () => {
    const harness = createHarness({ ...exactState, type: "generic" });

    await expect(
      validateAttachedMessagingProvidersBeforeSandboxCreation(
        publicationInput({ openshellDriver: "native" }),
        harness.deps,
      ),
    ).rejects.toThrowError(`OpenShell did not confirm messaging provider '${providerName}'`);
    expect(harness.runOpenshell).toHaveBeenCalledTimes(2);
    expect(harness.cleanupCreateSources).toHaveBeenCalledOnce();
  });

  it("rejects an incompatible global messaging profile before provider adoption (#9875)", async () => {
    const harness = createHarness(
      exactState,
      exactState,
      { status: 1, stdout: "", stderr: "profile already exists" },
      {
        status: 0,
        stdout: JSON.stringify({
          id: MESSAGING_CREDENTIAL_PROVIDER_TYPE,
          credentials: [],
          endpoints: ["https://foreign.invalid"],
          binaries: [],
          inference_capable: false,
        }),
        stderr: "",
      },
    );

    await expect(
      validateAttachedMessagingProvidersBeforeSandboxCreation(publicationInput(), harness.deps),
    ).rejects.toThrowError(/does not match NemoClaw's endpointless messaging credential contract/u);
    expect(
      harness.runOpenshell.mock.calls.some(([args]) =>
        args.join(" ").startsWith("provider profile -g nemoclaw export"),
      ),
    ).toBe(true);
    expect(
      harness.runOpenshell.mock.calls.some(([args]) =>
        args.join(" ").startsWith("provider profile -g nemoclaw import"),
      ),
    ).toBe(false);
    expect(
      harness.runOpenshell.mock.calls.some(
        ([args]) => args.slice(0, 2).join(" ") === "provider update",
      ),
    ).toBe(false);
    expect(harness.cleanupCreateSources).toHaveBeenCalledOnce();
  });
});
