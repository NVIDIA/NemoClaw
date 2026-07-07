// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import {
  HERMES_DASHBOARD_ENABLE_ENV,
  HERMES_DASHBOARD_INTERNAL_PORT_ENV,
  HERMES_DASHBOARD_PORT_ENV,
  HERMES_DASHBOARD_TUI_ENV,
} from "../../hermes-dashboard";
import {
  HERMES_INFERENCE_CREDENTIAL_ENV,
  HERMES_NOUS_API_KEY_CREDENTIAL_ENV,
  HERMES_PROVIDER_NAME,
} from "../../hermes-provider-auth";
import {
  isWebSearchProvider,
  type WebSearchConfig,
  type WebSearchProvider,
  webSearchProviderForConfig,
} from "../../inference/web-search";
import { resolveHermesDashboardOnboardState } from "../../onboard/hermes-dashboard";
import { hasInvalidSessionToolDisclosure, type Session } from "../../state/onboard-session";
import {
  DEFAULT_TOOL_DISCLOSURE,
  invalidRecordedToolDisclosure,
  normalizeToolDisclosure,
  type ToolDisclosure,
} from "../../tool-disclosure";
import { DCODE_AGENT_NAME } from "./rebuild-dcode-target";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";
import type { RebuildResumeConfig } from "./rebuild-resume-config";

export type RebuildDurableConfig = {
  fromDockerfile: string | null;
  fromDockerfileError: string | null;
  hermesAuthMethod: "oauth" | "api_key" | null;
  hermesAuthMethodError: string | null;
  webSearchConfig: WebSearchConfig | null;
  webSearchError: string | null;
  toolDisclosure: ToolDisclosure;
  toolDisclosureError: string | null;
};

export const REBUILD_HERMES_DASHBOARD_ENV_KEYS = [
  HERMES_DASHBOARD_ENABLE_ENV,
  HERMES_DASHBOARD_PORT_ENV,
  HERMES_DASHBOARD_INTERNAL_PORT_ENV,
  HERMES_DASHBOARD_TUI_ENV,
] as const;

export type RebuildHermesDashboardEnv = Partial<
  Record<(typeof REBUILD_HERMES_DASHBOARD_ENV_KEYS)[number], string>
>;

export type RebuildHermesDashboardResolution =
  | { ok: true; env: RebuildHermesDashboardEnv }
  | { ok: false; reason: string };

function validDashboardPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65535;
}

export function resolveRebuildHermesDashboardEnv(
  rebuildAgent: string | null,
  entry: RebuildSandboxEntry,
  controlUiPort: number | null,
): RebuildHermesDashboardResolution {
  if (
    entry.hermesDashboardEnabled !== undefined &&
    typeof entry.hermesDashboardEnabled !== "boolean"
  ) {
    return { ok: false, reason: "recorded hermesDashboardEnabled value is not boolean" };
  }
  if (rebuildAgent !== "hermes" || entry.hermesDashboardEnabled !== true) {
    return { ok: true, env: { [HERMES_DASHBOARD_ENABLE_ENV]: "0" } };
  }
  if (!validDashboardPort(entry.hermesDashboardPort)) {
    return { ok: false, reason: "recorded Hermes dashboard port is invalid or missing" };
  }
  if (!validDashboardPort(entry.hermesDashboardInternalPort)) {
    return { ok: false, reason: "recorded Hermes dashboard internal port is invalid or missing" };
  }
  if (entry.hermesDashboardTui !== undefined && typeof entry.hermesDashboardTui !== "boolean") {
    return { ok: false, reason: "recorded hermesDashboardTui value is not boolean" };
  }
  const env: RebuildHermesDashboardEnv = {
    [HERMES_DASHBOARD_ENABLE_ENV]: "1",
    [HERMES_DASHBOARD_PORT_ENV]: String(entry.hermesDashboardPort),
    [HERMES_DASHBOARD_INTERNAL_PORT_ENV]: String(entry.hermesDashboardInternalPort),
    [HERMES_DASHBOARD_TUI_ENV]: entry.hermesDashboardTui === true ? "1" : "0",
  };
  try {
    resolveHermesDashboardOnboardState({
      agentName: rebuildAgent,
      effectivePort: controlUiPort ?? 0,
      env,
      fail: (message): never => {
        throw new Error(message);
      },
    });
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, env };
}

function normalizeHermesAuthMethod(value: unknown): "oauth" | "api_key" | null {
  return value === "oauth" || value === "api_key" ? value : null;
}

function builtinWebSearchPolicyProviders(entry: RebuildSandboxEntry): WebSearchProvider[] {
  const customPolicyNames = new Set(entry.customPolicies?.map((policy) => policy.name) ?? []);
  return (["brave", "tavily"] as const).filter(
    (provider) => entry.policies?.includes(provider) === true && !customPolicyNames.has(provider),
  );
}

export function resolveRebuildDurableConfig(
  sandboxName: string,
  entry: RebuildSandboxEntry,
  session: Session | null,
  resolvedSelection: { provider: string | null; model: string | null } = {
    provider: entry.provider ?? null,
    model: entry.model ?? null,
  },
  requestedToolDisclosure?: ToolDisclosure,
  allowLegacyManagedImageRecovery = false,
): RebuildDurableConfig {
  const matchingSession =
    session?.sandboxName === sandboxName &&
    (!resolvedSelection.provider || session.provider === resolvedSelection.provider) &&
    (!resolvedSelection.model || session.model === resolvedSelection.model)
      ? session
      : null;
  const customPolicyNames = new Set(entry.customPolicies?.map((policy) => policy.name) ?? []);
  const policyProviders = builtinWebSearchPolicyProviders(entry);
  const migrationPolicyProviders =
    entry.webSearchEnabled === true || entry.agent !== DCODE_AGENT_NAME
      ? policyProviders
      : policyProviders.filter((provider) => provider === "brave");
  const recordedWebSearchProvider = entry.webSearchProvider;
  const validRecordedWebSearchProvider = isWebSearchProvider(recordedWebSearchProvider)
    ? recordedWebSearchProvider
    : null;
  const sessionWebSearchProvider =
    matchingSession?.webSearchConfig?.fetchEnabled === true
      ? webSearchProviderForConfig(matchingSession.webSearchConfig)
      : null;
  const webSearchEnabled =
    typeof entry.webSearchEnabled === "boolean"
      ? entry.webSearchEnabled
      : validRecordedWebSearchProvider !== null ||
        matchingSession?.webSearchConfig?.fetchEnabled === true ||
        migrationPolicyProviders.length > 0;
  let webSearchError: string | null = null;
  if (entry.webSearchEnabled !== undefined && typeof entry.webSearchEnabled !== "boolean") {
    webSearchError = "recorded webSearchEnabled value is not boolean";
  } else if (
    recordedWebSearchProvider !== undefined &&
    recordedWebSearchProvider !== null &&
    !isWebSearchProvider(recordedWebSearchProvider)
  ) {
    webSearchError = "recorded webSearchProvider value is invalid";
  } else if (!webSearchEnabled && validRecordedWebSearchProvider) {
    webSearchError = "recorded webSearchProvider is set while web search is disabled";
  } else if (
    webSearchEnabled &&
    !validRecordedWebSearchProvider &&
    !sessionWebSearchProvider &&
    migrationPolicyProviders.length > 1
  ) {
    webSearchError = "recorded web-search policies select more than one provider";
  }
  let webSearchProvider: WebSearchProvider | null = null;
  if (webSearchEnabled && !webSearchError) {
    webSearchProvider =
      validRecordedWebSearchProvider ??
      sessionWebSearchProvider ??
      migrationPolicyProviders[0] ??
      "brave";
    if (customPolicyNames.has(webSearchProvider)) {
      webSearchError = `managed web-search provider '${webSearchProvider}' conflicts with a custom same-name policy`;
      webSearchProvider = null;
    }
  }
  const recordedToolDisclosure =
    entry.toolDisclosure !== undefined && entry.toolDisclosure !== null
      ? entry.toolDisclosure
      : matchingSession?.toolDisclosure;
  const toolDisclosureError =
    invalidRecordedToolDisclosure(recordedToolDisclosure) ||
    ((entry.toolDisclosure === undefined || entry.toolDisclosure === null) &&
      hasInvalidSessionToolDisclosure(matchingSession))
      ? "recorded toolDisclosure value must be progressive or direct"
      : null;
  const toolDisclosure =
    requestedToolDisclosure ??
    normalizeToolDisclosure(recordedToolDisclosure) ??
    DEFAULT_TOOL_DISCLOSURE;
  const recordedFromDockerfile: unknown =
    entry.fromDockerfile !== undefined
      ? entry.fromDockerfile
      : (matchingSession?.metadata?.fromDockerfile ?? null);
  const fromDockerfileError =
    recordedFromDockerfile !== null &&
    recordedFromDockerfile !== undefined &&
    (typeof recordedFromDockerfile !== "string" || recordedFromDockerfile.length === 0)
      ? "recorded value is not a non-empty path"
      : allowLegacyManagedImageRecovery && recordedFromDockerfile
        ? "confirmed legacy managed-image recovery conflicts with a recorded custom --from image"
        : entry.fromDockerfile === undefined &&
            !recordedFromDockerfile &&
            !entry.nemoclawVersion &&
            !allowLegacyManagedImageRecovery
          ? "legacy registry entry cannot distinguish a managed image from a custom --from image"
          : null;
  let hermesAuthMethod =
    entry.hermesAuthMethod !== undefined
      ? normalizeHermesAuthMethod(entry.hermesAuthMethod)
      : normalizeHermesAuthMethod(matchingSession?.hermesAuthMethod);
  if (
    entry.hermesAuthMethod === undefined &&
    !matchingSession &&
    resolvedSelection.provider === HERMES_PROVIDER_NAME
  ) {
    if (entry.credentialEnv === HERMES_NOUS_API_KEY_CREDENTIAL_ENV) hermesAuthMethod = "api_key";
    if (entry.credentialEnv === HERMES_INFERENCE_CREDENTIAL_ENV) hermesAuthMethod = "oauth";
  }
  const hermesAuthMethodError =
    resolvedSelection.provider === HERMES_PROVIDER_NAME && hermesAuthMethod === null
      ? "cannot determine the recorded Hermes Provider authentication method"
      : null;

  return {
    fromDockerfile:
      typeof recordedFromDockerfile === "string" && recordedFromDockerfile
        ? recordedFromDockerfile
        : null,
    fromDockerfileError,
    hermesAuthMethod,
    hermesAuthMethodError,
    webSearchConfig:
      webSearchEnabled && webSearchProvider
        ? { fetchEnabled: true, provider: webSearchProvider }
        : null,
    webSearchError,
    toolDisclosure,
    toolDisclosureError,
  };
}

export function resolveRebuildDockerfile(
  fromDockerfile: string | null,
): { ok: true; path: string | null } | { ok: false; path: string; reason: string } {
  if (!fromDockerfile) return { ok: true, path: null };
  const resolved = path.resolve(fromDockerfile);
  try {
    if (!fs.statSync(resolved).isFile()) {
      return { ok: false, path: resolved, reason: "path is not a regular file" };
    }
    fs.accessSync(resolved, fs.constants.R_OK);
  } catch (err) {
    return {
      ok: false,
      path: resolved,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  return { ok: true, path: resolved };
}

export function validatedRebuildRegistryUpdate(
  resume: RebuildResumeConfig,
  durable: RebuildDurableConfig,
  fromDockerfile: string | null,
  credentialEnv: string | null,
): Partial<RebuildSandboxEntry> {
  // toolDisclosure is intentionally absent: this preflight update still
  // describes the running old image. Replacement onboarding commits the
  // requested mode only after creation succeeds; retry rollback keeps the old
  // registry value if recreation fails.
  return {
    provider: resume.provider,
    model: resume.model,
    endpointUrl: resume.endpointUrl,
    credentialEnv,
    preferredInferenceApi: resume.preferredInferenceApi,
    compatibleEndpointReasoning: resume.compatibleEndpointReasoning,
    nimContainer: resume.nimContainer,
    webSearchEnabled: durable.webSearchConfig?.fetchEnabled === true,
    webSearchProvider: durable.webSearchConfig
      ? webSearchProviderForConfig(durable.webSearchConfig)
      : null,
    fromDockerfile,
    hermesAuthMethod: durable.hermesAuthMethod,
  };
}
