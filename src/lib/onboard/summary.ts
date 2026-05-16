// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  HERMES_NOUS_API_KEY_CREDENTIAL_ENV,
  HERMES_PROVIDER_NAME,
  type HermesAuthMethod,
} from "../hermes-provider-auth";
import type { WebSearchConfig } from "../inference/web-search";

const HERMES_AUTH_METHOD_OAUTH: HermesAuthMethod = "oauth";
const HERMES_AUTH_METHOD_API_KEY: HermesAuthMethod = "api_key";

export type SandboxBuildEstimateHost = {
  isContainerRuntimeUnderProvisioned: boolean;
  dockerCpus?: number;
  dockerMemTotalBytes?: number;
};

export type OnboardConfigSummary = {
  provider: string | null;
  model: string | null;
  credentialEnv?: string | null;
  hermesAuthMethod?: HermesAuthMethod | string | null;
  webSearchConfig?: WebSearchConfig | null;
  enabledChannels?: string[] | null;
  sandboxName: string;
  notes?: string[] | null;
};

function normalizeHermesAuthMethod(value: string | null | undefined): HermesAuthMethod | null {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (!normalized) return null;
  if (normalized === "oauth" || normalized === "nous_oauth" || normalized === "nous_portal_oauth") {
    return HERMES_AUTH_METHOD_OAUTH;
  }
  if (
    normalized === "api" ||
    normalized === "key" ||
    normalized === "api_key" ||
    normalized === "apikey" ||
    normalized === "nous_api_key"
  ) {
    return HERMES_AUTH_METHOD_API_KEY;
  }
  return null;
}

export function formatSandboxBuildEstimateNote(host: SandboxBuildEstimateHost): string | null {
  if (host.isContainerRuntimeUnderProvisioned) {
    return (
      "Container runtime is under-provisioned; the sandbox build may take 30+ minutes " +
      "or stall. See preflight warning above."
    );
  }
  const cpus = host.dockerCpus;
  const memBytes = host.dockerMemTotalBytes;
  if (typeof cpus === "number" && typeof memBytes === "number") {
    const memGiB = memBytes / 1024 ** 3;
    if (cpus >= 8 && memGiB >= 16) {
      return "Sandbox build typically takes 3–8 minutes on this host.";
    }
    return "Sandbox build typically takes 5–15 minutes on this host.";
  }
  return null;
}

export function formatOnboardConfigSummary({
  provider,
  model,
  credentialEnv = null,
  hermesAuthMethod = null,
  webSearchConfig = null,
  enabledChannels = null,
  sandboxName,
  notes = [],
}: OnboardConfigSummary): string {
  const bar = `  ${"─".repeat(50)}`;
  const messaging =
    Array.isArray(enabledChannels) && enabledChannels.length > 0
      ? enabledChannels.join(", ")
      : "none";
  const webSearch =
    webSearchConfig && webSearchConfig.fetchEnabled === true ? "enabled" : "disabled";
  const effectiveHermesAuthMethod =
    normalizeHermesAuthMethod(hermesAuthMethod) ||
    (provider === HERMES_PROVIDER_NAME && credentialEnv === HERMES_NOUS_API_KEY_CREDENTIAL_ENV
      ? HERMES_AUTH_METHOD_API_KEY
      : HERMES_AUTH_METHOD_OAUTH);
  const apiKeyLine =
    provider === HERMES_PROVIDER_NAME
      ? effectiveHermesAuthMethod === HERMES_AUTH_METHOD_API_KEY
        ? "  Nous API key: host-managed; sandbox receives inference placeholder only"
        : "  Nous OAuth:    host-managed; sandbox receives inference placeholder only"
      : credentialEnv
        ? `  API key:       ${credentialEnv} (staged for OpenShell gateway registration)`
        : `  API key:       (not required for ${provider ?? "this provider"})`;
  const noteLines = (Array.isArray(notes) ? notes : [])
    .filter((note) => typeof note === "string" && note.length > 0)
    .map((note) => `  Note:          ${note}`);
  return [
    "",
    bar,
    "  Review configuration",
    bar,
    `  Provider:      ${provider ?? "(unset)"}`,
    `  Model:         ${model ?? "(unset)"}`,
    apiKeyLine,
    `  Web search:    ${webSearch}`,
    `  Messaging:     ${messaging}`,
    `  Sandbox name:  ${sandboxName}`,
    ...noteLines,
    bar,
  ].join("\n");
}
