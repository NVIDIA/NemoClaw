// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as registry from "../state/registry";
import {
  getBaselineExclusionRuntimeStatus,
  getGatewayPresets,
  getPresetEndpoints,
  isAgentBasePreset,
  listCustomPresets,
  listPresets,
  loadPresetForSandbox,
} from ".";
import {
  BASELINE_EXCLUSION_SUPPORT_IMPACT,
  type BaselineExclusionRuntimeStatus,
} from "./baseline-exclusion";
import { hostStemsFromEndpoints } from "./host-redaction";
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
  | "agent-base"
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
   * OpenShell gateway. `verified`, `gateway-only`, and `agent-base` are
   * based on a live gateway probe. `registry-only` and `gateway-unavailable`
   * indicate that the agent cannot trust this preset as enforced policy.
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
  excludeBaseline: string;
  restoreBaseline: string;
  documentation: string;
}

export type PolicyContextExclusionStatus =
  | BaselineExclusionRuntimeStatus
  | "pending-exclude-repair"
  | "pending-restore-repair";

export interface PolicyContextExclusion {
  key: string;
  digest: string;
  acknowledgedAt: string | null;
  /**
   * `excluded` — the current baseline still defines this key at the reviewed
   * digest and the observed live policy omits it.
   * `content-changed` — a release redefined this key's content since
   * approval; rebuild fails closed and requires re-approval before the
   * exclusion applies again.
   * `no-longer-in-baseline` — the current baseline no longer defines this
   * key; the exclusion record is inert until restored or replaced.
   * `live-policy-*` — live enforcement is unreadable or still contains the
   * excluded key, so registry intent must not be treated as enforcement.
   * `agent-changed` — the approval belongs to a different agent baseline.
   * `pending-*-repair` — the live mutation was interrupted; its durable
   * journal blocks rebuild until the exact policy command reconciles it.
   */
  status: PolicyContextExclusionStatus;
  supportImpact: string;
}

export interface PolicyContext {
  sandboxName: string;
  tier: PolicyContextTier | null;
  activePresets: PolicyContextPreset[];
  knownUnappliedPresets: PolicyContextPreset[];
  baselineExclusions: PolicyContextExclusion[];
  approvalPath: PolicyContextApprovalPath;
  supportBoundaries: PolicyContextSupportBoundary[];
  generatedAt: string;
}

const POLICY_DOC_URL = "docs/network-policy/customize-network-policy.mdx";
const EXTERNAL_POLICY_ADD_PATH =
  "Ask the external policy authority to add or replace the policy entries required by `<preset>`.";
const EXTERNAL_POLICY_REMOVE_PATH =
  "Ask the external policy authority to remove the policy entries supplied by `<preset>`.";
const EXTERNAL_POLICY_RESTORE_PATH =
  "Ask the external policy authority to restore baseline policy entry `<key>`.";
const EXTERNAL_POLICY_EXCLUDE_PATH =
  "Run `nemoclaw <sandbox> policy exclude <key> --dry-run`, then ask the external policy authority to remove baseline policy entry `<key>`.";

function hostStemsFromContent(content: string | null | undefined): {
  public: string[];
  redactedCount: number;
} {
  if (!content) return { public: [], redactedCount: 0 };
  return hostStemsFromEndpoints(getPresetEndpoints(content));
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
    let verification = resolveVerification(info.name, isApplied, gatewayPresets);
    // A gateway-only catalog preset whose name collides with an agent
    // base-policy addition (e.g. Hermes `pypi`) is enforced by the agent's own
    // base policy, not registry drift. Classify it as `agent-base` so it is not
    // reported as drift and does not steer operators toward an unnecessary
    // `policy add`.
    // The apply path already prefers the agent-specific policy content, but it
    // would record the preset as operator-applied (#9079). Sibling base additions
    // with no catalog entry are never iterated here, so this only corrects the
    // incidental name-collision case.
    if (
      !isApplied &&
      verification === "gateway-only" &&
      isAgentBasePreset(sandboxName, info.name)
    ) {
      verification = "agent-base";
    }
    const enforcedNotApplied =
      !isApplied && (verification === "gateway-only" || verification === "agent-base");
    const entry = presetEntry(
      info,
      "builtin",
      loadPresetForSandbox(sandboxName, info.name),
      verification,
    );
    if (isApplied || enforcedNotApplied) {
      active.push(entry);
    } else {
      unapplied.push(entry);
    }
  }
  for (const info of customInfo) {
    const isApplied = applied.has(info.name);
    const verification = resolveVerification(info.name, isApplied, gatewayPresets);
    active.push(presetEntry(info, "custom", customByName.get(info.name) ?? null, verification));
  }
  return { active, unapplied };
}

function buildBaselineExclusions(
  sandboxName: string,
  transition: registry.BaselineExclusionTransition | null,
): PolicyContextExclusion[] {
  const pendingKey = transition?.exclusion.key ?? null;
  const byKey = new Map<string, PolicyContextExclusion>(
    registry.getBaselineExclusions(sandboxName).map((exclusion) => {
      const status: PolicyContextExclusionStatus =
        exclusion.key === pendingKey
          ? transition?.operation === "exclude"
            ? "pending-exclude-repair"
            : "pending-restore-repair"
          : getBaselineExclusionRuntimeStatus(sandboxName, exclusion);
      return [
        exclusion.key,
        {
          key: exclusion.key,
          digest: exclusion.digest,
          acknowledgedAt: exclusion.acknowledgedAt ?? null,
          status,
          supportImpact: BASELINE_EXCLUSION_SUPPORT_IMPACT,
        },
      ] as const;
    }),
  );
  if (transition) {
    const exclusion = transition.exclusion;
    byKey.set(exclusion.key, {
      key: exclusion.key,
      digest: exclusion.digest,
      acknowledgedAt: exclusion.acknowledgedAt ?? null,
      status:
        transition.operation === "exclude" ? "pending-exclude-repair" : "pending-restore-repair",
      supportImpact: BASELINE_EXCLUSION_SUPPORT_IMPACT,
    });
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function buildApprovalPath(
  sandboxName: string,
  externallyManaged: boolean,
): PolicyContextApprovalPath {
  return {
    inspect: `nemoclaw ${sandboxName} policy list`,
    add: externallyManaged
      ? EXTERNAL_POLICY_ADD_PATH
      : `nemoclaw ${sandboxName} policy add <preset>`,
    remove: externallyManaged
      ? EXTERNAL_POLICY_REMOVE_PATH
      : `nemoclaw ${sandboxName} policy remove <preset>`,
    excludeBaseline: externallyManaged
      ? EXTERNAL_POLICY_EXCLUDE_PATH.replace("<sandbox>", sandboxName)
      : `nemoclaw ${sandboxName} policy exclude <key> --dry-run`,
    restoreBaseline: externallyManaged
      ? EXTERNAL_POLICY_RESTORE_PATH
      : `nemoclaw ${sandboxName} policy restore <key>`,
    documentation: POLICY_DOC_URL,
  };
}

function buildSupportBoundaries(
  tier: PolicyContextTier | null,
  externallyManaged: boolean,
): PolicyContextSupportBoundary[] {
  return [
    {
      capability: "policy requirement selection and verification",
      owner: "nemoclaw",
      note: externallyManaged
        ? "NemoClaw selects preset and baseline requirements and verifies the live policy"
        : tier
          ? `tier: ${tier.label}`
          : "no tier recorded",
    },
    {
      capability: "host allowlist enforcement",
      owner: "openshell",
      note: "policy is enforced by the OpenShell gateway",
    },
    ...(externallyManaged
      ? [
          {
            capability: "policy mutation",
            owner: "external" as const,
            note: "the external policy authority applies each required add, remove, restore, or baseline exclusion to the live policy",
          },
          {
            capability: "Shields state and configuration lock",
            owner: "nemoclaw" as const,
            note: "NemoClaw retains Shields state and locks configuration after it verifies restrictive policy",
          },
        ]
      : [
          {
            capability: "Shields transition",
            owner: "nemoclaw" as const,
            note: "Shields up locks down mutable configuration",
          },
        ]),
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
 *   enforces something the registry does not list, `agent-base` when the
 *   gateway enforces an agent base-policy preset, or `gateway-unavailable`
 *   when no probe is available. Callers that require a trusted "is this host
 *   actually allowed?" answer must accept `verified`, `gateway-only`, and
 *   `agent-base` as gateway-confirmed states.
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
  const externallyManaged = sandbox?.policyAuthority === "externally-managed";
  const tierName = externallyManaged ? null : (sandbox?.policyTier ?? null);
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
    baselineExclusions: buildBaselineExclusions(
      sandboxName,
      sandbox?.baselineExclusionTransition ?? null,
    ),
    approvalPath: buildApprovalPath(sandboxName, externallyManaged),
    supportBoundaries: buildSupportBoundaries(tier, externallyManaged),
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
    case "agent-base":
      return "agent-base (enforced by the agent's base policy; not user-applied; `policy add` is unnecessary)";
    case "gateway-unavailable":
      return "gateway-unavailable";
  }
}

function exclusionStatusTag(status: PolicyContextExclusionStatus): string {
  switch (status) {
    case "excluded":
      return "excluded";
    case "content-changed":
      return "content-changed (release redefined this entry; rebuild requires re-approval)";
    case "no-longer-in-baseline":
      return "no-longer-in-baseline (record is inert)";
    case "baseline-unreadable":
      return "baseline-unreadable (current release scope could not be inspected)";
    case "agent-changed":
      return "agent-changed (approval belongs to a different agent baseline)";
    case "live-policy-unreadable":
      return "live-policy-unreadable (enforcement could not be inspected)";
    case "live-policy-mismatch":
      return "live-policy-mismatch (excluded key remains in the live policy)";
    case "pending-exclude-repair":
      return "repair-required (exclude transaction was interrupted; rebuild blocked)";
    case "pending-restore-repair":
      return "repair-required (restore transaction was interrupted; rebuild blocked)";
  }
}

function formatExclusionLine(
  exclusion: PolicyContextExclusion,
  sandboxName: string,
  restoreAction: string,
): string {
  const restore = restoreAction.startsWith("nemoclaw ")
    ? `\`nemoclaw ${sandboxName} policy restore ${exclusion.key}\``
    : restoreAction;
  return [
    `- \`${exclusion.key}\` — status: ${exclusionStatusTag(exclusion.status)}`,
    `  acknowledged: ${exclusion.acknowledgedAt ?? "(unknown)"}`,
    `  impact: ${exclusion.supportImpact}`,
    `  restore: ${restore}`,
  ].join("\n");
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

function formatApprovalAction(action: string): string {
  return action.startsWith("nemoclaw ") ? `\`${action}\`` : action;
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
  lines.push("## Baseline exclusions");
  if (ctx.baselineExclusions.length === 0) {
    lines.push("- none");
  } else {
    for (const exclusion of ctx.baselineExclusions) {
      lines.push(formatExclusionLine(exclusion, ctx.sandboxName, ctx.approvalPath.restoreBaseline));
    }
  }
  lines.push("");
  lines.push("## Approval and remediation");
  lines.push(`- inspect: \`${ctx.approvalPath.inspect}\``);
  lines.push(`- add a preset: ${formatApprovalAction(ctx.approvalPath.add)}`);
  lines.push(`- remove a preset: ${formatApprovalAction(ctx.approvalPath.remove)}`);
  lines.push(
    `- preview a baseline exclusion: ${formatApprovalAction(ctx.approvalPath.excludeBaseline)}`,
  );
  lines.push(
    `- restore a baseline entry: ${formatApprovalAction(ctx.approvalPath.restoreBaseline)}`,
  );
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
    "Preset status reflects registry and gateway agreement. `verified`, `gateway-only`, and `agent-base` mean the gateway confirms enforcement. `agent-base` identifies a preset from the agent's base policy rather than a user-applied preset. It is active, not drift, and does not need `policy add`. Treat `registry-only` and `gateway-unavailable` as advisory because the gateway has not confirmed the listed hosts.",
  );
  lines.push("");
  lines.push(`Generated at ${ctx.generatedAt}.`);
  return lines.join("\n") + "\n";
}
