// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Re-prompts for a remote provider's credential during `nemoclaw onboard --resume`
// when the previously-recorded provider has been deleted from the gateway (e.g.
// after `nemoclaw credentials reset <PROVIDER>` removed it).
//
// Resume mode would otherwise short-circuit the inference setup step on the
// recorded `provider`/`model`, leaving the sandbox rebuild to fail with an
// authentication error (#3278).

export type RemoteProviderConfigEntry = {
  label: string;
  providerName: string;
  providerType: string;
  credentialEnv: string;
  endpointUrl: string;
  helpUrl: string | null;
  modelMode: "catalog" | "curated" | "input";
  defaultModel: string;
  skipVerify?: boolean;
};

export type ResumeProviderRecoveryDeps = {
  remoteProviderConfig: Record<string, RemoteProviderConfigEntry>;
  defaultRouteCredentialEnv: string;
  isRoutedInferenceProvider: (provider: string) => boolean;
  providerExistsInGateway: (name: string) => boolean;
  hydrateCredentialEnv: (envName: string) => string | null;
  getProviderLabel: (key: string) => string;
  isNonInteractive: () => boolean;
  log: (message: string) => void;
  warn: (message: string) => void;
  note: (message: string) => void;
  exit: (code: number) => void;
  replaceNamedCredential: (
    envName: string,
    label: string,
    helpUrl: string | null,
    validator: (value: string) => string | null,
  ) => Promise<unknown>;
  validateNvidiaApiKeyValue: (key: string, credentialEnv: string) => string | null;
};

export type ResumeProviderRecoveryResult = {
  forceInferenceSetup: boolean;
  credentialEnv: string | null;
};

/**
 * Resolve a persisted OpenShell provider name back to its onboard provider config.
 */
export function getRemoteProviderConfigForName(
  provider: string | null | undefined,
  remoteProviderConfig: Record<string, RemoteProviderConfigEntry>,
): RemoteProviderConfigEntry | null {
  if (!provider) return null;
  if (provider === "nvidia-nim") return remoteProviderConfig.build;
  return (
    Object.values(remoteProviderConfig).find((entry) => entry.providerName === provider) || null
  );
}

/**
 * Choose the credential env used to recreate a missing provider during resume.
 */
export function getResumeProviderCredentialEnv(
  provider: string,
  config: RemoteProviderConfigEntry | null,
  credentialEnv: string | null | undefined,
  deps: Pick<ResumeProviderRecoveryDeps, "defaultRouteCredentialEnv" | "isRoutedInferenceProvider">,
): string {
  if (credentialEnv) return credentialEnv;
  if (config?.credentialEnv) return config.credentialEnv;
  return deps.isRoutedInferenceProvider(provider) ? deps.defaultRouteCredentialEnv : "";
}

/**
 * Ensure a resumed remote provider still exists in the gateway, re-prompting
 * for credentials when needed.
 *
 * Returns `forceInferenceSetup: true` when the caller must re-run the
 * inference setup step (provider was missing and credential was hydrated or
 * just re-entered). `credentialEnv` is the env var resolved for that recovery.
 *
 * In non-interactive mode with a missing credential, calls `deps.exit(1)`.
 */
export async function ensureResumeProviderReady(
  provider: string | null | undefined,
  credentialEnv: string | null | undefined,
  deps: ResumeProviderRecoveryDeps,
): Promise<ResumeProviderRecoveryResult> {
  const config = getRemoteProviderConfigForName(provider, deps.remoteProviderConfig);
  if (!provider || (!config && !deps.isRoutedInferenceProvider(provider))) {
    return { forceInferenceSetup: false, credentialEnv: credentialEnv ?? null };
  }
  if (deps.providerExistsInGateway(provider)) {
    return { forceInferenceSetup: false, credentialEnv: credentialEnv ?? null };
  }

  const resolvedCredentialEnv = getResumeProviderCredentialEnv(
    provider,
    config,
    credentialEnv,
    deps,
  );
  const credentialValue = deps.hydrateCredentialEnv(resolvedCredentialEnv);
  const providerLabel = config?.label || deps.getProviderLabel(provider) || provider;
  const helpUrl = config?.helpUrl || null;
  if (!credentialValue) {
    if (deps.isNonInteractive()) {
      deps.warn(
        `  ${resolvedCredentialEnv} is required to recreate provider '${provider}' during resume.`,
      );
      deps.warn(
        `  Re-run without --non-interactive to enter it, or set ${resolvedCredentialEnv} and retry.`,
      );
      deps.exit(1);
      return { forceInferenceSetup: false, credentialEnv: resolvedCredentialEnv };
    }
    deps.log("");
    deps.log(`  [resume] Provider '${provider}' is missing from the gateway.`);
    deps.log("  Re-enter the API key so onboarding can recreate it before rebuilding.");
    await deps.replaceNamedCredential(
      resolvedCredentialEnv,
      `${providerLabel} API key`,
      helpUrl,
      (value) => deps.validateNvidiaApiKeyValue(value, resolvedCredentialEnv),
    );
  } else {
    deps.note(`  [resume] Provider '${provider}' is missing from the gateway; recreating it.`);
  }
  return { forceInferenceSetup: true, credentialEnv: resolvedCredentialEnv };
}
