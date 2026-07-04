// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createHermesAuthHelpers,
  HERMES_NOUS_API_KEY_CREDENTIAL_ENV,
  type HermesAuthFlowDeps,
} from "./hermes-auth";

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
    vi.stubEnv(HERMES_NOUS_API_KEY_CREDENTIAL_ENV, undefined);
    vi.stubEnv("NEMOCLAW_PROVIDER_KEY", undefined);
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
