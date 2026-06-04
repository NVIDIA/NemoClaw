// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Shared types for per-provider inference setup modules.
//
// Each module under `src/lib/onboard/inference-providers/` exports a function
// that owns the setup flow for one provider (or one closely related group of
// providers) used by `onboard.setupInference`. The orchestrator stays in
// `src/lib/onboard.ts`; this directory holds the provider-specific branches it
// used to inline. Behavior is preserved exactly — these are pure extractions.
//
// Many dependency signatures here are intentionally loose (`unknown` /
// permissive unions). The dispatcher in `onboard.ts` already has stricter
// types for the underlying helpers; these modules just plumb values through
// so they accept whatever the orchestrator hands in without needing to
// duplicate every helper's exact signature.

import type { HermesAuthMethod } from "../hermes-auth";

export type SetupInferenceResult =
  | { ok: true; retry?: undefined }
  | { retry: "selection" };

export type RunOpenshell = (
  args: string[],
  options?: { ignoreError?: boolean; suppressOutput?: boolean; timeout?: number },
) => { status: number | null; stdout?: unknown; stderr?: unknown };

export type RunResult = {
  status: number | null;
  stdout?: unknown;
  stderr?: unknown;
};

export type UpsertProviderResult = {
  ok: boolean;
  message?: string;
  status?: number;
};

// Loose to match the various concrete signatures across onboard.ts.
export type UpsertProvider = (
  name: string,
  type: string,
  credentialEnv: any,
  baseUrl: any,
  env?: NodeJS.ProcessEnv,
) => UpsertProviderResult;

export type RemoteProviderConfigEntry = {
  label: string;
  providerName: string;
  providerType: string;
  credentialEnv: string;
  endpointUrl: string;
  helpUrl: string | null;
  modelMode: string;
  defaultModel: string;
  skipVerify?: boolean;
};

export type VerifyInferenceRoute = (provider: string, model: string) => void;

export type VerifyOnboardInferenceSmoke = (input: {
  provider: string;
  model: string;
  endpointUrl?: string | null;
  credentialEnv?: string | null;
  forceOpenAiLike?: boolean;
}) => void;

export type PromptValidationRecovery = (
  label: string,
  classification: any,
  credentialEnv: any,
  helpUrl: any,
) => Promise<string>;

export type ClassifyApplyFailure = (message: string) => any;

export type Registry = {
  updateSandbox(sandboxName: string, patch: { model: string; provider: string }): void;
};

export type CommonDeps = {
  runOpenshell: RunOpenshell;
  upsertProvider: UpsertProvider;
  verifyInferenceRoute: VerifyInferenceRoute;
  verifyOnboardInferenceSmoke: VerifyOnboardInferenceSmoke;
  isNonInteractive: () => boolean;
  registry: Registry;
};

export type RemoteProviderDeps = CommonDeps & {
  REMOTE_PROVIDER_CONFIG: Record<string, RemoteProviderConfigEntry>;
  hydrateCredentialEnv: (envName: any, resolveCredential?: any) => any;
  promptValidationRecovery: PromptValidationRecovery;
  classifyApplyFailure: ClassifyApplyFailure;
  LOCAL_INFERENCE_TIMEOUT_SECS: number;
  redact: (input: string) => string;
  compactText: (input: string) => string;
  bedrockRuntimeOnboard: {
    setupBedrockRuntimeInference(input: {
      sandboxName: string | null;
      provider: string;
      model: string;
      endpointUrl: string | null;
      credentialEnv: string | null;
      isNonInteractive: () => boolean;
      runOpenshell: RunOpenshell;
      upsertProvider: UpsertProvider;
      verifyInferenceRoute: VerifyInferenceRoute;
      verifyOnboardInferenceSmoke: any;
    }): Promise<{ handled: true; result: SetupInferenceResult } | { handled: false }>;
  };
};

export type HermesDeps = CommonDeps & {
  hermesProviderAuth: {
    HERMES_PROVIDER_NAME: string;
    isHermesProviderRegistered(runOpenshell: any): boolean;
    ensureHermesProviderApiKeyCredentials(
      sandboxName: string,
      opts: { apiKey: unknown; runOpenshell: any; baseUrl?: string | undefined },
    ): Promise<unknown>;
    ensureHermesProviderOAuthCredentials(
      sandboxName: string,
      opts: {
        allowInteractiveLogin: boolean;
        runOpenshell: any;
        baseUrl?: string | undefined;
        toolGatewayPresets: string[];
      },
    ): Promise<unknown>;
  };
  getHermesToolGatewayBroker: () => {
    getHermesToolGatewayProviderName(sandboxName: string): string;
  };
  providerExistsInGateway: (name: string) => boolean;
  normalizeHermesAuthMethod: (m: HermesAuthMethod | string | null) => HermesAuthMethod | null;
  resolveHermesNousApiKey: () => any;
  checkHermesProviderStoreReachable: (runOpenshell: any) => { ok: boolean; message?: string };
  hermesAuthMethodLabel: (m: HermesAuthMethod) => string;
  hermesConstants: {
    HERMES_NOUS_API_KEY_CREDENTIAL_ENV: string;
    HERMES_AUTH_METHOD_API_KEY: HermesAuthMethod;
    HERMES_AUTH_METHOD_OAUTH: HermesAuthMethod;
  };
  requireValue: <T>(value: T | null | undefined, message: string) => T;
  redact: (input: string) => string;
  compactText: (input: string) => string;
};

// `run` accepts an array form (execa-style) in the real onboard.ts; we type it
// loosely so callers can pass either shape without casting.
export type RunFn = (cmd: any, opts?: { ignoreError?: boolean; suppressOutput?: boolean }) => RunResult;

export type VllmDeps = CommonDeps & {
  validateLocalProvider: (provider: string) => { ok: boolean; message?: string; diagnostic?: string };
  getLocalProviderHealthCheck: (provider: string) => any;
  getLocalProviderBaseUrl: (provider: string) => any;
  applyLocalInferenceRoute: (provider: string, model: string) => Promise<boolean>;
  run: RunFn;
  VLLM_LOCAL_CREDENTIAL_ENV: string;
};

export type OllamaDeps = CommonDeps & {
  validateLocalProvider: (provider: string) => { ok: boolean; message?: string; diagnostic?: string };
  getLocalProviderBaseUrl: (provider: string) => any;
  applyLocalInferenceRoute: (provider: string, model: string) => Promise<boolean>;
  getOllamaWarmupCommand: (model: string) => any;
  run: RunFn;
  shouldFrontOllamaWithProxy: () => boolean;
  ensureOllamaAuthProxy: () => void;
  isProxyHealthy: () => boolean;
  getOllamaProxyToken: () => string | null | undefined;
  persistAndProbeOllamaProxy: (token: string) => Promise<void>;
  localInference: {
    validateOllamaModelWithToolsOverride(
      model: string,
      allowToolsIncompatible: boolean,
    ): { ok: boolean; message?: string };
  };
  OLLAMA_PROXY_CREDENTIAL_ENV: string;
};

export type RoutedDeps = CommonDeps & {
  reconcileModelRouter: () => Promise<void>;
  routedInference: {
    upsertRoutedProvider(
      provider: string,
      endpointUrl: string | null,
      credentialEnv: string | null,
      helpers: {
        upsertProvider: UpsertProvider;
        hydrateCredentialEnv: (envName: any, resolveCredential?: any) => any;
      },
    ): { ok: boolean; result: { message?: string; status?: number } };
  };
  hydrateCredentialEnv: (envName: any, resolveCredential?: any) => any;
};

export const REMOTE_PROVIDER_NAMES = [
  "nvidia-prod",
  "nvidia-nim",
  "openai-api",
  "anthropic-prod",
  "compatible-anthropic-endpoint",
  "gemini-api",
  "compatible-endpoint",
] as const;

export type RemoteProviderName = (typeof REMOTE_PROVIDER_NAMES)[number];

export function isRemoteProviderName(value: string): value is RemoteProviderName {
  return (REMOTE_PROVIDER_NAMES as readonly string[]).includes(value);
}
