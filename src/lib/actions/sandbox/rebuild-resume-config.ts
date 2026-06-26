// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// #5735: the pre-delete recreate "trust boundary" for `nemoclaw <name> rebuild`
// and installer `upgrade-sandboxes --auto`. Resolves and validates the exact
// agent/provider/model/credential/endpoint a rebuild will re-apply to the
// onboard session so `onboard --resume` recreates the *recorded* sandbox — never
// a different agent/provider steered by an unrelated onboard's ambient selection
// env or global session. Extracted from rebuild.ts so the trust-boundary logic
// is auditable on its own (PRA-5).

import { CLI_NAME } from "../../cli/branding";
import { RD as _RD, D, R } from "../../cli/terminal-style";
import { normalizeInferenceSelection } from "../../inference/selection";
import * as onboardSession from "../../state/onboard-session";
import {
  type AmbientRecreateEnvAssessment,
  assessAmbientRecreateEnv,
  sanitizeEnvValueForDisplay,
} from "./rebuild-env-isolation";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";

const { LOCAL_INFERENCE_PROVIDERS, REMOTE_PROVIDER_CONFIG } =
  require("../../onboard/providers") as {
    LOCAL_INFERENCE_PROVIDERS: string[];
    REMOTE_PROVIDER_CONFIG: Record<
      string,
      { providerName: string; credentialEnv: string | null; endpointUrl?: string | null }
    >;
  };
const hermesProviderAuth = require("../../hermes-provider-auth") as {
  HERMES_PROVIDER_NAME: string;
};

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
// (modelMode "input") and recorded only in that sandbox's own onboard session —
// there is no canonical or registry source to re-derive it from during a
// rebuild. These are the only providers for which a non-matching session makes
// the recreate endpoint unrecoverable. (#5735)
const SESSION_ONLY_ENDPOINT_PROVIDER_NAMES = new Set(
  [
    REMOTE_PROVIDER_CONFIG.custom?.providerName,
    REMOTE_PROVIDER_CONFIG.anthropicCompatible?.providerName,
    // Stable fallbacks in case the config keys are renamed.
    "compatible-endpoint",
    "compatible-anthropic-endpoint",
  ].filter((value): value is string => typeof value === "string" && value.length > 0),
);

/**
 * Resolve the authoritative inference endpoint for a sandbox's recorded provider
 * during rebuild (#5735). Returns `{ known: true, endpointUrl }` when the
 * recreate endpoint can be re-derived without the target's own onboard session —
 * a known remote provider with a canonical URL (e.g. nvidia-prod → NVIDIA
 * Endpoints), a local or routed (blueprint-derived) provider (no static URL to
 * pin), or a custom OpenAI/Anthropic-compatible provider with durable registry
 * metadata. Returns `{ known: false }` only for custom providers whose base URL
 * is absent from both the selected sandbox registry entry and its own session —
 * the caller must then refuse to destroy the sandbox from an unrelated session
 * rather than guess the endpoint.
 */
function canonicalCustomEndpointUrl(value: string | null | undefined): string | null {
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

export function getRebuildEndpointFromRegistry(
  provider: string | null | undefined,
  recordedEndpointUrl?: string | null,
): { known: true; endpointUrl: string | null } | { known: false } {
  if (!provider) return { known: true, endpointUrl: null };
  if (isLocalInferenceProvider(provider)) return { known: true, endpointUrl: null };
  // Custom OpenAI/Anthropic-compatible providers carry their base URL only in
  // the selected sandbox's durable metadata or its own onboard session; never
  // borrow the base URL from an unrelated session. Durable metadata is trusted
  // only after strict URL parsing, HTTP(S) scheme validation, and canonical
  // query/hash stripping at this pre-delete rebuild boundary.
  if (SESSION_ONLY_ENDPOINT_PROVIDER_NAMES.has(provider)) {
    const endpointUrl = canonicalCustomEndpointUrl(recordedEndpointUrl);
    return endpointUrl ? { known: true, endpointUrl } : { known: false };
  }
  const remoteConfig = canonicalRemoteProviderConfig(provider);
  // Known remote provider with a canonical endpoint → pin it. Otherwise (routed
  // inference, NIM, or any provider without a custom session-only URL) there is
  // no static URL to pin; the resume path derives it, so leave it unpinned.
  return { known: true, endpointUrl: remoteConfig?.endpointUrl || null };
}

/**
 * The exact agent/provider/model/credential/endpoint a rebuild will re-apply to
 * the onboard session so `onboard --resume` recreates the *recorded* sandbox
 * (#5735). Resolved entirely from the registry entry + onboard session — never
 * from ambient selection env.
 */
export interface RebuildResumeConfig {
  readonly agent: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly nimContainer: string | null;
  readonly credentialEnv: string | null;
  readonly preferredInferenceApi: string | null;
  /** Overwrite the session endpoint with `endpointUrl`; false keeps a matching session's own custom URL. */
  readonly pinEndpoint: boolean;
  readonly endpointUrl: string | null;
  readonly ambient: AmbientRecreateEnvAssessment;
}

/**
 * Resolve and validate the recreate config BEFORE any destructive backup/delete
 * (#5735). This is the single pre-delete trust boundary for the recreate: it
 * assesses ambient onboard-selection env, fails closed for a custom endpoint
 * whose base URL is only in another sandbox's session, and derives the exact
 * provider/model/credential/endpoint that the post-delete session rewrite +
 * `onboard --resume` will apply. Returns null (after `bail`) on a failed
 * precondition so the live sandbox is left intact.
 *
 * Why this is the achievable pre-delete validation rather than a literal
 * health-before-delete: OpenShell recreates with the SAME sandbox name, so the
 * old and new sandbox cannot run side by side — a replacement cannot be brought
 * up and verified while the original still exists. The full set of determinable
 * recreate preconditions is therefore validated before delete: credential
 * availability (`preflightRebuildCredentials`), config resolution +
 * custom-endpoint determinability (here), and the agent base image build
 * (`ensureRebuildAgentBaseImage`). The residual failure window — a transient
 * runtime fault inside `onboard` after all preconditions pass — is covered by
 * the preserved state backup and the printed recovery steps. Eliminating that
 * window needs an OpenShell capability to build/verify a replacement under a
 * temporary name before swapping; tracked as a follow-up.
 */
export function prepareRebuildResumeConfig(
  sandboxName: string,
  sb: RebuildSandboxEntry,
  rebuildAgent: string | null,
  log: (msg: string) => void,
  bail: (msg: string, code?: number) => never,
): RebuildResumeConfig | null {
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

  const session = onboardSession.loadSession();
  const sessionMatchesSandbox = session?.sandboxName === sandboxName;
  const registrySelection = normalizeInferenceSelection(sb);
  const rebuildEndpoint = getRebuildEndpointFromRegistry(
    registrySelection.provider,
    registrySelection.endpointUrl,
  );

  // When the loaded session belongs to a *different* sandbox (e.g. an
  // installer's just-completed onboard before `upgrade-sandboxes --auto`), the
  // target's inference endpoint can only be re-derived for providers with a
  // canonical endpoint (NVIDIA Endpoints, Anthropic, etc.), local inference,
  // routed inference, or durable custom endpoint metadata recorded on the target
  // registry entry. For legacy custom OpenAI-compatible entries without that
  // metadata, recreating would either fail or silently reconfigure against the
  // unrelated session's endpoint. Fail closed before any destructive work so the
  // sandbox stays live.
  if (
    !sessionMatchesSandbox &&
    registrySelection.provider &&
    !isLocalInferenceProvider(registrySelection.provider) &&
    registrySelection.provider !== hermesProviderAuth.HERMES_PROVIDER_NAME &&
    !rebuildEndpoint.known
  ) {
    console.error("");
    console.error(
      `  ${_RD}Rebuild preflight failed:${R} cannot determine the inference endpoint for provider '${registrySelection.provider}'.`,
    );
    console.error(
      `  The custom endpoint for '${sandboxName}' is recorded only in its own onboard session,`,
    );
    console.error(`  but the current session belongs to '${session?.sandboxName ?? "(none)"}'.`);
    console.error(`  Rebuild '${sandboxName}' directly so its session is loaded:`);
    console.error(`    ${CLI_NAME} ${sandboxName} rebuild`);
    console.error("");
    console.error("  Sandbox is untouched — no data was lost.");
    bail(
      `Cannot determine recreate endpoint for provider '${registrySelection.provider}' without a matching session`,
    );
    return null;
  }

  return {
    agent: rebuildAgent,
    provider: registrySelection.provider,
    model: registrySelection.model,
    nimContainer: registrySelection.nimContainer,
    credentialEnv: getRebuildCredentialEnvFromRegistry(
      registrySelection.provider,
      registrySelection.credentialEnv,
    ),
    preferredInferenceApi: registrySelection.preferredInferenceApi,
    pinEndpoint: !sessionMatchesSandbox && rebuildEndpoint.known,
    endpointUrl: rebuildEndpoint.known ? rebuildEndpoint.endpointUrl : null,
    ambient,
  };
}
