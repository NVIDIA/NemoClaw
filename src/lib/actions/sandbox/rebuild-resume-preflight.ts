// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { D, R } from "../../cli/terminal-style";
import type { InferenceSelection } from "../../inference/selection";
import type { RegistryInferenceRoute } from "../../onboard/rebuild-route-handoff";
import { isRecoveredProviderCredentialReuseSelectionKey } from "../../onboard/recovered-provider-reuse";
import {
  type AmbientRecreateEnvAssessment,
  assessAmbientRecreateEnv,
  sanitizeEnvValueForDisplay,
} from "./rebuild-env-isolation";

const { LOCAL_INFERENCE_PROVIDERS, REMOTE_PROVIDER_CONFIG } =
  require("../../onboard/providers") as {
    LOCAL_INFERENCE_PROVIDERS: string[];
    REMOTE_PROVIDER_CONFIG: Record<
      string,
      { providerName: string; credentialEnv: string | null; endpointUrl?: string | null }
    >;
  };

type RebuildEndpoint = { known: true; endpointUrl: string | null } | { known: false };

/** Providers that run on the host and carry no host-side credential env. */
export function isLocalInferenceProvider(provider: string | null | undefined): provider is string {
  return Boolean(provider && LOCAL_INFERENCE_PROVIDERS.includes(provider));
}

function canonicalRemoteProviderConfig(provider: string | null | undefined): {
  providerName: string;
  credentialEnv: string | null;
  endpointUrl?: string | null;
} | null {
  if (!provider) return null;
  return (
    (provider === "nvidia-nim"
      ? REMOTE_PROVIDER_CONFIG.build
      : Object.values(REMOTE_PROVIDER_CONFIG).find((entry) => entry.providerName === provider)) ||
    null
  );
}

function validCredentialEnvName(value: string | null | undefined): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return /^[A-Z_][A-Z0-9_]*$/.test(normalized) ? normalized : null;
}

function providerNameFromEnvHint(value: string | null | undefined): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  const hint = raw.toLowerCase();
  const config = Object.entries(REMOTE_PROVIDER_CONFIG).find(
    ([key, config]) => key.toLowerCase() === hint || config.providerName.toLowerCase() === hint,
  )?.[1];
  return config?.providerName ?? null;
}

function providerRecordedCredentialEnv(
  provider: string | null | undefined,
  recordedCredentialEnv?: string | null,
): string | null {
  const envName = validCredentialEnvName(recordedCredentialEnv);
  switch (provider) {
    case "compatible-endpoint":
      return envName === "COMPATIBLE_API_KEY" ? envName : null;
    case "compatible-anthropic-endpoint":
      return envName === "COMPATIBLE_ANTHROPIC_API_KEY" ? envName : null;
    case "nvidia-router":
      return envName;
    default:
      return null;
  }
}

/** Resolve the credential environment variable required to recreate a sandbox. */
export function getRebuildCredentialEnvFromRegistry(
  provider: string | null | undefined,
  recordedCredentialEnv?: string | null,
): string | null {
  if (!provider || isLocalInferenceProvider(provider)) return null;
  const remoteConfig = canonicalRemoteProviderConfig(provider);
  if (remoteConfig?.credentialEnv) return remoteConfig.credentialEnv;
  return providerRecordedCredentialEnv(provider, recordedCredentialEnv);
}

// Providers whose inference base URL is supplied by the operator at onboard time
// and cannot be re-derived from a canonical provider endpoint.
const SESSION_ONLY_ENDPOINT_PROVIDER_NAMES = new Set(
  [
    REMOTE_PROVIDER_CONFIG.custom?.providerName,
    REMOTE_PROVIDER_CONFIG.anthropicCompatible?.providerName,
    "compatible-endpoint",
    "compatible-anthropic-endpoint",
  ].filter((value): value is string => typeof value === "string" && value.length > 0),
);

export function canonicalCustomEndpointUrl(value: string | null | undefined): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  try {
    const url = new URL(raw);
    const supportedProtocol = url.protocol === "http:" || url.protocol === "https:";
    const hasUserInfo = Boolean(url.username || url.password);
    if (!supportedProtocol || hasUserInfo) return null;
    url.search = "";
    url.hash = "";
    const pathname = url.pathname.replace(/\/+$/, "");
    url.pathname = pathname || "/";
    return url.pathname === "/" ? url.origin : `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

/** Resolve the authoritative inference endpoint from durable registry metadata. */
export function getRebuildEndpointFromRegistry(
  provider: string | null | undefined,
  recordedEndpointUrl?: string | null,
): RebuildEndpoint {
  if (!provider || isLocalInferenceProvider(provider)) {
    return { known: true, endpointUrl: null };
  }
  if (SESSION_ONLY_ENDPOINT_PROVIDER_NAMES.has(provider)) {
    const endpointUrl = canonicalCustomEndpointUrl(recordedEndpointUrl);
    return endpointUrl ? { known: true, endpointUrl } : { known: false };
  }
  const remoteConfig = canonicalRemoteProviderConfig(provider);
  return { known: true, endpointUrl: remoteConfig?.endpointUrl || null };
}

function getExplicitTargetEndpointFromEnv(
  sandboxName: string,
  provider: string | null,
  model: string | null,
  env: NodeJS.ProcessEnv,
): string | null {
  if (!provider || !SESSION_ONLY_ENDPOINT_PROVIDER_NAMES.has(provider)) return null;
  if ((env.NEMOCLAW_SANDBOX_NAME || "").trim() !== sandboxName) return null;
  if (providerNameFromEnvHint(env.NEMOCLAW_PROVIDER) !== provider) return null;
  const envModel = typeof env.NEMOCLAW_MODEL === "string" ? env.NEMOCLAW_MODEL.trim() : "";
  if (model && envModel !== model) return null;
  return canonicalCustomEndpointUrl(env.NEMOCLAW_ENDPOINT_URL);
}

function getRegistryInferenceRoute(
  registrySelection: InferenceSelection,
  rebuildEndpoint: RebuildEndpoint,
): RegistryInferenceRoute | null {
  const recoveredProviderSelectionKey = Object.entries(REMOTE_PROVIDER_CONFIG).find(
    ([key, config]) =>
      isRecoveredProviderCredentialReuseSelectionKey(key) &&
      config.providerName === registrySelection.provider,
  )?.[0];
  const endpointRequired = SESSION_ONLY_ENDPOINT_PROVIDER_NAMES.has(
    registrySelection.provider ?? "",
  );
  if (
    !recoveredProviderSelectionKey ||
    !registrySelection.provider ||
    !registrySelection.model ||
    !registrySelection.preferredInferenceApi ||
    !rebuildEndpoint.known ||
    (endpointRequired && !rebuildEndpoint.endpointUrl)
  ) {
    return null;
  }
  return {
    provider: registrySelection.provider,
    model: registrySelection.model,
    endpointUrl: rebuildEndpoint.endpointUrl,
    preferredInferenceApi: registrySelection.preferredInferenceApi,
    source: "registry",
  };
}

/** Assess and report ambient selection env before any session or registry reads. */
export function assessRebuildAmbientEnv(
  sandboxName: string,
  rebuildAgent: string | null,
  log: (msg: string) => void,
): AmbientRecreateEnvAssessment {
  const ambient = assessAmbientRecreateEnv(rebuildAgent);
  if (ambient.presentVars.length > 0) {
    log(
      `Ambient onboard-selection env present (${ambient.presentVars.join(", ")}); will be isolated during recreate so '${sandboxName}' rebuilds from its registry config`,
    );
    if (ambient.agentMismatch) {
      console.log(
        `  ${D}Ignoring ambient NEMOCLAW_AGENT='${sanitizeEnvValueForDisplay(ambient.agentMismatch.envAgent)}' — ` +
          `rebuilding '${sandboxName}' as its recorded agent '${ambient.agentMismatch.registryAgent}'.${R}`,
      );
    }
  }
  return ambient;
}

/** Compute the credential, endpoint, and durable route inputs for rebuild preflight. */
export function assessRebuildInferencePreflight(options: {
  sandboxName: string;
  sessionMatchesSandbox: boolean;
  registrySelection: InferenceSelection;
  trustedSelection: InferenceSelection;
  env?: NodeJS.ProcessEnv;
}): {
  credentialEnv: string | null;
  rebuildEndpoint: RebuildEndpoint;
  explicitTargetEndpoint: string | null;
  registryInferenceRoute: RegistryInferenceRoute | null;
} {
  const rebuildEndpoint = getRebuildEndpointFromRegistry(
    options.trustedSelection.provider,
    options.registrySelection.endpointUrl,
  );
  const explicitTargetEndpoint =
    !options.sessionMatchesSandbox && !rebuildEndpoint.known
      ? getExplicitTargetEndpointFromEnv(
          options.sandboxName,
          options.trustedSelection.provider,
          options.trustedSelection.model,
          options.env ?? process.env,
        )
      : null;
  return {
    credentialEnv: getRebuildCredentialEnvFromRegistry(
      options.trustedSelection.provider,
      options.trustedSelection.credentialEnv,
    ),
    rebuildEndpoint,
    explicitTargetEndpoint,
    registryInferenceRoute: getRegistryInferenceRoute(options.registrySelection, rebuildEndpoint),
  };
}
