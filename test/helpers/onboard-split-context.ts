// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import path from "node:path";
import { vi } from "vitest";
import type { OpenShellProviderAdapter } from "../../src/lib/adapters/openshell/provider-adapter";
import { nativeHostedProfile } from "../../src/lib/inference/native-hosted/profiles";

import type { SetupInference, SetupInferenceDeps } from "../../src/lib/onboard/setup-inference.js";
import { createDirectSetupInferenceHarnessFactory } from "../support/setup-inference-test-harness.js";

export type ShimScalar = string | number | boolean | null | undefined;
export type ShimCallable = (...args: readonly string[]) => ShimValue;
export type ShimValue = ShimScalar | { [key: string]: ShimValue } | ShimValue[] | ShimCallable;
export type ShimFn<TReturn = void> = (...args: ShimValue[]) => TReturn;
export type CommandEntry = {
  command: string;
  env?: Record<string, string | undefined>;
  ignoreError?: boolean;
  policyContent?: string;
  policyReadError?: string;
  dockerfileContent?: string;
  dockerfileReadError?: string;
};
export type ResumeConflict = {
  field: string;
  requested: string | null;
  recorded: string | null;
};
export type OnboardTestInternals = {
  getNavigationChoice: (value?: string | null) => string | null;
  getFutureShellPathHint: (binDir: string, pathValue?: string) => string | null;
  getRequestedModelHint: ShimFn<string | null>;
  getRequestedProviderHint: ShimFn<string | null>;
  getRequestedSandboxNameHint: ShimFn<string | null>;
  getResumeConfigConflicts: ShimFn<ResumeConflict[]>;
  getResumeSandboxConflict: ShimFn<{
    requestedSandboxName: string;
    recordedSandboxName: string;
  } | null>;
  clearAgentScopedResumeState: <T extends Record<string, unknown>>(
    session: T,
    selectedAgentName: string,
  ) => T;
  pullAndResolveBaseImageDigest: () => { digest: string | null; ref: string } | null;
  createSetupInference: (overrides?: Partial<SetupInferenceDeps>) => SetupInference;
  SANDBOX_BASE_IMAGE: string;
};

export function parseStdoutJson<T>(stdout: string): T {
  const line = stdout.trim().split("\n").pop();
  assert.ok(line, `expected JSON payload in stdout:\n${stdout}`);
  return JSON.parse(line);
}

export function stripMessagingEnv(source: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const env = { ...source } as Record<string, string | undefined>;
  for (const key of Object.keys(env)) {
    if (key.startsWith("DISCORD_") || key.startsWith("TELEGRAM_")) {
      delete env[key];
    }
  }
  return env;
}

type OnboardTestInternalsCandidate = Partial<OnboardTestInternals> | null;

function isOnboardTestInternals(
  value: OnboardTestInternalsCandidate,
): value is OnboardTestInternals {
  return value !== null && typeof value.getNavigationChoice === "function";
}

const loadedOnboardInternals = require("../../src/lib/onboard");
const onboardTestInternals =
  typeof loadedOnboardInternals === "object" && loadedOnboardInternals !== null
    ? loadedOnboardInternals
    : null;
if (!isOnboardTestInternals(onboardTestInternals)) {
  throw new Error("Expected onboard test internals to expose helper functions");
}

export const {
  getNavigationChoice,
  getFutureShellPathHint,
  getRequestedModelHint,
  getRequestedProviderHint,
  getRequestedSandboxNameHint,
  getResumeConfigConflicts,
  getResumeSandboxConflict,
  clearAgentScopedResumeState,
  createSetupInference,
  SANDBOX_BASE_IMAGE,
} = onboardTestInternals;

export const bedrockRuntimeOnboard =
  require("../../src/lib/onboard/bedrock-runtime") as typeof import("../../src/lib/onboard/bedrock-runtime.js");
export const createDirectSetupInferenceHarness =
  createDirectSetupInferenceHarnessFactory(createSetupInference);

export const repoRoot = path.join(import.meta.dirname, "../..");
export const onboardScriptMocksPath = JSON.stringify(
  path.join(repoRoot, "test", "helpers", "onboard-script-mocks.cjs"),
);

/** Stateful native provider transport, isolated from the developer gateway. */
export function createNativeSetupProviderAdapter(
  provider: string,
  initiallyPresent = true,
  providerId = "fixture-native-id",
) {
  const profile = nativeHostedProfile(provider)!;
  let present = initiallyPresent;
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected provider operation");
  };
  const adapter = {
    ensureProviderPolicyComposition: vi.fn<
      OpenShellProviderAdapter["ensureProviderPolicyComposition"]
    >(async () => ({ ok: true, value: undefined })),
    importProviderProfile: vi.fn<OpenShellProviderAdapter["importProviderProfile"]>(() => ({
      ok: true,
    })),
    getProvider: vi.fn<OpenShellProviderAdapter["getProvider"]>(async ({ providerName }) => {
      assert.equal(providerName, profile.providerName);
      return present
        ? {
            ok: true,
            value: {
              name: profile.providerName,
              type: profile.profileId,
              credentialKeys: [profile.credentialEnv],
              configKeys: [],
              revision: { id: providerId, resourceVersion: 1 },
            },
          }
        : { ok: false, error: { kind: "command", reason: "not_found", message: "not found" } };
    }),
    createProvider: vi.fn<OpenShellProviderAdapter["createProvider"]>(async () => {
      present = true;
      return { ok: true };
    }),
    updateProvider: vi.fn<OpenShellProviderAdapter["updateProvider"]>(async () => ({ ok: true })),
    listProviders: unexpected,
    inspectProviderProfile: unexpected,
    deleteProvider: unexpected,
    detachProvider: unexpected,
    attachProvider: unexpected,
    listProviderAttachments: unexpected,
    configureProviderRefresh: unexpected,
    getProviderRefreshStatus: unexpected,
  } satisfies OpenShellProviderAdapter;
  return adapter;
}
