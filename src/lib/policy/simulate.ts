// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Policy simulation engine.
 *
 * Statically evaluates a list of observed network requests against parsed
 * policy content. The engine is deliberately fail-closed: it claims a
 * request "matches an allow rule" only when every evaluated dimension is
 * proven from the trace row, and reports `unknown` whenever the policy
 * carries constraints this engine does not evaluate (protocol, allowed_ips,
 * TLS, ancestry, MCP, deny rules, …) or the trace row lacks a field a rule
 * constrains. It never consults live gateway state, so registry/gateway
 * drift is out of scope and callers must present results as static.
 *
 * Trace file format — one JSON object per line (JSONL):
 *   {"host":"api.slack.com","port":443,"method":"POST","path":"/api/chat.postMessage"}
 *
 * `host` is required per row; rows that are not valid JSON or lack a string
 * `host` are reported as invalid, not silently dropped.
 */

import YAML from "yaml";

import type { PolicyObject, PolicyValue } from "./preset-parsing";
import { isPolicyDocument, isPolicyObject } from "./preset-parsing";

export type SimulateVerdict = "allowed" | "blocked" | "uncovered" | "unknown";

export interface TraceRequest {
  host: string;
  port?: number;
  method?: string;
  path?: string;
  /** Optional label for display (e.g., which agent or command produced it) */
  label?: string;
}

export interface InvalidTraceLine {
  /** 1-based line number within the provided input. */
  line: number;
  reason: string;
  /** Truncated raw content for diagnosis. */
  excerpt: string;
}

export interface ParsedTrace {
  requests: TraceRequest[];
  invalidLines: InvalidTraceLine[];
}

export interface SimulateResult {
  request: TraceRequest;
  verdict: SimulateVerdict;
  /** Preset name whose allow rule was proven, when verdict is "allowed" */
  allowedBy?: string;
  /** Rule description, when verdict is "allowed" */
  matchedRule?: string;
  /** Why the verdict is "unknown", when it is */
  reason?: string;
}

export interface SimulationSummary {
  totalRequests: number;
  allowed: number;
  blocked: number;
  uncovered: number;
  unknown: number;
  invalidTraceLines: InvalidTraceLine[];
  results: SimulateResult[];
}

export interface PolicyEndpoint {
  host: string;
  port?: number | string;
  enforcement?: string;
  rules?: Array<{ allow?: { method?: string; path?: string } }>;
  /** Endpoint keys the engine recognized but does not evaluate. */
  unevaluatedConstraints?: string[];
}

export interface ParsedPreset {
  name: string;
  endpoints: PolicyEndpoint[];
}

/**
 * Endpoint keys this engine evaluates. Anything else on an endpoint (for
 * example `protocol`, `allowed_ips`, `tls`, `ancestry`, `mcp`) is a
 * constraint the engine cannot prove, so a would-be allow through that
 * endpoint degrades to `unknown` instead of over-claiming.
 */
const EVALUATED_ENDPOINT_KEYS = new Set(["host", "port", "enforcement", "rules"]);
const EVALUATED_RULE_KEYS = new Set(["allow"]);
const EVALUATED_ALLOW_KEYS = new Set(["method", "path"]);

/**
 * Match a glob pattern against a path or method string.
 * Supports `*` (any single path segment) and `**` (any number of segments).
 */
function globMatch(pattern: string, value: string): boolean {
  if (pattern === "**" || pattern === "*") return true;
  // Escape regex special chars except * which becomes .* or [^/]*
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<<<DOUBLESTAR>>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<<DOUBLESTAR>>>/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

/**
 * Match a hostname pattern against a host. For hostnames, `*` matches a
 * single DNS label (dots are separators), so `*.example.com` matches
 * `api.example.com` but not `a.b.example.com`. `**` crosses labels.
 */
function hostMatches(pattern: string, host: string): boolean {
  if (pattern === "**" || pattern === "*") return true;
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<<<DOUBLESTAR>>>")
    .replace(/\*/g, "[^.]*")
    .replace(/<<<DOUBLESTAR>>>/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(host);
}

type TriState = "match" | "no-match" | "unprovable";

/**
 * Fail-closed port comparison: an endpoint pinned to a specific port cannot
 * be proven to cover a trace row that omits the port.
 */
function portMatch(
  endpointPort: number | string | undefined,
  requestPort: number | undefined,
): TriState {
  if (endpointPort === undefined || endpointPort === "*") return "match";
  if (requestPort === undefined) return "unprovable";
  return Number(endpointPort) === requestPort ? "match" : "no-match";
}

/**
 * Fail-closed rule comparison: a rule that constrains method or path cannot
 * be proven to match a trace row that omits that field.
 */
function ruleMatch(
  rule: { allow?: { method?: string; path?: string } },
  method: string | undefined,
  reqPath: string | undefined,
): TriState {
  if (!rule.allow) return "no-match";
  const { method: ruleMethod, path: rulePath } = rule.allow;
  if (ruleMethod && ruleMethod !== "*" && ruleMethod !== "**") {
    if (method === undefined) return "unprovable";
    if (!globMatch(ruleMethod, method)) return "no-match";
  }
  if (rulePath && rulePath !== "/**" && rulePath !== "**") {
    if (reqPath === undefined) return "unprovable";
    if (!globMatch(rulePath, reqPath)) return "no-match";
  }
  return "match";
}

type EndpointDecision =
  | { verdict: "allowed"; rule: string }
  | { verdict: "blocked" }
  | { verdict: "unknown"; reason: string }
  | null;

/**
 * Evaluate one endpoint against a request. Returns:
 * - `{verdict: "allowed", rule}` when every evaluated dimension proves the
 *   endpoint covers and permits the request,
 * - `{verdict: "blocked"}` when the endpoint provably covers the host/port
 *   and every allow rule provably fails to match,
 * - `{verdict: "unknown", reason}` when coverage or a rule match cannot be
 *   proven (missing trace fields) or the endpoint/rule carries constraints
 *   this engine does not evaluate,
 * - `null` when the endpoint provably does not cover this host/port.
 */
function endpointDecision(endpoint: PolicyEndpoint, req: TraceRequest): EndpointDecision {
  if (!hostMatches(endpoint.host, req.host)) return null;
  const port = portMatch(endpoint.port, req.port);
  if (port === "no-match") return null;
  if (port === "unprovable") {
    return {
      verdict: "unknown",
      reason: `endpoint '${endpoint.host}' pins port ${endpoint.port} but the trace row has no port`,
    };
  }
  const unevaluated = endpoint.unevaluatedConstraints ?? [];
  if (endpoint.enforcement === "monitor") {
    if (unevaluated.length > 0) {
      return {
        verdict: "unknown",
        reason: `monitor endpoint '${endpoint.host}' carries unevaluated constraints: ${unevaluated.join(", ")}`,
      };
    }
    return { verdict: "allowed", rule: "monitor (allowed but observed)" };
  }
  if (!endpoint.rules || endpoint.rules.length === 0) {
    if (unevaluated.length > 0) {
      return {
        verdict: "unknown",
        reason: `endpoint '${endpoint.host}' carries unevaluated constraints: ${unevaluated.join(", ")}`,
      };
    }
    return { verdict: "allowed", rule: "default allow (no rules)" };
  }
  let sawUnprovable = false;
  for (const rule of endpoint.rules) {
    const match = ruleMatch(rule, req.method, req.path);
    if (match === "unprovable") {
      sawUnprovable = true;
      continue;
    }
    if (match === "match") {
      if (unevaluated.length > 0) {
        return {
          verdict: "unknown",
          reason: `endpoint '${endpoint.host}' carries unevaluated constraints: ${unevaluated.join(", ")}`,
        };
      }
      const m = rule.allow?.method ?? "*";
      const p = rule.allow?.path ?? "/**";
      return { verdict: "allowed", rule: `allow ${m} ${p}` };
    }
  }
  if (sawUnprovable) {
    return {
      verdict: "unknown",
      reason: `trace row lacks the method/path needed to evaluate rules on endpoint '${endpoint.host}'`,
    };
  }
  return { verdict: "blocked" };
}

/**
 * Accept an endpoint only when it has a string `host` and its `rules`
 * field, when present, is array-shaped. Mapping-shaped `rules` from
 * malformed YAML would otherwise crash the `for...of` in
 * {@link endpointDecision}. Endpoint and rule keys the engine does not
 * evaluate are recorded so allow verdicts through them degrade to
 * `unknown`.
 */
function toEvaluatedEndpoint(ep: PolicyValue): PolicyEndpoint | null {
  if (!isPolicyObject(ep)) return null;
  if (typeof ep["host"] !== "string") return null;
  const rules = ep["rules"];
  if (rules !== undefined && rules !== null && !Array.isArray(rules)) return null;

  const unevaluated = new Set<string>();
  for (const key of Object.keys(ep)) {
    if (!EVALUATED_ENDPOINT_KEYS.has(key)) unevaluated.add(key);
  }
  if (Array.isArray(rules)) {
    for (const rule of rules) {
      if (!isPolicyObject(rule)) {
        unevaluated.add("rules (non-mapping rule entry)");
        continue;
      }
      for (const key of Object.keys(rule)) {
        if (!EVALUATED_RULE_KEYS.has(key)) unevaluated.add(`rules.${key}`);
      }
      const allow = rule["allow"];
      if (allow !== undefined && !isPolicyObject(allow)) {
        unevaluated.add("rules.allow (non-mapping)");
        continue;
      }
      if (isPolicyObject(allow)) {
        for (const key of Object.keys(allow)) {
          if (!EVALUATED_ALLOW_KEYS.has(key)) unevaluated.add(`rules.allow.${key}`);
        }
      }
    }
  }

  const result = ep as PolicyObject & PolicyEndpoint;
  if (unevaluated.size > 0) {
    return { ...result, unevaluatedConstraints: [...unevaluated].sort() };
  }
  return result;
}

function extractEndpoints(policyMap: PolicyObject): ParsedPreset[] {
  const presets: ParsedPreset[] = [];
  for (const [presetName, presetVal] of Object.entries(policyMap)) {
    if (!isPolicyObject(presetVal)) continue;
    const networkPolicies = presetVal["network_policies"];
    const topLevelEndpoints = presetVal["endpoints"];

    // Support both preset-level endpoints and nested network_policies
    const policyBlock: PolicyObject = isPolicyObject(networkPolicies)
      ? networkPolicies
      : isPolicyObject(presetVal)
        ? presetVal
        : {};

    const endpoints: PolicyEndpoint[] = [];

    if (Array.isArray(topLevelEndpoints)) {
      for (const ep of topLevelEndpoints) {
        const evaluated = toEvaluatedEndpoint(ep);
        if (evaluated) endpoints.push(evaluated);
      }
    }

    for (const [, policyVal] of Object.entries(policyBlock)) {
      if (!isPolicyObject(policyVal)) continue;
      const epList = policyVal["endpoints"];
      if (!Array.isArray(epList)) continue;
      for (const ep of epList) {
        const evaluated = toEvaluatedEndpoint(ep);
        if (evaluated) endpoints.push(evaluated);
      }
    }

    if (endpoints.length > 0) presets.push({ name: presetName, endpoints });
  }
  return presets;
}

/**
 * Parse policy YAML content into a flat list of endpoint presets.
 * Pure: takes the file content, not a path. Throws a descriptive Error
 * when the content is not valid YAML.
 */
export function parsePolicyContent(content: string): ParsedPreset[] {
  let parsed: PolicyValue;
  try {
    parsed = YAML.parse(content) as PolicyValue;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid policy YAML: ${message}`);
  }
  if (!isPolicyDocument(parsed)) return [];

  const networkPolicies = parsed["network_policies"];
  if (!isPolicyObject(networkPolicies)) return [];

  return extractEndpoints(networkPolicies);
}

const INVALID_LINE_EXCERPT_LENGTH = 80;

/**
 * Parse JSONL trace lines. Blank lines and `#` comments are skipped;
 * anything else that is not a JSON object with a string `host` is reported
 * in `invalidLines` so malformed input can never silently shrink the trace.
 */
export function parseTraceLines(lines: string[]): ParsedTrace {
  const requests: TraceRequest[] = [];
  const invalidLines: InvalidTraceLine[] = [];
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const excerpt =
      trimmed.length > INVALID_LINE_EXCERPT_LENGTH
        ? `${trimmed.slice(0, INVALID_LINE_EXCERPT_LENGTH)}…`
        : trimmed;
    let obj: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        invalidLines.push({ line: index + 1, reason: "not a JSON object", excerpt });
        continue;
      }
      obj = parsed as Record<string, unknown>;
    } catch {
      invalidLines.push({ line: index + 1, reason: "not valid JSON", excerpt });
      continue;
    }
    if (typeof obj.host !== "string" || obj.host.length === 0) {
      invalidLines.push({ line: index + 1, reason: 'missing string "host" field', excerpt });
      continue;
    }
    requests.push({
      host: obj.host,
      port: typeof obj.port === "number" ? obj.port : undefined,
      method: typeof obj.method === "string" ? obj.method : undefined,
      path: typeof obj.path === "string" ? obj.path : undefined,
      label: typeof obj.label === "string" ? obj.label : undefined,
    });
  }
  return { requests, invalidLines };
}

/**
 * Evaluate a list of trace requests against the given presets.
 *
 * Per-request precedence is fail-closed: a proven allow wins; otherwise any
 * unprovable evaluation makes the request `unknown` (a firm block elsewhere
 * cannot outrank a possible allow); otherwise a proven covered-and-denied
 * endpoint yields `blocked`; otherwise `uncovered`.
 */
export function simulate(
  requests: TraceRequest[],
  presets: ParsedPreset[],
  invalidTraceLines: InvalidTraceLine[] = [],
): SimulationSummary {
  const results: SimulateResult[] = [];

  for (const req of requests) {
    let verdict: SimulateVerdict = "uncovered";
    let allowedBy: string | undefined;
    let matchedRule: string | undefined;
    let reason: string | undefined;

    for (const preset of presets) {
      for (const endpoint of preset.endpoints) {
        const decision = endpointDecision(endpoint, req);
        if (decision === null) continue;
        if (decision.verdict === "allowed") {
          verdict = "allowed";
          allowedBy = preset.name;
          matchedRule = decision.rule;
          reason = undefined;
          break;
        }
        if (decision.verdict === "unknown") {
          verdict = "unknown";
          reason = reason ?? `${preset.name}: ${decision.reason}`;
          continue;
        }
        if (verdict === "uncovered") verdict = "blocked";
      }
      if (verdict === "allowed") break;
    }

    results.push({ request: req, verdict, allowedBy, matchedRule, reason });
  }

  const count = (v: SimulateVerdict) => results.filter((r) => r.verdict === v).length;

  return {
    totalRequests: results.length,
    allowed: count("allowed"),
    blocked: count("blocked"),
    uncovered: count("uncovered"),
    unknown: count("unknown"),
    invalidTraceLines,
    results,
  };
}

/**
 * True when the summary contains anything an operator must act on before
 * trusting the trace as fully covered: blocked, uncovered, or unknown
 * requests, or trace rows that could not be parsed.
 */
export function summaryNeedsAttention(summary: SimulationSummary): boolean {
  return (
    summary.blocked > 0 ||
    summary.uncovered > 0 ||
    summary.unknown > 0 ||
    summary.invalidTraceLines.length > 0
  );
}

/**
 * Render a simulation summary as a human-readable report.
 */
export function renderSimulationReport(summary: SimulationSummary, json: boolean): string {
  if (json) return JSON.stringify(summary, null, 2);

  const lines: string[] = [];
  lines.push(`Policy Simulation (static) — ${summary.totalRequests} trace request(s) evaluated`);
  lines.push(
    `  Allowed: ${summary.allowed}  Blocked: ${summary.blocked}  Uncovered: ${summary.uncovered}` +
      `  Unknown: ${summary.unknown}  Invalid rows: ${summary.invalidTraceLines.length}`,
  );
  lines.push("");

  if (summary.invalidTraceLines.length > 0) {
    lines.push("INVALID TRACE ROWS (not evaluated)");
    for (const invalid of summary.invalidTraceLines) {
      lines.push(`  ! line ${invalid.line}: ${invalid.reason} — ${invalid.excerpt}`);
    }
    lines.push("");
  }

  const groups: Record<SimulateVerdict, SimulateResult[]> = {
    allowed: [],
    blocked: [],
    uncovered: [],
    unknown: [],
  };
  for (const r of summary.results) groups[r.verdict].push(r);

  if (groups.allowed.length > 0) {
    lines.push("ALLOWED (matches an allow rule on every evaluated dimension)");
    for (const r of groups.allowed) {
      const req = formatReq(r.request);
      lines.push(`  ✓ ${req}  → ${r.allowedBy} (${r.matchedRule})`);
    }
    lines.push("");
  }

  if (groups.blocked.length > 0) {
    lines.push("BLOCKED (covered by an endpoint whose rules deny it)");
    for (const r of groups.blocked) {
      lines.push(`  ✗ ${formatReq(r.request)}`);
    }
    lines.push("");
  }

  if (groups.unknown.length > 0) {
    lines.push("UNKNOWN (cannot be proven from the trace and evaluated dimensions)");
    for (const r of groups.unknown) {
      lines.push(`  ? ${formatReq(r.request)}`);
      if (r.reason) lines.push(`      ${r.reason}`);
    }
    lines.push("");
  }

  if (groups.uncovered.length > 0) {
    lines.push("UNCOVERED (no evaluated endpoint covers the request)");
    for (const r of groups.uncovered) {
      lines.push(`  - ${formatReq(r.request)}`);
    }
    lines.push("");
  }

  lines.push(
    "Note: this is a static evaluation of registered policy content over host, port, method, and",
  );
  lines.push(
    "path only. Constraints the engine does not evaluate are reported as UNKNOWN, and live",
  );
  lines.push("gateway state is not consulted, so registry/gateway drift is not detected.");

  return lines.join("\n");
}

function formatReq(req: TraceRequest): string {
  const port = req.port ? `:${req.port}` : "";
  const method = req.method ? `${req.method} ` : "";
  const reqPath = req.path ?? "";
  const label = req.label ? ` [${req.label}]` : "";
  return `${method}${req.host}${port}${reqPath}${label}`;
}
