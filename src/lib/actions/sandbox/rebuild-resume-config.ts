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
import type { RegistryInferenceRoute } from "../../onboard/rebuild-route-handoff";
import * as onboardSession from "../../state/onboard-session";
import type { AmbientRecreateEnvAssessment } from "./rebuild-env-isolation";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";
import {
  assessRebuildAmbientEnv,
  assessRebuildInferencePreflight,
  canonicalCustomEndpointUrl,
  isLocalInferenceProvider,
} from "./rebuild-resume-preflight";

export {
  getRebuildCredentialEnvFromRegistry,
  getRebuildEndpointFromRegistry,
  isLocalInferenceProvider,
} from "./rebuild-resume-preflight";

const hermesProviderAuth = require("../../hermes-provider-auth") as {
  HERMES_PROVIDER_NAME: string;
};

/**
 * The exact agent/provider/model/credential/endpoint a rebuild will re-apply to
 * the onboard session so `onboard --resume` recreates the *recorded* sandbox
 * (#5735). Resolved entirely from the registry entry + onboard session — never
 * from ambient selection env.
 */
export interface RebuildResumeConfig {
  readonly agent: string | null;
  readonly provider: string;
  readonly model: string;
  readonly nimContainer: string | null;
  readonly credentialEnv: string | null;
  readonly preferredInferenceApi: string | null;
  readonly compatibleEndpointReasoning: "true" | "false" | null;
  /**
   * Whether this endpoint was derived without trusting the matching onboard
   * session. Kept for preflight/tests; rebuild writes `endpointUrl`
   * unconditionally after validation so stale retry sessions cannot leak old
   * provider URLs into recreate (#4497/#5869).
   */
  readonly pinEndpoint: boolean;
  readonly endpointUrl: string | null;
  /** Durable pre-delete route used only for credential-safe provider recovery. */
  readonly registryInferenceRoute: RegistryInferenceRoute | null;
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
  const ambient = assessRebuildAmbientEnv(sandboxName, rebuildAgent, log);

  const session = onboardSession.loadSession();
  const sessionMatchesSandbox = session?.sandboxName === sandboxName;
  const registrySelection = normalizeInferenceSelection(sb);
  const matchingSessionSelection = sessionMatchesSandbox
    ? normalizeInferenceSelection(session)
    : null;
  const sessionSelectionMatchesRegistry = Boolean(
    matchingSessionSelection &&
      (!registrySelection.provider ||
        matchingSessionSelection.provider === registrySelection.provider) &&
      (!registrySelection.model || matchingSessionSelection.model === registrySelection.model),
  );
  const legacySelection = sessionSelectionMatchesRegistry ? matchingSessionSelection : null;
  const trustedSelection = normalizeInferenceSelection({
    provider: registrySelection.provider ?? legacySelection?.provider,
    model: registrySelection.model ?? legacySelection?.model,
    endpointUrl: registrySelection.endpointUrl,
    credentialEnv: registrySelection.credentialEnv ?? legacySelection?.credentialEnv,
    preferredInferenceApi:
      registrySelection.preferredInferenceApi ?? legacySelection?.preferredInferenceApi,
    compatibleEndpointReasoning:
      registrySelection.compatibleEndpointReasoning ?? legacySelection?.compatibleEndpointReasoning,
    nimContainer: registrySelection.nimContainer ?? legacySelection?.nimContainer,
  });
  if (!trustedSelection.provider || !trustedSelection.model) {
    console.error("");
    console.error(
      `  ${_RD}Rebuild preflight failed:${R} cannot determine the recorded inference provider and model.`,
    );
    console.error(
      `  Neither the '${sandboxName}' registry entry nor its own matching onboard session contains a complete selection.`,
    );
    console.error("  Sandbox is untouched — no data was lost.");
    bail("Cannot determine recorded inference provider and model for recreate");
    return null;
  }
  // Compatibility boundary for GH #2519: pre-fix local-provider sessions
  // could persist credentialEnv="OPENAI_API_KEY" even though local inference
  // never required a host credential. Only recognize the target sandbox's own
  // matching selection; a stale session for another provider or sandbox must
  // not influence the authoritative recreate config.
  if (
    legacySelection?.credentialEnv === "OPENAI_API_KEY" &&
    isLocalInferenceProvider(trustedSelection.provider)
  ) {
    console.log(
      `  ${D}Note: migrating ${trustedSelection.provider} sandbox off OPENAI_API_KEY (GH #2519). ` +
        `Local inference does not require a host API key.${R}`,
    );
    log(
      `Preflight: legacy ${trustedSelection.provider} sandbox detected (credentialEnv=OPENAI_API_KEY) — clearing for rebuild`,
    );
  }
  const compatibleEndpointReasoning = trustedSelection.compatibleEndpointReasoning;
  const { credentialEnv, rebuildEndpoint, explicitTargetEndpoint, registryInferenceRoute } =
    assessRebuildInferencePreflight({
      sandboxName,
      sessionMatchesSandbox,
      registrySelection,
      trustedSelection,
    });

  // When the loaded session belongs to a *different* sandbox (e.g. an
  // installer's just-completed onboard before `upgrade-sandboxes --auto`), the
  // target's inference endpoint can only be re-derived for providers with a
  // canonical endpoint (NVIDIA Endpoints, Anthropic, etc.), local inference,
  // routed inference, durable custom endpoint metadata recorded on the target
  // registry entry, or an explicit command-scoped custom endpoint whose
  // NEMOCLAW_SANDBOX_NAME/provider/model match this rebuild target. The latter
  // supports legacy registry rows that predate durable endpoint persistence
  // without borrowing from an unrelated onboard session; the value is validated
  // here and then written into the resume session before ambient env isolation.
  // Otherwise, recreating would either fail or silently reconfigure against the
  // unrelated session's endpoint. Fail closed before any destructive work so the
  // sandbox stays live.
  if (
    !sessionMatchesSandbox &&
    !isLocalInferenceProvider(trustedSelection.provider) &&
    trustedSelection.provider !== hermesProviderAuth.HERMES_PROVIDER_NAME &&
    !rebuildEndpoint.known &&
    !explicitTargetEndpoint
  ) {
    console.error("");
    console.error(
      `  ${_RD}Rebuild preflight failed:${R} cannot determine the inference endpoint for provider '${trustedSelection.provider}'.`,
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
      `Cannot determine recreate endpoint for provider '${trustedSelection.provider}' without a matching session`,
    );
    return null;
  }

  // Endpoint precedence at the destructive rebuild boundary:
  // 1. Durable/canonical registry metadata, when known.
  // 2. Explicit target-scoped env only for legacy rows whose loaded session is
  //    not this sandbox, after exact sandbox/provider/model checks and URL
  //    canonicalization.
  // 3. The target sandbox's own matching session endpoint, validated below.
  let endpointUrl = rebuildEndpoint.known ? rebuildEndpoint.endpointUrl : explicitTargetEndpoint;
  if (
    !endpointUrl &&
    !rebuildEndpoint.known &&
    sessionMatchesSandbox &&
    sessionSelectionMatchesRegistry
  ) {
    endpointUrl = canonicalCustomEndpointUrl(session?.endpointUrl);
  }
  if (!endpointUrl && !rebuildEndpoint.known) {
    console.error("");
    console.error(
      `  ${_RD}Rebuild preflight failed:${R} cannot validate the inference endpoint for provider '${trustedSelection.provider}'.`,
    );
    console.error(
      `  The custom endpoint for '${sandboxName}' is missing, invalid, or belongs to a conflicting onboard selection.`,
    );
    console.error("  Sandbox is untouched — no data was lost.");
    bail(
      `Cannot validate recreate endpoint for provider '${trustedSelection.provider}' from matching session`,
    );
    return null;
  }

  return {
    agent: rebuildAgent,
    provider: trustedSelection.provider,
    model: trustedSelection.model,
    nimContainer: trustedSelection.nimContainer,
    credentialEnv,
    // Preserve the recorded API family through the handoff. The provider
    // inference state compares it with the agent-required route and must see
    // the stale value to re-arm gateway provider setup before recreation.
    preferredInferenceApi: trustedSelection.preferredInferenceApi,
    compatibleEndpointReasoning,
    pinEndpoint: rebuildEndpoint.known || explicitTargetEndpoint !== null,
    endpointUrl,
    registryInferenceRoute,
    ambient,
  };
}
