// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";
import type { SetupInference, SetupInferenceDeps } from "../../src/lib/onboard/setup-inference.js";

const onboardProviderHelpers = require("../../src/lib/onboard/providers") as {
  upsertProvider: (
    name: string,
    type: string,
    credentialEnv: string,
    baseUrl: string | null,
    env: Record<string, string | undefined>,
    runOpenshell: DirectRunOpenshell,
  ) => { ok: boolean; status?: number; message?: string };
};
const localInferenceModule =
  require("../../src/lib/inference/local") as typeof import("../../src/lib/inference/local.js");

export type DirectCommandEntry = {
  command: string;
  env?: Record<string, string | undefined>;
  ignoreError?: boolean;
};

type CreateSetupInference = (overrides?: Partial<SetupInferenceDeps>) => SetupInference;
type DirectRunOpenshell = SetupInferenceDeps["runOpenshell"];
type DirectRunOptions = NonNullable<Parameters<DirectRunOpenshell>[1]>;
type DirectRunResult = ReturnType<DirectRunOpenshell>;

export type DirectRunStubResult = {
  status: number | null;
  stdout?: string;
  stderr?: string;
};

export type DirectSetupHarnessOptions = {
  runOpenshell?: (
    args: string[],
    options: DirectRunOptions,
    calls: DirectCommandEntry[],
  ) => DirectRunStubResult | undefined;
  overrides?: Partial<SetupInferenceDeps>;
};

type DirectCommandRoute = {
  name: string;
  matches(command: string): boolean;
  results: readonly [DirectRunStubResult | undefined, ...(DirectRunStubResult | undefined)[]];
};

export async function withProcessEnv<T>(
  values: Record<string, string | undefined>,
  runTest: () => Promise<T> | T,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await runTest();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export function createDirectCommandRouter(routes: readonly DirectCommandRoute[]) {
  const callCounts = new Map<string, number>();
  const runOpenshell: NonNullable<DirectSetupHarnessOptions["runOpenshell"]> = (args) => {
    const command = args.join(" ");
    const route = routes.find((candidate) => candidate.matches(command));
    if (!route) return undefined;
    const callIndex = callCounts.get(route.name) ?? 0;
    callCounts.set(route.name, callIndex + 1);
    return route.results[Math.min(callIndex, route.results.length - 1)];
  };
  return {
    callCount: (name: string) => callCounts.get(name) ?? 0,
    runOpenshell,
  };
}

export function directRunResult({
  status = 0,
  stdout = "",
  stderr = "",
}: Partial<DirectRunStubResult> = {}): DirectRunResult {
  return {
    pid: 0,
    output: [null, stdout, stderr],
    stdout,
    stderr,
    status,
    signal: null,
  };
}

export function createDirectSetupInferenceHarnessFactory(
  createSetupInference: CreateSetupInference,
) {
  return function createDirectSetupInferenceHarness(options: DirectSetupHarnessOptions = {}) {
    const commands: DirectCommandEntry[] = [];
    const errors: string[] = [];
    const logs: string[] = [];
    const updateSandbox = vi.fn(() => true);
    const verifyInferenceRoute = vi.fn();
    const verifyOnboardInferenceSmoke = vi.fn();
    const runOpenshell: DirectRunOpenshell = (args, runOptions = {}) => {
      commands.push({
        command: args.join(" "),
        env: runOptions.env,
        ignoreError: runOptions.ignoreError,
      });
      return directRunResult(options.runOpenshell?.(args, runOptions, commands));
    };
    const setupInference = createSetupInference({
      step: () => {},
      getGatewayName: () => "nemoclaw",
      runOpenshell,
      upsertProvider: (
        name: string,
        type: string,
        credentialEnv: string,
        baseUrl: string | null,
        env: Record<string, string | undefined> = {},
      ) =>
        onboardProviderHelpers.upsertProvider(
          name,
          type,
          credentialEnv,
          baseUrl,
          env,
          runOpenshell,
        ),
      verifyInferenceRoute,
      verifyOnboardInferenceSmoke,
      isNonInteractive: () => false,
      updateSandbox,
      resolveHermesNousApiKey: () => process.env.NOUS_API_KEY || null,
      checkHermesProviderStoreReachable: (run: DirectRunOpenshell) => {
        run(["provider", "list"], { ignoreError: true });
        return { ok: true };
      },
      hydrateCredentialEnv: (envName: string | null | undefined) =>
        envName ? process.env[envName] || null : null,
      promptValidationRecovery: async () => "selection",
      validateLocalProvider: () => ({ ok: true }),
      getLocalProviderHealthCheck: () => null,
      getLocalProviderBaseUrl: (provider: string) =>
        provider === "ollama-local"
          ? "http://host.openshell.internal:11435/v1"
          : "http://host.openshell.internal:8000/v1",
      applyLocalInferenceRoute: async () => false,
      run: () => directRunResult(),
      shouldFrontOllamaWithProxy: () => false,
      ensureOllamaAuthProxy: () => {},
      isProxyHealthy: () => true,
      getOllamaProxyToken: () => null,
      persistAndProbeOllamaProxy: async () => {},
      localInference: {
        ...localInferenceModule,
        validateOllamaModelWithToolsOverride: () => ({ ok: true }),
      },
      log: (message: string) => logs.push(message),
      error: (message: string) => errors.push(message),
      exitProcess: (code: number): never => {
        throw Object.assign(new Error(`EXIT_CALLED:${code}`), { code });
      },
      ...options.overrides,
    });
    return {
      commands,
      errors,
      logs,
      runOpenshell,
      setupInference,
      updateSandbox,
      verifyInferenceRoute,
      verifyOnboardInferenceSmoke,
    };
  };
}
