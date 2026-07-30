// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { buildManagedStartupProfile } from "../../onboard/managed-startup/profile-builder";
import * as s from "./snapshot/lifecycle-test-support";
import {
  cleanupManagedCloneProviders,
  prepareManagedCloneProviders,
  provisionManagedCloneProviders,
  resolveManagedCloneCredentialEnvironment,
} from "./snapshot/managed-clone-providers";

const REFRESH_ENV = "NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN";

function managedHermesToolProfile() {
  return buildManagedStartupProfile({
    agent: "hermes",
    inference: {
      routeProvider: "inference",
      upstreamProvider: "hermes-provider",
      model: "test-model",
      routedBaseUrl: "https://inference.local/v1",
      upstreamEndpointUrl: null,
      api: "openai-completions",
      primaryModelRef: null,
      compatibility: null,
    },
    dashboard: {
      agent: "hermes",
      mode: "disabled",
      url: "http://127.0.0.1/",
      publicPort: null,
      internalPort: null,
      tuiEnabled: false,
    },
    webSearch: { fetchEnabled: false, provider: "tavily" },
    toolDisclosure: "direct",
    hermesToolGateways: ["nous-web"],
    messagingPlan: null,
    dcodeAutoApprovalMode: null,
    observabilityEnabled: null,
    environment: {},
    corporateCa: null,
  }).profile;
}

function fakeBroker() {
  return {
    HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV: REFRESH_ENV,
    getHermesToolGatewayProviderName: vi.fn(
      (sandboxName: string) => `${sandboxName}-hermes-tool-gateway`,
    ),
    bindHermesToolGatewayCloneProviderState: vi.fn(() => ({
      file: "/test-only/beta.json",
      brokerToken: "test-only-broker-token",
    })),
    removeHermesToolGatewayProviderState: vi.fn(() => true),
  };
}

describe("managed snapshot clone provider credentials", () => {
  it("uses the explicit destination credential without device OAuth or browser launch", async () => {
    const runDeviceCodeFlow = vi.fn(async () => {
      throw new Error("test must not enter device-code OAuth or browser launch");
    });

    await expect(
      resolveManagedCloneCredentialEnvironment({
        profile: managedHermesToolProfile(),
        environment: { [REFRESH_ENV]: "  test-only-refresh\r\n" },
        runDeviceCodeFlow,
      }),
    ).resolves.toEqual({ [REFRESH_ENV]: "test-only-refresh" });
    expect(runDeviceCodeFlow).not.toHaveBeenCalled();
  });

  it("fails noninteractive preparation closed before production device OAuth can run", async () => {
    const runDeviceCodeFlow = vi.fn(async () => {
      throw new Error("test must not enter device-code OAuth or browser launch");
    });

    await expect(
      resolveManagedCloneCredentialEnvironment({
        profile: managedHermesToolProfile(),
        environment: { NEMOCLAW_NON_INTERACTIVE: "1" },
        runDeviceCodeFlow,
      }),
    ).rejects.toThrow(`export ${REFRESH_ENV}`);
    expect(runDeviceCodeFlow).not.toHaveBeenCalled();
  });

  it("uses an injected device-code result instead of the production OAuth implementation", async () => {
    const runDeviceCodeFlow = vi.fn(async () => ({
      refresh_token: "test-only-device-refresh",
    }));

    await expect(
      resolveManagedCloneCredentialEnvironment({
        profile: managedHermesToolProfile(),
        environment: {},
        runDeviceCodeFlow,
      }),
    ).resolves.toEqual({ [REFRESH_ENV]: "test-only-device-refresh" });
    expect(runDeviceCodeFlow).toHaveBeenCalledOnce();
  });

  it("creates a destination provider, binds broker state, and removes both on cleanup", () => {
    const broker = fakeBroker();
    const runner = vi.fn(
      s.managedProviderCreationRunner({
        "beta-hermes-tool-gateway": {
          type: "generic",
          credential: REFRESH_ENV,
        },
      }),
    );
    const prepared = prepareManagedCloneProviders({
      profile: managedHermesToolProfile(),
      messagingPlan: null,
      destinationSandboxName: "beta",
      destinationWillBeReplaced: false,
      environment: { [REFRESH_ENV]: "test-only-refresh" },
      root: "/repo",
      runOpenshell: runner,
      hermesToolGatewayBroker: broker,
    });

    expect(prepared).toEqual([
      {
        providerName: "beta-hermes-tool-gateway",
        providerType: "generic",
        providerEnvKey: REFRESH_ENV,
        source: "hermes-tool-gateway",
        brokerSandboxName: "beta",
        replaceExistingCredential: false,
      },
    ]);
    expect(
      provisionManagedCloneProviders(prepared, {
        environment: { [REFRESH_ENV]: "test-only-refresh" },
        runOpenshell: runner,
        hermesToolGatewayBroker: broker,
      }),
    ).toEqual(["beta-hermes-tool-gateway"]);
    expect(broker.bindHermesToolGatewayCloneProviderState).toHaveBeenCalledExactlyOnceWith(
      "beta",
      "test-only-refresh",
    );
    expect(
      runner.mock.calls.some(([, options]) =>
        String(JSON.stringify(options?.env)).includes("test-only-refresh"),
      ),
    ).toBe(true);
    expect(runner.mock.calls.map(([args]) => args.join(" ")).join("\n")).not.toContain(
      "test-only-refresh",
    );

    cleanupManagedCloneProviders(["beta-hermes-tool-gateway"], runner, undefined, broker);
    expect(broker.removeHermesToolGatewayProviderState).toHaveBeenCalledExactlyOnceWith("beta");
  });

  it("rolls back the destination provider when broker rebinding fails", () => {
    const broker = fakeBroker();
    broker.bindHermesToolGatewayCloneProviderState.mockImplementation(() => {
      throw new Error("synthetic broker bind failure");
    });
    const commands: string[] = [];
    const created = new Set<string>();
    const runner = vi.fn((args: string[]) => {
      commands.push(args.join(" "));
      if (args[1] === "get") {
        const providerName = args[2] ?? "";
        return created.has(providerName)
          ? {
              status: 0,
              stdout: s.providerMetadata(providerName, "generic", REFRESH_ENV),
              output: "",
            }
          : { status: 1, output: "" };
      }
      if (args[1] === "create") created.add(args[3] ?? "");
      if (args[1] === "delete") created.delete(args[2] ?? "");
      return { status: 0, output: "" };
    });
    const prepared = prepareManagedCloneProviders({
      profile: managedHermesToolProfile(),
      messagingPlan: null,
      destinationSandboxName: "beta",
      destinationWillBeReplaced: false,
      environment: { [REFRESH_ENV]: "test-only-refresh" },
      root: "/repo",
      runOpenshell: runner,
      hermesToolGatewayBroker: broker,
    });

    expect(() =>
      provisionManagedCloneProviders(prepared, {
        environment: { [REFRESH_ENV]: "test-only-refresh" },
        runOpenshell: runner,
        hermesToolGatewayBroker: broker,
      }),
    ).toThrow("synthetic broker bind failure");
    expect(commands).toContain("provider delete beta-hermes-tool-gateway");
    expect(broker.removeHermesToolGatewayProviderState).toHaveBeenCalledExactlyOnceWith("beta");
  });
});
