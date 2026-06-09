// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  buildPolicyContext,
  type BuildPolicyContextOptions,
  type PolicyContext,
  type PolicyContextPreset,
} from "./context";
import { canonicaliseHost } from "./host-redaction";

export type AccessFailureKind =
  | "blocked-by-policy"
  | "missing-approval"
  | "unsupported"
  | "unknown";

export interface AccessFailureCapability {
  supported: boolean;
  reason?: string;
}

export interface AccessFailureInput {
  sandboxName: string;
  host: string;
  port?: number;
  error?: { code?: string; status?: number; message?: string };
  capability?: AccessFailureCapability;
  /**
   * Optional caller-provided context. When omitted, the classifier builds
   * its own context for `sandboxName`. Callers that already hold a
   * context (the explain command, the agent runtime) should pass it to
   * avoid a second registry/gateway probe and to keep the verification
   * status consistent with what the caller already rendered.
   */
  context?: PolicyContext;
  /**
   * Live OpenShell gateway snapshot. Honoured only when `context` is
   * absent. When neither is provided the classifier asks
   * {@link buildPolicyContext} for a fresh probe; tests that want to keep
   * the classifier sandbox-free pass `gatewayPresets: null` to force a
   * `gateway-unavailable` verdict.
   */
  gatewayPresets?: ReadonlyArray<string> | null;
}

export interface AccessFailureClassification {
  kind: AccessFailureKind;
  reason: string;
  nextStep: string;
  matchedPreset?: string;
  /**
   * `high` when the underlying signal unambiguously maps to {@link kind}
   * AND the matched preset (if any) was confirmed by a live gateway
   * probe. `low` when either the signal is ambiguous (notably HTTP 403
   * on an allowed host) or the matched preset is `registry-only` /
   * `gateway-unavailable`, in which case the agent must treat the
   * verdict as advisory.
   */
  confidence: "high" | "low";
}

const POLICY_BLOCK_ERROR_CODES: ReadonlySet<string> = new Set([
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
]);

const MISSING_APPROVAL_STATUS_CODES: ReadonlySet<number> = new Set([401, 403]);

function isPolicyBlockErrorCode(code: string | undefined): boolean {
  if (!code) return false;
  return POLICY_BLOCK_ERROR_CODES.has(code);
}

function findMatchingPreset(
  host: string,
  presets: readonly PolicyContextPreset[],
): PolicyContextPreset | null {
  const canonical = canonicaliseHost(host);
  if (!canonical) return null;
  for (const preset of presets) {
    for (const candidate of preset.allowedHostCategories) {
      if (canonical === candidate || canonical.endsWith(`.${candidate}`)) {
        return preset;
      }
    }
  }
  return null;
}

function isVerified(preset: PolicyContextPreset): boolean {
  return preset.verification === "verified" || preset.verification === "gateway-only";
}

function verificationNote(preset: PolicyContextPreset): string {
  if (isVerified(preset)) return "";
  if (preset.verification === "registry-only") {
    return " The local registry lists this preset but the OpenShell gateway is not enforcing it (drift); treat this verdict as advisory.";
  }
  return " The OpenShell gateway is unreachable, so this verdict is registry-derived and advisory.";
}

function resolveContext(input: AccessFailureInput): PolicyContext {
  if (input.context) return input.context;
  const options: BuildPolicyContextOptions =
    input.gatewayPresets === undefined ? {} : { gatewayPresets: input.gatewayPresets };
  return buildPolicyContext(input.sandboxName, options);
}

export function classifyAccessFailure(input: AccessFailureInput): AccessFailureClassification {
  if (input.capability && input.capability.supported === false) {
    const reason = input.capability.reason ?? "capability is not offered for this sandbox";
    return {
      kind: "unsupported",
      reason: `Host '${input.host}' is unreachable because the capability is unsupported: ${reason}.`,
      nextStep:
        "Surface the limitation to the user; do not retry. Choose an alternative provider or sandbox configuration that supports the capability.",
      confidence: "high",
    };
  }
  const ctx = resolveContext(input);
  const matched = findMatchingPreset(input.host, ctx.activePresets);
  const status = input.error?.status;
  const code = input.error?.code;

  if (matched) {
    const verified = isVerified(matched);
    const note = verificationNote(matched);
    if (status === 401) {
      return {
        kind: "missing-approval",
        reason: `Host '${input.host}' is allowed by preset '${matched.name}' but the request returned 401; credentials are missing or invalid.${note}`,
        nextStep: verified
          ? "Confirm the API token and scopes for this integration; the network path is open."
          : `Confirm the API token and scopes first, then run \`${ctx.approvalPath.inspect}\` to verify the gateway is enforcing '${matched.name}'.`,
        matchedPreset: matched.name,
        confidence: verified ? "high" : "low",
      };
    }
    if (status === 403) {
      return {
        kind: "missing-approval",
        reason: `Host '${input.host}' is allowed by preset '${matched.name}' but the request returned 403, which is ambiguous: it can mean missing credentials/scope or a finer-grained OpenShell denial (method, path, protocol, or binary).${note}`,
        nextStep: `Confirm the API token and scopes first. If credentials look correct, run \`${ctx.approvalPath.inspect}\` and \`openshell policy get\` to check whether OpenShell is denying the specific method/path; widen the preset or adjust the call as needed.`,
        matchedPreset: matched.name,
        confidence: "low",
      };
    }
    if (isPolicyBlockErrorCode(code)) {
      if (verified) {
        // Gateway confirmed the preset is active, so a network-block code
        // is an upstream failure (DNS hiccup, peer down, ICMP filter) —
        // not the gateway denying egress. The verdict stays `unknown` but
        // the wording explicitly rules out the policy-block reading the
        // doc/context surfaces, so the agent does not chase the wrong
        // remediation.
        return {
          kind: "unknown",
          reason: `Host '${input.host}' is allowed by preset '${matched.name}' and the OpenShell gateway confirmed enforcement, so the network-block code (${code}) is an upstream connectivity failure rather than a policy block.${note}`,
          nextStep: "Inspect the upstream error and retry once the underlying condition clears.",
          matchedPreset: matched.name,
          confidence: "high",
        };
      }
      // Registry-only or gateway-unavailable: the preset is listed locally
      // but the OpenShell gateway is either drifting or unreachable. A
      // network-block code on a host that *should* be allowed is the
      // strongest signal we have that the gateway is in fact blocking
      // egress to this host — surface it as `blocked-by-policy` so the
      // agent's remediation matches the doc taxonomy, with the
      // verification caveat baked into the wording and confidence
      // downgrade.
      return {
        kind: "blocked-by-policy",
        reason: `Host '${input.host}' is declared by preset '${matched.name}' but the request was refused with a network-block code (${code}) and the OpenShell gateway has not been confirmed to enforce this preset.${note}`,
        nextStep: `Run \`${ctx.approvalPath.inspect}\` to confirm the gateway is enforcing '${matched.name}'; if drift is confirmed, re-apply the preset via \`${ctx.approvalPath.add.replace("<preset>", matched.name)}\`.`,
        matchedPreset: matched.name,
        confidence: "low",
      };
    }
    return {
      kind: "unknown",
      reason: `Host '${input.host}' is allowed by preset '${matched.name}' and the failure is not a policy block.${note}`,
      nextStep: verified
        ? "Inspect the upstream error and retry once the underlying condition clears."
        : `Run \`${ctx.approvalPath.inspect}\` to confirm the gateway is enforcing '${matched.name}' before retrying.`,
      matchedPreset: matched.name,
      confidence: verified ? "high" : "low",
    };
  }

  const knownPreset = findMatchingPreset(input.host, ctx.knownUnappliedPresets);
  if (knownPreset) {
    return {
      kind: "blocked-by-policy",
      reason: `Host '${input.host}' is declared by preset '${knownPreset.name}' but that preset is not applied to sandbox '${input.sandboxName}'.`,
      nextStep: `Run \`${ctx.approvalPath.add.replace("<preset>", knownPreset.name)}\` to allow this host.`,
      matchedPreset: knownPreset.name,
      confidence: "high",
    };
  }

  if (status === 403 || isPolicyBlockErrorCode(code)) {
    return {
      kind: "blocked-by-policy",
      reason: `Host '${input.host}' is not declared by any preset known to NemoClaw and the request was refused (${code ?? `HTTP ${String(status ?? "unknown")}`}).`,
      nextStep: `Add a custom preset that allows this host or change the sandbox tier; see ${ctx.approvalPath.documentation}.`,
      confidence: "high",
    };
  }

  if (status !== undefined && MISSING_APPROVAL_STATUS_CODES.has(status)) {
    return {
      kind: "missing-approval",
      reason: `Host '${input.host}' is not declared by any active preset and the request returned ${String(status)}.`,
      nextStep: "Add a preset that allows this host, then supply credentials.",
      confidence: "low",
    };
  }

  return {
    kind: "unknown",
    reason: `Host '${input.host}' did not match any preset and the failure is not a known policy or approval signal.`,
    nextStep: `Inspect the upstream error and consult ${ctx.approvalPath.documentation}.`,
    confidence: "high",
  };
}
