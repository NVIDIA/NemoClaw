// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as registry from "../state/registry";
import {
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

export interface PolicyContextPreset {
  name: string;
  description: string;
  allowedHostCategories: string[];
  source: "builtin" | "custom";
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

export interface AccessFailureInput {
  sandboxName: string;
  host: string;
  port?: number;
  error?: { code?: string; status?: number; message?: string };
}

export interface AccessFailureClassification {
  kind: AccessFailureKind;
  reason: string;
  nextStep: string;
  matchedPreset?: string;
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

function presetHostStems(presetName: string): string[] {
  const content = loadPreset(presetName);
  if (!content) return [];
  const stems = new Set<string>();
  for (const host of getPresetEndpoints(content)) {
    const normalised = normaliseHost(host);
    if (normalised) stems.add(normalised);
  }
  return Array.from(stems).sort();
}

function presetEntry(
  info: PresetInfo,
  source: PolicyContextPreset["source"],
): PolicyContextPreset {
  return {
    name: info.name,
    description: info.description,
    allowedHostCategories: presetHostStems(info.name),
    source,
  };
}

function partitionPresets(
  sandboxName: string,
  applied: ReadonlySet<string>,
): { active: PolicyContextPreset[]; unapplied: PolicyContextPreset[] } {
  const builtin = listPresets();
  const custom = listCustomPresets(sandboxName);
  const active: PolicyContextPreset[] = [];
  const unapplied: PolicyContextPreset[] = [];
  for (const info of builtin) {
    const entry = presetEntry(info, "builtin");
    (applied.has(info.name) ? active : unapplied).push(entry);
  }
  for (const info of custom) {
    active.push(presetEntry(info, "custom"));
  }
  return { active, unapplied };
}

function buildApprovalPath(sandboxName: string): PolicyContextApprovalPath {
  return {
    inspect: `nemoclaw ${sandboxName} policy list`,
    add: `nemoclaw ${sandboxName} policy add <preset>`,
    remove: `nemoclaw ${sandboxName} policy remove <preset>`,
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

export function buildPolicyContext(sandboxName: string): PolicyContext {
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

  const { active, unapplied } = partitionPresets(sandboxName, appliedNames);

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

function formatPresetLine(preset: PolicyContextPreset): string {
  const categories = preset.allowedHostCategories.length
    ? preset.allowedHostCategories.join(", ")
    : "(no host endpoints declared)";
  const sourceTag = preset.source === "custom" ? " [custom]" : "";
  const description = preset.description ? ` — ${preset.description}` : "";
  return `- \`${preset.name}\`${sourceTag}${description}\n  hosts: ${categories}`;
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
    "- `blocked-by-policy` — the host is not declared by any active preset",
    "- `missing-approval` — the host is declared but the request was refused with 401 or 403",
    "- `unsupported` — the capability is not offered by NemoClaw or OpenShell",
    "- `unknown` — none of the above apply; surface the underlying error",
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
  const ctx = buildPolicyContext(input.sandboxName);
  const matched = findMatchingPreset(input.host, ctx.activePresets);
  const status = input.error?.status;
  const code = input.error?.code;

  if (matched) {
    if (status !== undefined && MISSING_APPROVAL_STATUS_CODES.has(status)) {
      return {
        kind: "missing-approval",
        reason: `Host '${input.host}' is allowed by preset '${matched.name}' but the request returned ${String(status)}; credentials or scope are missing.`,
        nextStep: "Confirm the API token and scopes for this integration; the network path is open.",
        matchedPreset: matched.name,
      };
    }
    return {
      kind: "unknown",
      reason: `Host '${input.host}' is allowed by preset '${matched.name}' and the failure is not a policy block.`,
      nextStep: "Inspect the upstream error and retry once the underlying condition clears.",
      matchedPreset: matched.name,
    };
  }

  const knownPreset = findMatchingPreset(input.host, ctx.knownUnappliedPresets);
  if (knownPreset) {
    return {
      kind: "blocked-by-policy",
      reason: `Host '${input.host}' is declared by preset '${knownPreset.name}' but that preset is not applied to sandbox '${input.sandboxName}'.`,
      nextStep: `Run \`${ctx.approvalPath.add.replace("<preset>", knownPreset.name)}\` to allow this host.`,
      matchedPreset: knownPreset.name,
    };
  }

  if (status === 403 || isPolicyBlockErrorCode(code)) {
    return {
      kind: "blocked-by-policy",
      reason: `Host '${input.host}' is not declared by any preset known to NemoClaw and the request was refused (${code ?? `HTTP ${String(status ?? "unknown")}`}).`,
      nextStep: `Add a custom preset that allows this host or change the sandbox tier; see ${ctx.approvalPath.documentation}.`,
    };
  }

  if (status !== undefined && MISSING_APPROVAL_STATUS_CODES.has(status)) {
    return {
      kind: "missing-approval",
      reason: `Host '${input.host}' is not declared by any active preset and the request returned ${String(status)}.`,
      nextStep: "Add a preset that allows this host, then supply credentials.",
    };
  }

  return {
    kind: "unknown",
    reason: `Host '${input.host}' did not match any preset and the failure is not a known policy or approval signal.`,
    nextStep: `Inspect the upstream error and consult ${ctx.approvalPath.documentation}.`,
  };
}
