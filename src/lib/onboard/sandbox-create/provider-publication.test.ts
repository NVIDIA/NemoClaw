// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

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
  const providerExistsInGateway = vi.fn(() => true);
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
    providerExistsInGateway,
    runOpenshell,
    deps: {
      cleanupCreateSources,
      providerExistsInGateway,
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

function prepareProviders(
  input: Parameters<typeof publishAttachedProvidersBeforeDockerSandboxCreation>[0],
  deps: Parameters<typeof publishAttachedProvidersBeforeDockerSandboxCreation>[1],
): void {
  validateAttachedMessagingProvidersBeforeSandboxCreation(input, deps);
  publishAttachedProvidersBeforeDockerSandboxCreation(input, deps);
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

  it("confirms an exact messaging binding before and after publication (#9875)", () => {
    const harness = createHarness();

    prepareProviders(publicationInput(), harness.deps);

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
    expect(harness.providerExistsInGateway).not.toHaveBeenCalled();
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
  ])("rejects $case before publication (#9875)", ({ state }) => {
    const harness = createHarness(state);

    expect(() => prepareProviders(publicationInput(), harness.deps)).toThrowError(
      `OpenShell did not confirm messaging provider '${providerName}' before sandbox creation.`,
    );
    expect(harness.runOpenshell).toHaveBeenCalledTimes(2);
    expect(harness.cleanupCreateSources).toHaveBeenCalledOnce();
  });

  it("rejects a messaging binding that changes during publication (#9875)", () => {
    const harness = createHarness(exactState, { ...exactState, type: "generic" });

    expect(() => prepareProviders(publicationInput(), harness.deps)).toThrowError(
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

  it("preserves publication for providers outside the credential profile (#9875)", () => {
    const harness = createHarness();
    const arbitraryProvider = "operator-provider";

    prepareProviders(
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

  it("rejects an incompatible messaging binding before a portable Hermes create (#9875)", () => {
    const harness = createHarness({ ...exactState, type: "generic" });

    expect(() =>
      validateAttachedMessagingProvidersBeforeSandboxCreation(
        publicationInput({ openshellDriver: "native" }),
        harness.deps,
      ),
    ).toThrowError(`OpenShell did not confirm messaging provider '${providerName}'`);
    expect(harness.runOpenshell).toHaveBeenCalledTimes(2);
    expect(harness.cleanupCreateSources).toHaveBeenCalledOnce();
  });

  it("rejects an incompatible global messaging profile before provider adoption (#9875)", () => {
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

    expect(() =>
      validateAttachedMessagingProvidersBeforeSandboxCreation(publicationInput(), harness.deps),
    ).toThrowError(/does not match NemoClaw's endpointless messaging credential contract/u);
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
