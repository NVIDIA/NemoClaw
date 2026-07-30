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
    getHermesInferenceProviderName: vi.fn(
      (sandboxName: string) => `${sandboxName}-hermes-inference`,
    ),
    getHermesToolGatewayProviderName: vi.fn(
      (sandboxName: string) => `${sandboxName}-hermes-tool-gateway`,
    ),
    preflightHermesToolGatewayCloneBinding: vi.fn(),
    stageHermesToolGatewayCloneBinding: vi.fn(() => ({
      activationToken: "nc_activate_test-only",
      brokerToken: "nc_broker_test-only",
    })),
    activateHermesToolGatewayCloneBinding: vi.fn(() => ({
      file: "/test-only/beta.json",
      brokerToken: "nc_broker_test-only",
    })),
    discardHermesToolGatewayCloneBinding: vi.fn(() => true),
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
    ).resolves.toEqual({
      [REFRESH_ENV]: "test-only-refresh",
      OPENAI_API_KEY: expect.stringMatching(/^nc_clone_/u),
    });
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
    ).resolves.toEqual({
      [REFRESH_ENV]: "test-only-device-refresh",
      OPENAI_API_KEY: expect.stringMatching(/^nc_clone_/u),
    });
    expect(runDeviceCodeFlow).toHaveBeenCalledOnce();
  });

  it("creates a destination provider, binds broker state, and removes both on cleanup", () => {
    const broker = fakeBroker();
    const runner = vi.fn(
      s.managedProviderCreationRunner({
        "beta-hermes-inference": {
          type: "openai",
          credential: "OPENAI_API_KEY",
        },
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
      environment: {
        [REFRESH_ENV]: "test-only-refresh",
        OPENAI_API_KEY: "test-only-placeholder",
      },
      root: "/repo",
      runOpenshell: runner,
      hermesToolGatewayBroker: broker,
    });

    expect(prepared).toEqual([
      {
        providerName: "beta-hermes-inference",
        providerType: "openai",
        providerEnvKey: "OPENAI_API_KEY",
        source: "hermes-inference",
        replaceExistingCredential: false,
      },
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
        environment: {
          [REFRESH_ENV]: "test-only-refresh",
          OPENAI_API_KEY: "test-only-placeholder",
        },
        runOpenshell: runner,
        hermesToolGatewayBroker: broker,
        stagedHermesBinding: {
          activationToken: "nc_activate_test-only",
          brokerToken: "nc_broker_test-only",
        },
      }),
    ).toEqual(["beta-hermes-inference", "beta-hermes-tool-gateway"]);
    expect(broker.preflightHermesToolGatewayCloneBinding).toHaveBeenCalledExactlyOnceWith("beta");
    expect(broker.activateHermesToolGatewayCloneBinding).toHaveBeenCalledExactlyOnceWith(
      "beta",
      "test-only-refresh",
      {
        activationToken: "nc_activate_test-only",
        brokerToken: "nc_broker_test-only",
      },
    );
    expect(
      runner.mock.calls.some(([, options]) =>
        String(JSON.stringify(options?.env)).includes("test-only-refresh"),
      ),
    ).toBe(false);
    expect(
      runner.mock.calls.some(([, options]) =>
        String(JSON.stringify(options?.env)).includes("nc_broker_test-only"),
      ),
    ).toBe(true);
    expect(runner.mock.calls.map(([args]) => args.join(" ")).join("\n")).not.toContain(
      "test-only-refresh",
    );

    cleanupManagedCloneProviders(
      ["beta-hermes-inference", "beta-hermes-tool-gateway"],
      runner,
      undefined,
      broker,
    );
    expect(broker.removeHermesToolGatewayProviderState).toHaveBeenCalledExactlyOnceWith("beta");
  });

  it("rolls back the destination provider when broker rebinding fails", () => {
    const broker = fakeBroker();
    broker.activateHermesToolGatewayCloneBinding.mockImplementation(() => {
      throw new Error("synthetic broker bind failure");
    });
    const commands: string[] = [];
    const created = new Set<string>();
    const runner = vi.fn((args: string[]) => {
      commands.push(args.join(" "));
      if (args[1] === "get") {
        const providerName = args[2] ?? "";
        const inference = providerName.endsWith("-hermes-inference");
        return created.has(providerName)
          ? {
              status: 0,
              stdout: s.providerMetadata(
                providerName,
                inference ? "openai" : "generic",
                inference ? "OPENAI_API_KEY" : REFRESH_ENV,
              ),
              output: "",
            }
          : { status: 1, stderr: `provider '${providerName}' not found`, output: "" };
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
      environment: {
        [REFRESH_ENV]: "test-only-refresh",
        OPENAI_API_KEY: "test-only-placeholder",
      },
      root: "/repo",
      runOpenshell: runner,
      hermesToolGatewayBroker: broker,
    });

    expect(() =>
      provisionManagedCloneProviders(prepared, {
        environment: {
          [REFRESH_ENV]: "test-only-refresh",
          OPENAI_API_KEY: "test-only-placeholder",
        },
        runOpenshell: runner,
        hermesToolGatewayBroker: broker,
        stagedHermesBinding: {
          activationToken: "nc_activate_test-only",
          brokerToken: "nc_broker_test-only",
        },
      }),
    ).toThrow("synthetic broker bind failure");
    expect(commands).toContain("provider delete beta-hermes-tool-gateway");
    expect(commands).toContain("provider delete beta-hermes-inference");
    expect(broker.discardHermesToolGatewayCloneBinding).toHaveBeenCalledExactlyOnceWith("beta", {
      activationToken: "nc_activate_test-only",
      brokerToken: "nc_broker_test-only",
    });
    expect(broker.removeHermesToolGatewayProviderState).toHaveBeenCalledExactlyOnceWith("beta");
  });

  it("preserves broker state when either Hermes provider cannot be cleaned up", () => {
    const broker = fakeBroker();
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runner = vi.fn((args: string[]) => ({
      status: args[2] === "beta-hermes-inference" ? 1 : 0,
      stderr: args[2] === "beta-hermes-inference" ? "gateway unavailable" : "",
      output: "",
    }));

    cleanupManagedCloneProviders(
      ["beta-hermes-inference", "beta-hermes-tool-gateway"],
      runner,
      undefined,
      broker,
    );

    expect(broker.removeHermesToolGatewayProviderState).not.toHaveBeenCalled();
    expect(consoleWarn.mock.calls.flat().join("\n")).toContain(
      "preserving Hermes tool-gateway broker state for 'beta'",
    );
  });

  it("rejects broker runtime incompatibility before inspecting or mutating providers", () => {
    const broker = fakeBroker();
    broker.preflightHermesToolGatewayCloneBinding.mockImplementation(() => {
      throw new Error("synthetic active broker runtime mismatch");
    });
    const runner = vi.fn();

    expect(() =>
      prepareManagedCloneProviders({
        profile: managedHermesToolProfile(),
        messagingPlan: null,
        destinationSandboxName: "beta",
        destinationWillBeReplaced: true,
        environment: {
          [REFRESH_ENV]: "test-only-refresh",
          OPENAI_API_KEY: "test-only-placeholder",
        },
        root: "/repo",
        runOpenshell: runner,
        hermesToolGatewayBroker: broker,
      }),
    ).toThrow("synthetic active broker runtime mismatch");
    expect(runner).not.toHaveBeenCalled();
  });

  it("fails closed when provider inspection cannot prove exact NotFound", () => {
    const broker = fakeBroker();
    const runner = vi.fn((_args: string[]) => ({
      status: 1,
      stdout: "",
      stderr: "transport unavailable",
      output: "",
    }));

    expect(() =>
      prepareManagedCloneProviders({
        profile: managedHermesToolProfile(),
        messagingPlan: null,
        destinationSandboxName: "beta",
        destinationWillBeReplaced: true,
        environment: {
          [REFRESH_ENV]: "test-only-refresh",
          OPENAI_API_KEY: "test-only-placeholder",
        },
        root: "/repo",
        runOpenshell: runner,
        hermesToolGatewayBroker: broker,
      }),
    ).toThrow("could not prove whether managed clone provider 'beta-hermes-inference' exists");
    expect(runner.mock.calls.some(([args]) => args[0] === "provider" && args[1] !== "get")).toBe(
      false,
    );
  });
});
