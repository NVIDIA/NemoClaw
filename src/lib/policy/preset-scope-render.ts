// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isObjectRecord } from "../core/json-types";
import { redactFull, redactUrl } from "../security/redact";
import { URL_TOKEN_PATTERN } from "../security/redact-url";
import { type PolicyValue, parseNetworkPolicies } from "./preset-parsing";

type RuleScope = {
  action: "allow" | "deny";
  methods: string[];
  paths: string[];
};

type EndpointScope = {
  host: string;
  port?: number | string;
  protocol?: string;
  access?: string;
  tls?: string;
  enforcement?: string;
  rules: RuleScope[];
};

type PolicyScope = {
  name: string;
  endpoints: EndpointScope[];
  binaries: string[];
};

export type PresetScope = {
  policies: PolicyScope[];
};

type RenderPresetScopeOptions = {
  heading?: string;
};

const UNICODE_FORMAT_CONTROL = /^\p{Cf}$/u;

/** Render untrusted YAML scalars without allowing terminal-control sequences. */
export function escapeTerminalText(value: string): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      const isC0 = codePoint <= 0x1f;
      const isDeleteOrC1 = codePoint >= 0x7f && codePoint <= 0x9f;
      const isLineSeparator = codePoint === 0x2028 || codePoint === 0x2029;
      if (!isC0 && !isDeleteOrC1 && !isLineSeparator && !UNICODE_FORMAT_CONTROL.test(character)) {
        return character;
      }
      return `\\u{${codePoint.toString(16).padStart(4, "0")}}`;
    })
    .join("");
}

/** Redact credential-shaped content before rendering untrusted YAML scalars. */
function renderTerminalText(value: string): string {
  const redactedUrls = value.replace(URL_TOKEN_PATTERN, (url) => redactUrl(url) ?? "<REDACTED>");
  return escapeTerminalText(redactFull(redactedUrls));
}

function toStringOrUndefined(value: PolicyValue | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function toPortOrUndefined(value: unknown): number | string | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.length > 0) return value;
  return undefined;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") return [value];
  return [];
}

function collectRules(endpoint: Record<string, unknown>): RuleScope[] {
  const rawRules = endpoint.rules;
  if (!Array.isArray(rawRules)) return [];
  const out: RuleScope[] = [];
  for (const entry of rawRules) {
    if (!isObjectRecord(entry)) continue;
    const action: "allow" | "deny" = "deny" in entry ? "deny" : "allow";
    const spec = entry[action];
    if (!isObjectRecord(spec)) continue;
    const methods = [...stringArray(spec.method), ...stringArray(spec.methods)];
    const paths = [...stringArray(spec.path), ...stringArray(spec.paths)];
    out.push({
      action,
      methods: methods.length > 0 ? methods : ["*"],
      paths: paths.length > 0 ? paths : ["/**"],
    });
  }
  return out;
}

function collectBinaries(policy: Record<string, unknown>): string[] {
  const binaries = policy.binaries;
  if (!Array.isArray(binaries)) return [];
  const out: string[] = [];
  for (const entry of binaries) {
    if (typeof entry === "string") {
      out.push(entry);
      continue;
    }
    if (isObjectRecord(entry) && typeof entry.path === "string") out.push(entry.path);
  }
  return out;
}

function extractPresetScope(content: string): PresetScope | null {
  const parsed = parseNetworkPolicies(content);
  if (!parsed) return null;
  const policies: PolicyScope[] = [];
  for (const [rawName, rawPolicy] of Object.entries(parsed)) {
    if (!isObjectRecord(rawPolicy)) continue;
    const name = typeof rawPolicy.name === "string" ? rawPolicy.name : rawName;
    const endpoints: EndpointScope[] = [];
    const rawEndpoints = rawPolicy.endpoints;
    if (Array.isArray(rawEndpoints)) {
      for (const rawEndpoint of rawEndpoints) {
        if (!isObjectRecord(rawEndpoint)) continue;
        const host = typeof rawEndpoint.host === "string" ? rawEndpoint.host : null;
        if (!host) continue;
        endpoints.push({
          host,
          port: toPortOrUndefined(rawEndpoint.port),
          protocol: toStringOrUndefined(rawEndpoint.protocol as PolicyValue | undefined),
          access: toStringOrUndefined(rawEndpoint.access as PolicyValue | undefined),
          tls: toStringOrUndefined(rawEndpoint.tls as PolicyValue | undefined),
          enforcement: toStringOrUndefined(rawEndpoint.enforcement as PolicyValue | undefined),
          rules: collectRules(rawEndpoint),
        });
      }
    }
    policies.push({ name, endpoints, binaries: collectBinaries(rawPolicy) });
  }
  return { policies };
}

function formatEndpoint(endpoint: EndpointScope): string[] {
  const port = renderTerminalText(String(endpoint.port ?? "?"));
  const modeBits: string[] = [];
  if (endpoint.access) modeBits.push(`access: ${renderTerminalText(endpoint.access)}`);
  if (endpoint.protocol) modeBits.push(`protocol: ${renderTerminalText(endpoint.protocol)}`);
  if (endpoint.tls) modeBits.push(`tls: ${renderTerminalText(endpoint.tls)}`);
  if (endpoint.enforcement) {
    modeBits.push(`enforcement: ${renderTerminalText(endpoint.enforcement)}`);
  }
  const modeSuffix = modeBits.length > 0 ? ` (${modeBits.join(", ")})` : "";
  const header = `      - ${renderTerminalText(endpoint.host)}:${port}${modeSuffix}`;
  if (endpoint.rules.length === 0) return [header];
  const ruleLines = endpoint.rules.map((rule) => {
    const methods = rule.methods.map(renderTerminalText).join(", ");
    const paths = rule.paths.map(renderTerminalText).join(", ");
    return `          ${rule.action}: ${methods}  ${paths}`;
  });
  return [header, ...ruleLines];
}

export function renderPresetScope(
  content: string,
  options: RenderPresetScopeOptions = {},
): string[] {
  const scope = extractPresetScope(content);
  if (!scope || scope.policies.length === 0) return [];
  const lines: string[] = [options.heading ?? "  Effective egress that would be opened:"];
  for (const policy of scope.policies) {
    lines.push(`    policy '${renderTerminalText(policy.name)}':`);
    if (policy.endpoints.length === 0) {
      lines.push("      (no endpoints declared)");
    } else {
      for (const endpoint of policy.endpoints) {
        lines.push(...formatEndpoint(endpoint));
      }
    }
    if (policy.binaries.length > 0) {
      lines.push("      binaries:");
      for (const bin of policy.binaries) {
        lines.push(`        - ${renderTerminalText(bin)}`);
      }
    }
  }
  return lines;
}

export function logPresetScope(
  content: string,
  logger: (line: string) => void = console.log,
): void {
  const lines = renderPresetScope(content);
  for (const line of lines) logger(line);
}
