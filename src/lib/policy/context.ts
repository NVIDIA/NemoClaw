// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as registry from "../state/registry";
import {
  getGatewayPresets,
  getPresetEndpoints,
  listCustomPresets,
  listPresets,
  loadPreset,
} from ".";
import { getTier } from "./tiers";

interface PresetInfo {
  file: string;
  name: string;
  description: string;
}

export type PolicyContextPresetVerification =
  | "verified"
  | "registry-only"
  | "gateway-only"
  | "gateway-unavailable";

export interface PolicyContextPreset {
  name: string;
  description: string;
  allowedHostCategories: string[];
  /**
   * Number of preset endpoints whose host stems were dropped from
   * {@link PolicyContextPreset.allowedHostCategories} by the internal-host
   * redaction filter (RFC1918, loopback, link-local, metadata, internal DNS).
   */
  redactedHostCount: number;
  source: "builtin" | "custom";
  /**
   * Source-of-truth state for whether this preset is enforced by the
   * OpenShell gateway. `verified` and `gateway-only` are based on a live
   * gateway probe; `registry-only` and `gateway-unavailable` indicate the
   * agent cannot trust this preset as enforced policy.
   */
  verification: PolicyContextPresetVerification;
}

export interface PolicyContextTier {
  name: string;
  label: string;
  description: string;
}

export interface PolicyContextSupportBoundary {
  capability: string;
  owner: "nemoclaw" | "openshell" | "agent" | "external";
  note?: string;
}

export interface PolicyContextApprovalPath {
  inspect: string;
  add: string;
  remove: string;
  documentation: string;
}

export interface PolicyContext {
  sandboxName: string;
  tier: PolicyContextTier | null;
  activePresets: PolicyContextPreset[];
  knownUnappliedPresets: PolicyContextPreset[];
  approvalPath: PolicyContextApprovalPath;
  supportBoundaries: PolicyContextSupportBoundary[];
  generatedAt: string;
}

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
}

export interface AccessFailureClassification {
  kind: AccessFailureKind;
  reason: string;
  nextStep: string;
  matchedPreset?: string;
  /**
   * `high` when the underlying signal unambiguously maps to {@link kind};
   * `low` when the same signal is consistent with another bucket and the
   * agent should treat the verdict as advisory (typical case: HTTP 403 on
   * a host that an active preset allows — could be auth failure or a
   * finer-grained policy denial from OpenShell).
   */
  confidence: "high" | "low";
}

const POLICY_DOC_URL = "docs/network-policy/customize-network-policy.mdx";

const POLICY_BLOCK_ERROR_CODES: ReadonlySet<string> = new Set([
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
]);

const MISSING_APPROVAL_STATUS_CODES: ReadonlySet<number> = new Set([401, 403]);

function normaliseHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

const INTERNAL_DNS_SUFFIXES: ReadonlyArray<string> = [
  ".local",
  ".internal",
  ".lan",
  ".home",
  ".home.arpa",
  ".corp",
  ".intra",
  ".intranet",
  ".localdomain",
];

const RESERVED_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "broadcasthost",
]);

function looksLikeInternalIPv4(host: string): boolean {
  const octets = host.split(".");
  if (octets.length !== 4) return false;
  const parsed = octets.map((octet) => Number(octet));
  if (parsed.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parsed;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 192 && b === 0 && parsed[2] === 0) return true;
  if (a >= 224) return true;
  return false;
}

function looksLikeInternalIPv6(host: string): boolean {
  if (!host.includes(":")) return false;
  const normalised = host.toLowerCase();
  if (normalised === "::" || normalised === "::1") return true;
  if (normalised.startsWith("fe80:") || normalised.startsWith("fe80::")) return true;
  if (normalised.startsWith("fc") || normalised.startsWith("fd")) return true;
  if (normalised.startsWith("ff")) return true;
  return false;
}

function isInternalHost(host: string): boolean {
  if (!host) return false;
  if (RESERVED_HOSTS.has(host)) return true;
  if (looksLikeInternalIPv4(host)) return true;
  if (looksLikeInternalIPv6(host)) return true;
  for (const suffix of INTERNAL_DNS_SUFFIXES) {
    if (host === suffix.slice(1) || host.endsWith(suffix)) return true;
  }
  return false;
}

function hostStemsFromContent(content: string | null | undefined): {
  public: string[];
  redactedCount: number;
} {
  if (!content) return { public: [], redactedCount: 0 };
  const stems = new Set<string>();
  let redactedCount = 0;
  for (const host of getPresetEndpoints(content)) {
    const normalised = normaliseHost(host);
    if (!normalised) continue;
    if (isInternalHost(normalised)) {
      redactedCount += 1;
      continue;
    }
    stems.add(normalised);
  }
  return { public: Array.from(stems).sort(), redactedCount };
}

function presetEntry(
  info: PresetInfo,
  source: PolicyContextPreset["source"],
  content: string | null,
  verification: PolicyContextPresetVerification,
): PolicyContextPreset {
  const hosts = hostStemsFromContent(content);
  return {
    name: info.name,
    description: info.description,
    allowedHostCategories: hosts.public,
    redactedHostCount: hosts.redactedCount,
    source,
    verification,
  };
}

function resolveVerification(
  presetName: string,
  appliedLocally: boolean,
  gatewayPresets: ReadonlyArray<string> | null,
): PolicyContextPresetVerification {
  if (gatewayPresets === null) {
    return appliedLocally ? "gateway-unavailable" : "gateway-unavailable";
  }
  const enforced = gatewayPresets.includes(presetName);
  if (appliedLocally && enforced) return "verified";
  if (appliedLocally && !enforced) return "registry-only";
  if (!appliedLocally && enforced) return "gateway-only";
  return "gateway-unavailable";
}

/**
 * Split known presets into the active set (reported to agents as candidate
 * allow-listed integrations) and the unapplied set (suggested as
 * remediation targets). Two invariants:
 *
 * - Custom presets always land in `active`. They live in the registry's
 *   `customPolicies` array, which has no "applied vs unapplied" notion;
 *   their presence in the registry is itself the activation signal. They
 *   are still annotated with the gateway-verification state so an agent
 *   can tell whether the gateway actually enforces them.
 * - A built-in preset that the gateway enforces but the registry does
 *   not list (`gateway-only`) is reported as active so the agent does
 *   not misclassify allowed hosts as blocked. The advisory `verification`
 *   field discloses the drift.
 */
function partitionPresets(
  sandboxName: string,
  applied: ReadonlySet<string>,
  gatewayPresets: ReadonlyArray<string> | null,
): { active: PolicyContextPreset[]; unapplied: PolicyContextPreset[] } {
  const builtin = listPresets();
  const customInfo = listCustomPresets(sandboxName);
  const customByName = new Map(
    registry.getCustomPolicies(sandboxName).map((entry) => [entry.name, entry.content]),
  );
  const active: PolicyContextPreset[] = [];
  const unapplied: PolicyContextPreset[] = [];
  for (const info of builtin) {
    const isApplied = applied.has(info.name);
    const verification = resolveVerification(info.name, isApplied, gatewayPresets);
    const onGatewayOnly = !isApplied && verification === "gateway-only";
    const entry = presetEntry(info, "builtin", loadPreset(info.name), verification);
    if (isApplied || onGatewayOnly) {
      active.push(entry);
    } else {
      unapplied.push(entry);
    }
  }
  for (const info of customInfo) {
    const isApplied = applied.has(info.name);
    const verification = resolveVerification(info.name, isApplied, gatewayPresets);
    active.push(
      presetEntry(info, "custom", customByName.get(info.name) ?? null, verification),
    );
  }
  return { active, unapplied };
}

function buildApprovalPath(sandboxName: string): PolicyContextApprovalPath {
  return {
    inspect: `nemoclaw ${sandboxName} policy-list`,
    add: `nemoclaw ${sandboxName} policy-add <preset>`,
    remove: `nemoclaw ${sandboxName} policy-remove <preset>`,
    documentation: POLICY_DOC_URL,
  };
}

function buildSupportBoundaries(
  tier: PolicyContextTier | null,
): PolicyContextSupportBoundary[] {
  return [
    {
      capability: "preset selection",
      owner: "nemoclaw",
      note: tier ? `tier: ${tier.label}` : "no tier recorded",
    },
    {
      capability: "host allowlist enforcement",
      owner: "openshell",
      note: "policy is enforced by the OpenShell gateway",
    },
    {
      capability: "shields toggle",
      owner: "nemoclaw",
      note: "shields up locks down mutable config",
    },
    {
      capability: "credential storage",
      owner: "nemoclaw",
      note: "credentials are stored outside the policy context surface",
    },
    {
      capability: "ad-hoc host approval",
      owner: "external",
      note: "requests outside the applied presets require a new preset or tier change",
    },
  ];
}

export interface BuildPolicyContextOptions {
  /**
   * Inject a gateway-preset list (or null when the gateway is unreachable)
   * to bypass the live `openshell policy get` probe — exposed so unit tests
   * and callers that already hold the gateway snapshot can avoid an extra
   * subprocess call.
   */
  gatewayPresets?: ReadonlyArray<string> | null;
  /**
   * Skip the live gateway probe entirely; every preset is then reported with
   * `verification: "gateway-unavailable"`. Useful when the caller is on a
   * code path that must not spawn external processes.
   */
  skipGatewayProbe?: boolean;
}

function probeGatewayPresets(
  sandboxName: string,
  options: BuildPolicyContextOptions,
): ReadonlyArray<string> | null {
  if (options.gatewayPresets !== undefined) return options.gatewayPresets;
  if (options.skipGatewayProbe) return null;
  try {
    return getGatewayPresets(sandboxName);
  } catch {
    return null;
  }
}

/**
 * Build the agent-facing policy context for {@link sandboxName}.
 *
 * Source-of-truth model:
 *
 * - Active preset names are derived from the registry entry
 *   (`sandbox.policies` + `sandbox.customPolicies`). The OpenShell gateway
 *   is the actual enforcement boundary, so each preset is also annotated
 *   with a {@link PolicyContextPresetVerification} state: `verified` when
 *   the gateway snapshot agrees, `registry-only` when the gateway does
 *   not enforce the preset (drift), `gateway-only` when the gateway
 *   enforces something the registry does not list, or
 *   `gateway-unavailable` when no probe is available. Callers that
 *   require a trusted "is this host actually allowed?" answer must look
 *   at `verification === "verified"`; everything else is advisory.
 *
 * - Host stems are extracted by {@link hostStemsFromContent}, which
 *   redacts RFC1918, loopback, link-local, metadata, and internal-DNS
 *   addresses. The redaction count is preserved on the preset entry so
 *   the renderer can disclose that hosts were dropped without leaking
 *   the stems themselves.
 *
 * - The gateway probe is optional and configurable via
 *   {@link BuildPolicyContextOptions}. Callers on cold paths (e.g. the
 *   classifier) pass `skipGatewayProbe: true` to avoid spawning
 *   `openshell policy get` and accept the resulting
 *   `gateway-unavailable` annotation.
 *
 * - Regression coverage lives in `src/lib/policy/context.test.ts`. When
 *   the verification annotation or redaction set changes, update those
 *   tests in the same patch.
 */
export function buildPolicyContext(
  sandboxName: string,
  options: BuildPolicyContextOptions = {},
): PolicyContext {
  const sandbox = registry.getSandbox(sandboxName);
  const tierName = sandbox?.policyTier ?? null;
  const tierDef = tierName ? getTier(tierName) : null;
  const tier: PolicyContextTier | null = tierDef
    ? { name: tierDef.name, label: tierDef.label, description: tierDef.description }
    : null;

  const appliedNames = new Set<string>(sandbox?.policies ?? []);
  for (const entry of sandbox?.customPolicies ?? []) {
    appliedNames.add(entry.name);
  }

  const gatewayPresets = probeGatewayPresets(sandboxName, options);
  const { active, unapplied } = partitionPresets(sandboxName, appliedNames, gatewayPresets);

  return {
    sandboxName,
    tier,
    activePresets: active.sort((a, b) => a.name.localeCompare(b.name)),
    knownUnappliedPresets: unapplied.sort((a, b) => a.name.localeCompare(b.name)),
    approvalPath: buildApprovalPath(sandboxName),
    supportBoundaries: buildSupportBoundaries(tier),
    generatedAt: new Date().toISOString(),
  };
}

function verificationTag(verification: PolicyContextPresetVerification): string {
  switch (verification) {
    case "verified":
      return "verified";
    case "registry-only":
      return "registry-only (gateway does not enforce)";
    case "gateway-only":
      return "gateway-only (not in local registry)";
    case "gateway-unavailable":
      return "gateway-unavailable";
  }
}

function formatPresetLine(preset: PolicyContextPreset): string {
  const categories = preset.allowedHostCategories.length
    ? preset.allowedHostCategories.join(", ")
    : "(no host endpoints declared)";
  const sourceTag = preset.source === "custom" ? " [custom]" : "";
  const description = preset.description ? ` — ${preset.description}` : "";
  const redactedNote =
    preset.redactedHostCount > 0
      ? ` (${String(preset.redactedHostCount)} internal host stem(s) redacted)`
      : "";
  return [
    `- \`${preset.name}\`${sourceTag}${description}`,
    `  status: ${verificationTag(preset.verification)}`,
    `  hosts: ${categories}${redactedNote}`,
  ].join("\n");
}

export function renderPolicyContextMarkdown(ctx: PolicyContext): string {
  const lines: string[] = [];
  lines.push(`# Sandbox policy context: ${ctx.sandboxName}`);
  lines.push("");
  lines.push(
    "This file is generated by NemoClaw. It summarises the network policy state",
    "of the sandbox so the agent can explain why a host or integration may be",
    "blocked and which remediation paths are available.",
  );
  lines.push("");
  lines.push("## Tier");
  if (ctx.tier) {
    lines.push(`- name: \`${ctx.tier.name}\` (${ctx.tier.label})`);
    lines.push(`- description: ${ctx.tier.description}`);
  } else {
    lines.push("- no tier recorded");
  }
  lines.push("");
  lines.push("## Active presets");
  if (ctx.activePresets.length === 0) {
    lines.push("- none");
  } else {
    for (const preset of ctx.activePresets) {
      lines.push(formatPresetLine(preset));
    }
  }
  lines.push("");
  lines.push("## Known unapplied presets");
  if (ctx.knownUnappliedPresets.length === 0) {
    lines.push("- none");
  } else {
    for (const preset of ctx.knownUnappliedPresets) {
      lines.push(`- \`${preset.name}\` — ${preset.description || "(no description)"}`);
    }
  }
  lines.push("");
  lines.push("## Approval and remediation");
  lines.push(`- inspect: \`${ctx.approvalPath.inspect}\``);
  lines.push(`- add a preset: \`${ctx.approvalPath.add}\``);
  lines.push(`- remove a preset: \`${ctx.approvalPath.remove}\``);
  lines.push(`- documentation: ${ctx.approvalPath.documentation}`);
  lines.push("");
  lines.push("## Support boundaries");
  for (const boundary of ctx.supportBoundaries) {
    const note = boundary.note ? ` — ${boundary.note}` : "";
    lines.push(`- ${boundary.capability} (owner: ${boundary.owner})${note}`);
  }
  lines.push("");
  lines.push("## Failure classification");
  lines.push(
    "When a host or integration attempt fails, classify it as:",
    "- `blocked-by-policy` — the host is not declared by any active preset, the request was refused with HTTP 403, or a network-block error code was returned",
    "- `missing-approval` — the host is declared by an active preset and the request was refused with HTTP 401 (treat HTTP 403 on an active host as ambiguous between missing credentials and a finer-grained policy denial)",
    "- `unsupported` — the capability is not offered by NemoClaw or OpenShell",
    "- `unknown` — none of the above apply; surface the underlying error",
  );
  lines.push("");
  lines.push(
    "Preset status reflects registry vs gateway agreement and is one of `verified`, `registry-only`, `gateway-only`, or `gateway-unavailable`. Treat anything other than `verified` as advisory; an agent must not assume the gateway enforces the listed hosts.",
  );
  lines.push("");
  lines.push(`Generated at ${ctx.generatedAt}.`);
  return lines.join("\n") + "\n";
}

function findMatchingPreset(
  host: string,
  presets: readonly PolicyContextPreset[],
): PolicyContextPreset | null {
  const normalised = normaliseHost(host);
  if (!normalised) return null;
  for (const preset of presets) {
    for (const candidate of preset.allowedHostCategories) {
      if (normalised === candidate || normalised.endsWith(`.${candidate}`)) {
        return preset;
      }
    }
  }
  return null;
}

function isPolicyBlockErrorCode(code: string | undefined): boolean {
  if (!code) return false;
  return POLICY_BLOCK_ERROR_CODES.has(code);
}

export function classifyAccessFailure(
  input: AccessFailureInput,
): AccessFailureClassification {
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
  const ctx = buildPolicyContext(input.sandboxName, { skipGatewayProbe: true });
  const matched = findMatchingPreset(input.host, ctx.activePresets);
  const status = input.error?.status;
  const code = input.error?.code;

  if (matched) {
    if (status === 401) {
      return {
        kind: "missing-approval",
        reason: `Host '${input.host}' is allowed by preset '${matched.name}' but the request returned 401; credentials are missing or invalid.`,
        nextStep: "Confirm the API token and scopes for this integration; the network path is open.",
        matchedPreset: matched.name,
        confidence: "high",
      };
    }
    if (status === 403) {
      return {
        kind: "missing-approval",
        reason: `Host '${input.host}' is allowed by preset '${matched.name}' but the request returned 403, which is ambiguous: it can mean missing credentials/scope or a finer-grained OpenShell denial (method, path, protocol, or binary).`,
        nextStep:
          "Confirm the API token and scopes first. If credentials look correct, run `${ctx.approvalPath.inspect}` and `openshell policy get` to check whether OpenShell is denying the specific method/path; widen the preset or adjust the call as needed.".replace(
            "${ctx.approvalPath.inspect}",
            ctx.approvalPath.inspect,
          ),
        matchedPreset: matched.name,
        confidence: "low",
      };
    }
    return {
      kind: "unknown",
      reason: `Host '${input.host}' is allowed by preset '${matched.name}' and the failure is not a policy block.`,
      nextStep: "Inspect the upstream error and retry once the underlying condition clears.",
      matchedPreset: matched.name,
      confidence: "high",
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
