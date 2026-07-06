// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createHermesAuthHelpers,
  HERMES_AUTH_METHOD_API_KEY,
  HERMES_AUTH_METHOD_OAUTH,
  HERMES_NOUS_API_KEY_CREDENTIAL_ENV,
  type HermesAuthFlowDeps,
} from "./hermes-auth";

function clearHermesAuthEnvironment(): void {
  vi.stubEnv("NEMOCLAW_HERMES_AUTH_METHOD", undefined);
  vi.stubEnv("NEMOCLAW_HERMES_AUTH", undefined);
  vi.stubEnv("NEMOCLAW_NOUS_AUTH_METHOD", undefined);
  vi.stubEnv(HERMES_NOUS_API_KEY_CREDENTIAL_ENV, undefined);
  vi.stubEnv("NEMOCLAW_PROVIDER_KEY", undefined);
}

function createDeps(overrides: Partial<HermesAuthFlowDeps> = {}): HermesAuthFlowDeps {
  return {
    isNonInteractive: vi.fn(() => true),
    note: vi.fn(),
    prompt: vi.fn(async () => ""),
    getNavigationChoice: vi.fn(() => null),
    exitOnboardFromPrompt: vi.fn((): never => {
      throw new Error("PROMPT_EXIT_CALLED");
    }),
    validateNvidiaApiKeyValue: vi.fn(() => null),
    compactText: vi.fn((value: string) => value),
    redact: vi.fn((value: unknown) => String(value)),
    runOpenshell: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
    error: vi.fn(),
    exitProcess: vi.fn((code: number): never => {
      throw new Error(`EXIT_CALLED:${code}`);
    }),
    backToSelection: Symbol("back-to-selection"),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Hermes authentication exit boundaries", () => {
  it("uses the injected exit for an unsupported requested auth method", async () => {
    vi.stubEnv("NEMOCLAW_HERMES_AUTH_METHOD", "certificate");
    const deps = createDeps();

    await expect(createHermesAuthHelpers(deps).promptHermesAuthMethod()).rejects.toThrow(
      "EXIT_CALLED:1",
    );

    expect(deps.error).toHaveBeenCalledTimes(2);
    expect(vi.mocked(deps.error).mock.calls).toEqual([
      ["  Unsupported Hermes Provider auth method: certificate"],
      ["  Valid values: oauth, nous-portal-oauth, api-key, nous-api-key"],
    ]);
    expect(deps.exitProcess).toHaveBeenCalledOnce();
    expect(deps.exitProcess).toHaveBeenCalledWith(1);
    expect(deps.note).not.toHaveBeenCalled();
  });

  it("uses the injected exit when a prompted Nous API key is invalid", async () => {
    clearHermesAuthEnvironment();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const deps = createDeps({
      isNonInteractive: vi.fn(() => false),
      prompt: vi.fn(async () => "invalid-key"),
      validateNvidiaApiKeyValue: vi.fn(() => "  Invalid NOUS_API_KEY value."),
    });

    await expect(createHermesAuthHelpers(deps).ensureHermesNousApiKeyEnv()).rejects.toThrow(
      "EXIT_CALLED:1",
    );

    expect(deps.validateNvidiaApiKeyValue).toHaveBeenCalledWith(
      "invalid-key",
      HERMES_NOUS_API_KEY_CREDENTIAL_ENV,
    );
    expect(deps.error).toHaveBeenCalledOnce();
    expect(deps.error).toHaveBeenCalledWith("  Invalid NOUS_API_KEY value.");
    expect(deps.exitProcess).toHaveBeenCalledOnce();
    expect(deps.exitProcess).toHaveBeenCalledWith(1);
    expect(process.env[HERMES_NOUS_API_KEY_CREDENTIAL_ENV]).toBeUndefined();
  });
});

describe("Hermes authentication selection", () => {
  it("selects API key authentication non-interactively when a key already exists", async () => {
    clearHermesAuthEnvironment();
    vi.stubEnv(HERMES_NOUS_API_KEY_CREDENTIAL_ENV, "nous-key");
    const deps = createDeps();

    await expect(createHermesAuthHelpers(deps).promptHermesAuthMethod()).resolves.toBe(
      HERMES_AUTH_METHOD_API_KEY,
    );

    expect(deps.note).toHaveBeenCalledOnce();
    expect(deps.note).toHaveBeenCalledWith("  [non-interactive] Hermes auth: Nous API Key");
    expect(deps.prompt).not.toHaveBeenCalled();
    expect(deps.error).not.toHaveBeenCalled();
    expect(deps.exitProcess).not.toHaveBeenCalled();
  });

  it("selects OAuth non-interactively when no key exists", async () => {
    clearHermesAuthEnvironment();
    const deps = createDeps();

    await expect(createHermesAuthHelpers(deps).promptHermesAuthMethod()).resolves.toBe(
      HERMES_AUTH_METHOD_OAUTH,
    );

    expect(deps.note).toHaveBeenCalledOnce();
    expect(deps.note).toHaveBeenCalledWith("  [non-interactive] Hermes auth: Nous Portal OAuth");
    expect(deps.prompt).not.toHaveBeenCalled();
    expect(deps.error).not.toHaveBeenCalled();
    expect(deps.exitProcess).not.toHaveBeenCalled();
  });

  it("returns to provider selection when the auth-method prompt chooses back", async () => {
    clearHermesAuthEnvironment();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const backToSelection = Symbol("back-to-selection");
    const prompt = vi.fn(async () => "back");
    const deps = createDeps({
      isNonInteractive: () => false,
      prompt,
      getNavigationChoice: vi.fn(() => "back" as const),
      backToSelection,
    });

    await expect(createHermesAuthHelpers(deps).promptHermesAuthMethod()).resolves.toBe(
      backToSelection,
    );

    expect(prompt).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledWith("  Choose [1]: ");
    expect(deps.error).not.toHaveBeenCalled();
    expect(deps.exitProcess).not.toHaveBeenCalled();
    expect(deps.exitOnboardFromPrompt).not.toHaveBeenCalled();
  });

  it("returns to provider selection when the API-key prompt chooses back", async () => {
    clearHermesAuthEnvironment();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const backToSelection = Symbol("back-to-selection");
    const prompt = vi.fn(async () => "back");
    const deps = createDeps({
      prompt,
      getNavigationChoice: vi.fn(() => "back" as const),
      backToSelection,
    });

    await expect(createHermesAuthHelpers(deps).ensureHermesNousApiKeyEnv()).resolves.toBe(
      backToSelection,
    );

    expect(prompt).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledWith("  Nous API Key: ", { secret: true });
    expect(deps.validateNvidiaApiKeyValue).not.toHaveBeenCalled();
    expect(deps.error).not.toHaveBeenCalled();
    expect(deps.exitProcess).not.toHaveBeenCalled();
    expect(deps.exitOnboardFromPrompt).not.toHaveBeenCalled();
    expect(process.env[HERMES_NOUS_API_KEY_CREDENTIAL_ENV]).toBeUndefined();
  });
});
