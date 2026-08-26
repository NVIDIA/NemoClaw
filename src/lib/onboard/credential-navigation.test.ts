// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import * as credentials from "../credentials/store";
import {
  BACK_TO_SELECTION,
  replaceNamedCredential,
  returningToProviderSelection,
  shouldReturnToProviderSelection,
} from "./credential-navigation";
import { handleRoutedSelection } from "./inference-providers/routed-selection";
import type { SetupNimSelectionState } from "./setup-nim-selection";

describe("credential prompt navigation helpers", () => {
  it("treats both the shared back sentinel and credential back intents as provider-selection navigation", () => {
    const exitOnboard = vi.fn(() => {
      throw new Error("unexpected exit");
    }) as unknown as () => never;

    expect(shouldReturnToProviderSelection(BACK_TO_SELECTION, exitOnboard)).toBe(true);
    expect(shouldReturnToProviderSelection({ kind: "back" }, exitOnboard)).toBe(true);
    expect(
      shouldReturnToProviderSelection({ kind: "credential", value: "back" }, exitOnboard),
    ).toBe(false);
    expect(exitOnboard).not.toHaveBeenCalled();
  });

  it("exits for credential exit intents instead of treating them as back navigation", () => {
    const exitError = new Error("exit");
    const exitOnboard = vi.fn(() => {
      throw exitError;
    }) as unknown as () => never;

    expect(() => shouldReturnToProviderSelection({ kind: "exit" }, exitOnboard)).toThrow(exitError);
    expect(exitOnboard).toHaveBeenCalledTimes(1);
  });

  it("prints the provider-selection message whenever a value returns to provider selection", () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      const exitOnboard = vi.fn(() => {
        throw new Error("unexpected exit");
      }) as unknown as () => never;

      expect(returningToProviderSelection({ kind: "back" }, exitOnboard)).toBe(true);
      expect(returningToProviderSelection({ kind: "help" }, exitOnboard)).toBe(false);
    } finally {
      console.log = originalLog;
    }

    expect(logs).toEqual(["  Returning to provider selection.", ""]);
  });

  it("keeps the prompt and accepts an empty optional credential (#7424)", async () => {
    const prompt = vi
      .spyOn(credentials, "readCredentialPrompt")
      .mockResolvedValue({ kind: "credential", value: "" });
    try {
      await expect(
        replaceNamedCredential({
          envName: "NEMOCLAW_TEST_OPTIONAL_CREDENTIAL",
          label: "API key (press Enter for no authentication)",
          allowEmpty: true,
          exitOnboardFromPrompt: () => process.exit(1),
        }),
      ).resolves.toBe("");
      expect(prompt).toHaveBeenCalledWith(
        "  API key (press Enter for no authentication): ",
        expect.any(Function),
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("rechecks policy authority after the credential prompt before persistence (#9833)", async () => {
    const prompt = vi
      .spyOn(credentials, "readCredentialPrompt")
      .mockResolvedValue({ kind: "credential", value: "new-secret" });
    const saveCredential = vi.spyOn(credentials, "saveCredential");
    delete process.env.NEMOCLAW_TEST_POLICY_CREDENTIAL;

    await expect(
      replaceNamedCredential({
        envName: "NEMOCLAW_TEST_POLICY_CREDENTIAL",
        label: "Policy credential",
        exitOnboardFromPrompt: () => process.exit(1),
        revalidatePolicyRequirements: () => {
          throw new Error("external policy authority must supply the selected route");
        },
      }),
    ).rejects.toThrow(/external policy authority must supply/u);

    expect(prompt).toHaveBeenCalledOnce();
    expect(saveCredential).not.toHaveBeenCalled();
    expect(process.env.NEMOCLAW_TEST_POLICY_CREDENTIAL).toBeUndefined();
    vi.restoreAllMocks();
  });

  it.each(["configured", "bridged"] as const)(
    "stops Model Router %s credential persistence when policy authority changes (#9833)",
    async (source) => {
      const saveCredential = vi.fn();
      const stageRouterProviderKeyBridge = vi.fn();
      const state = {
        model: null,
        provider: "",
        endpointUrl: null,
        credentialEnv: null,
        hermesAuthMethod: null,
        hermesToolGateways: [],
        preferredInferenceApi: null,
        nimContainer: null,
        allowToolsIncompatible: false,
        revalidatePolicyRequirements: () => {
          throw new Error("external policy authority must supply the selected route");
        },
      } satisfies SetupNimSelectionState;

      await expect(
        handleRoutedSelection(state, {
          modelRouter: {
            DEFAULT_MODEL_ROUTER_CREDENTIAL_ENV: "ROUTER_KEY",
            loadBlueprintProfile: () => ({
              model: "router/model",
              router: { enabled: true, credential_env: "ROUTER_KEY" },
            }),
          },
          localInference: { HOST_GATEWAY_URL: "http://host.openshell.internal" },
          urlUtils: { isLoopbackHostname: () => false },
          credentials: {
            normalizeCredentialValue: (value) => String(value ?? ""),
            resolveProviderCredential: () => null,
            saveCredential,
          },
          hydrateCredentialEnv: () => (source === "configured" ? "configured-secret" : null),
          providerKeyBridge: {
            resolveRouterProviderKeyBridge: () => (source === "bridged" ? "bridged-secret" : null),
            stageRouterProviderKeyBridge,
          },
          isNonInteractive: () => true,
          exitProcess: (code): never => {
            throw new Error(`unexpected exit ${String(code)}`);
          },
          credentialPrompt: {
            ensureNamedCredential: vi.fn(),
            returningToProviderSelection: () => false,
          },
        }),
      ).rejects.toThrow(/external policy authority must supply/u);

      expect(saveCredential).not.toHaveBeenCalled();
      expect(stageRouterProviderKeyBridge).not.toHaveBeenCalled();
    },
  );
});
