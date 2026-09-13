// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// The generator loads this source directly in managed images. Use only Node
// built-ins so native TypeScript loading needs no additional image files.
import { isAbsolute, resolve } from "node:path";

type JsonObject = Record<string, unknown>;

export interface ExtraAgentTools {
  profile?: string;
  allow?: string[];
  deny?: string[];
}

export interface NormalizedExtraAgent {
  id: string;
  workspace: string;
  agentDir: string;
  tools: ExtraAgentTools;
  subagents?: JsonObject;
  description?: string;
  model?: string;
}
function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNoMaxSpawnDepth(value: unknown, label: string): void {
  if (!isObjectRecord(value) || !Object.hasOwn(value, "maxSpawnDepth")) return;
  throw new Error(
    `${label}.maxSpawnDepth is not accepted per-agent; OpenClaw honours it only on agents.defaults.subagents. Set it under the manifest 'defaults.subagents.maxSpawnDepth' instead.`,
  );
}

export function assertNoPerAgentMaxSpawnDepth(value: unknown): void {
  const agents = Array.isArray(value)
    ? value
    : isObjectRecord(value) && Array.isArray(value.agents)
      ? value.agents
      : [];
  agents.forEach((entry, index) => {
    if (!isObjectRecord(entry)) return;
    assertNoMaxSpawnDepth(entry.subagents, `NEMOCLAW_EXTRA_AGENTS_JSON.agents[${index}].subagents`);
  });
  if (isObjectRecord(value) && isObjectRecord(value.main)) {
    assertNoMaxSpawnDepth(value.main.subagents, "NEMOCLAW_EXTRA_AGENTS_JSON.main.subagents");
  }
}

export function assertNoPerAgentMaxSpawnDepthJson(raw: string | undefined): void {
  if (!raw?.trim()) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return;
  }
  assertNoPerAgentMaxSpawnDepth(parsed);
}

// Canonical primary-agent entry. Always written first into agents.list, always
// flagged default: true. Pinning the slot here prevents the extra-agents env
// from displacing the primary agent: OpenClaw's resolveDefaultAgentId falls
// back to agents[0] when no entry carries default: true, so a wholesale list
// replacement would silently re-elect the first extra agent.
//
// The entry intentionally omits workspace/agentDir so OpenClaw applies its
// built-in defaults (and so the host-side migration-state collector does not
// register a phantom host root for the in-sandbox path).
const MAIN_AGENT_ID = "main";
const MAIN_AGENT_ENTRY: Readonly<JsonObject> = Object.freeze({
  id: MAIN_AGENT_ID,
  default: true,
});
const AGENT_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
// Secondary agent paths must live under the canonical state dir
// (/sandbox/.openclaw/). The runtime startup script (scripts/nemoclaw-start.sh
// :: provision_agent_workspaces) discovers /sandbox/.openclaw/workspace-* and
// chowns them sandbox:sandbox on first boot. The legacy /sandbox/.openclaw-data
// path is migrated away on start, so it cannot host live agent state.
const AGENT_DATA_ROOT = "/sandbox/.openclaw";

// Per-agent paths must land in the canonical sandbox layout the runtime
// startup script provisions and the sandbox isolation policy expects:
//   workspace -> /sandbox/.openclaw/workspace-<agent-id>
//   agentDir  -> /sandbox/.openclaw/agents/<agent-id>
// Allowing arbitrary descendants of /sandbox/.openclaw/ would let an
// operator point an agent at the gateway state, the openclaw.json config,
// or a credentials directory, bypassing per-agent isolation and the
// `provision_agent_workspaces` helper that chowns `workspace-*` dirs to
// the sandbox user on first boot.
function expectedAgentPath(kind: "workspace" | "agentDir", id: string): string {
  const segment = kind === "workspace" ? `workspace-${id}` : `agents/${id}`;
  return resolve(AGENT_DATA_ROOT, segment);
}

// Allowlisted operator-supplied keys for a secondary-agent entry. The
// validator copies only these keys into the baked openclaw.json so an
// unknown or credential-like field added by mistake cannot be carried into
// the image (e.g. a stray `apiKey`, `token`, or `env`). Each nested object
// has its own allowlist below — the top-level filter alone is not enough,
// because operators could still smuggle `tools.apiKey` or
// `subagents.token` into the baked config.
const ALLOWED_EXTRA_AGENT_KEYS = new Set<string>([
  "id",
  "workspace",
  "agentDir",
  "tools",
  "subagents",
  "description",
  "model",
]);
const ALLOWED_TOOLS_KEYS = new Set<string>(["profile", "allow", "deny"]);
// Mirrors the OpenClaw per-agent `agents.list[].subagents` zod schema (see
// openclaw/src/config/zod-schema.agent-runtime.ts). OpenClaw uses
// .strict() on that object, so any field we do not list here would be
// rejected by the runtime parser at boot. `maxSpawnDepth` is intentionally
// absent: OpenClaw only accepts it on `agents.defaults.subagents`, never
// per-agent.
const ALLOWED_SUBAGENTS_KEYS = new Set<string>([
  "delegationMode",
  "allowAgents",
  "model",
  "thinking",
  "requireAgentId",
]);
const ALLOWED_AGENTS_DEFAULTS_KEYS = new Set<string>(["subagents"]);
const ALLOWED_DEFAULTS_SUBAGENTS_KEYS = new Set<string>(["maxSpawnDepth"]);
const ALLOWED_MAIN_KEYS = new Set<string>(["tools", "subagents"]);
const SUBAGENT_DELEGATION_MODES = new Set<string>(["suggest", "prefer"]);

function rejectUnknownKeys(obj: JsonObject, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(obj).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `${label} contains unsupported field(s): ${unknown.sort().join(", ")}. Allowed: ${[...allowed].sort().join(", ")}.`,
    );
  }
}

function pickAllowed(obj: JsonObject, allowed: Set<string>): JsonObject {
  const out: JsonObject = {};
  for (const key of allowed) {
    if (key in obj) {
      out[key] = obj[key];
    }
  }
  return out;
}

function validateExtraAgentTools(entry: JsonObject, label: string): ExtraAgentTools {
  const tools = entry.tools;
  if (!isObjectRecord(tools)) {
    throw new Error(
      `${label}.tools must be an object describing the per-agent tool policy (profile/allow/deny). Nothing is granted implicitly.`,
    );
  }
  rejectUnknownKeys(tools, ALLOWED_TOOLS_KEYS, `${label}.tools`);
  const allow = tools.allow;
  const deny = tools.deny;
  const hasAllow = Array.isArray(allow) && allow.length > 0;
  const hasDeny = Array.isArray(deny) && deny.length > 0;
  if (!hasAllow && !hasDeny) {
    throw new Error(
      `${label}.tools must declare a non-empty allow[] or deny[] (or both); secondary agents inherit no tools by default.`,
    );
  }
  for (const key of ["allow", "deny"] as const) {
    const value = tools[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((token) => typeof token !== "string" || !token)) {
      throw new Error(`${label}.tools.${key} must be an array of non-empty strings when present.`);
    }
  }
  if (tools.profile !== undefined && typeof tools.profile !== "string") {
    throw new Error(`${label}.tools.profile must be a string when present.`);
  }
  return pickAllowed(tools, ALLOWED_TOOLS_KEYS) as ExtraAgentTools;
}

function validateModelRef(label: string, raw: unknown, primaryProvider: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(`${label} must be a non-empty "provider/model" string when present`);
  }
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) {
    throw new Error(`${label} must be of the form "provider/model", got "${raw}"`);
  }
  const provider = raw.slice(0, slash);
  const modelTail = raw.slice(slash + 1);
  if (provider.trim() !== provider || provider.length === 0) {
    throw new Error(
      `${label} provider portion must be non-empty and contain no surrounding whitespace, got "${raw}"`,
    );
  }
  if (modelTail.trim() !== modelTail || modelTail.length === 0) {
    throw new Error(
      `${label} model portion must be non-empty and contain no surrounding whitespace, got "${raw}"`,
    );
  }
  if (provider !== primaryProvider) {
    throw new Error(
      `${label} provider "${provider}" must match the onboard provider "${primaryProvider}"; cross-provider manifests are not supported`,
    );
  }
  return raw;
}

function validateSubagentsBlock(raw: unknown, label: string, primaryProvider: string): JsonObject {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (!isObjectRecord(raw)) {
    throw new Error(
      `${label} must be an object with any of: ${[...ALLOWED_SUBAGENTS_KEYS].sort().join(", ")}`,
    );
  }
  rejectUnknownKeys(raw, ALLOWED_SUBAGENTS_KEYS, label);
  const out: JsonObject = {};
  if (raw.delegationMode !== undefined) {
    if (
      typeof raw.delegationMode !== "string" ||
      !SUBAGENT_DELEGATION_MODES.has(raw.delegationMode)
    ) {
      throw new Error(
        `${label}.delegationMode must be one of: ${[...SUBAGENT_DELEGATION_MODES].sort().join(", ")}`,
      );
    }
    out.delegationMode = raw.delegationMode;
  }
  if (raw.allowAgents !== undefined) {
    if (
      !Array.isArray(raw.allowAgents) ||
      raw.allowAgents.some((token) => typeof token !== "string" || !token)
    ) {
      throw new Error(`${label}.allowAgents must be an array of non-empty strings when present`);
    }
    out.allowAgents = [...raw.allowAgents];
  }
  if (raw.model !== undefined) {
    out.model = validateModelRef(`${label}.model`, raw.model, primaryProvider);
  }
  if (raw.thinking !== undefined) {
    if (typeof raw.thinking !== "string" || !raw.thinking) {
      throw new Error(`${label}.thinking must be a non-empty string when present`);
    }
    out.thinking = raw.thinking;
  }
  if (raw.requireAgentId !== undefined) {
    if (typeof raw.requireAgentId !== "boolean") {
      throw new Error(`${label}.requireAgentId must be a boolean when present`);
    }
    out.requireAgentId = raw.requireAgentId;
  }
  return out;
}

function validateAgentsDefaults(raw: unknown): {
  subagents: JsonObject;
} {
  if (raw === undefined || raw === null) {
    return { subagents: {} };
  }
  if (!isObjectRecord(raw)) {
    throw new Error(
      `NEMOCLAW_EXTRA_AGENTS_JSON.defaults must be an object (allowed: ${[...ALLOWED_AGENTS_DEFAULTS_KEYS].sort().join(", ")})`,
    );
  }
  rejectUnknownKeys(raw, ALLOWED_AGENTS_DEFAULTS_KEYS, "NEMOCLAW_EXTRA_AGENTS_JSON.defaults");
  const subagentsRaw = raw.subagents;
  if (subagentsRaw === undefined || subagentsRaw === null) {
    return { subagents: {} };
  }
  if (!isObjectRecord(subagentsRaw)) {
    throw new Error(
      `NEMOCLAW_EXTRA_AGENTS_JSON.defaults.subagents must be an object (allowed: ${[...ALLOWED_DEFAULTS_SUBAGENTS_KEYS].sort().join(", ")})`,
    );
  }
  rejectUnknownKeys(
    subagentsRaw,
    ALLOWED_DEFAULTS_SUBAGENTS_KEYS,
    "NEMOCLAW_EXTRA_AGENTS_JSON.defaults.subagents",
  );
  const out: JsonObject = {};
  if (subagentsRaw.maxSpawnDepth !== undefined) {
    const depth = subagentsRaw.maxSpawnDepth;
    if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 1 || depth > 5) {
      throw new Error(
        "NEMOCLAW_EXTRA_AGENTS_JSON.defaults.subagents.maxSpawnDepth must be an integer between 1 and 5 (OpenClaw schema)",
      );
    }
    out.maxSpawnDepth = depth;
  }
  return { subagents: out };
}

function validateMainOverrides(
  raw: unknown,
  primaryProvider: string,
): { tools?: ExtraAgentTools; subagents?: JsonObject } {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (!isObjectRecord(raw)) {
    throw new Error(
      `NEMOCLAW_EXTRA_AGENTS_JSON.main must be an object (allowed: ${[...ALLOWED_MAIN_KEYS].sort().join(", ")})`,
    );
  }
  rejectUnknownKeys(raw, ALLOWED_MAIN_KEYS, "NEMOCLAW_EXTRA_AGENTS_JSON.main");
  const out: { tools?: ExtraAgentTools; subagents?: JsonObject } = {};
  if (raw.tools !== undefined) {
    out.tools = validateExtraAgentTools({ tools: raw.tools }, "NEMOCLAW_EXTRA_AGENTS_JSON.main");
  }
  if (raw.subagents !== undefined) {
    const subagents = validateSubagentsBlock(
      raw.subagents,
      "NEMOCLAW_EXTRA_AGENTS_JSON.main.subagents",
      primaryProvider,
    );
    if (Object.keys(subagents).length > 0) {
      out.subagents = subagents;
    }
  }
  return out;
}

export type ExtraAgentsPayload = {
  agents: NormalizedExtraAgent[];
  defaults: { subagents: JsonObject };
  main: { tools?: ExtraAgentTools; subagents?: JsonObject };
};

export function validateExtraAgents(value: unknown, primaryProvider: string): ExtraAgentsPayload {
  if (value === null || value === undefined) {
    return { agents: [], defaults: { subagents: {} }, main: {} };
  }
  assertNoPerAgentMaxSpawnDepth(value);
  let agentsRaw: unknown;
  let defaultsRaw: unknown;
  let mainRaw: unknown;
  if (Array.isArray(value)) {
    // Legacy payload shape: bare array of secondary agents.
    agentsRaw = value;
  } else if (isObjectRecord(value)) {
    rejectUnknownKeys(
      value,
      new Set<string>(["agents", "defaults", "main"]),
      "NEMOCLAW_EXTRA_AGENTS_JSON",
    );
    agentsRaw = value.agents ?? [];
    defaultsRaw = value.defaults;
    mainRaw = value.main;
  } else {
    throw new Error(
      "NEMOCLAW_EXTRA_AGENTS_JSON must decode to a JSON array of agent objects or an object with {agents,defaults?,main?}",
    );
  }
  if (!Array.isArray(agentsRaw)) {
    throw new Error("NEMOCLAW_EXTRA_AGENTS_JSON.agents must be a JSON array of agent objects");
  }
  const seenIds = new Set<string>([MAIN_AGENT_ID]);
  const agents = agentsRaw.map((entry, index) => {
    const label = `NEMOCLAW_EXTRA_AGENTS_JSON.agents[${index}]`;
    if (!isObjectRecord(entry)) {
      throw new Error(`${label} must be a JSON object`);
    }
    const id = entry.id;
    if (typeof id !== "string" || !AGENT_ID_RE.test(id)) {
      throw new Error(
        `${label}.id must match ${AGENT_ID_RE} (1-32 chars, lowercase alphanumeric, dash, underscore; must start with a letter)`,
      );
    }
    if (id === MAIN_AGENT_ID) {
      throw new Error(
        `${label}.id "${MAIN_AGENT_ID}" is reserved for the primary agent; use a different id`,
      );
    }
    if (seenIds.has(id)) {
      throw new Error(`${label}.id "${id}" is duplicated; agent ids must be unique`);
    }
    seenIds.add(id);
    const canonicalPaths = {
      workspace: expectedAgentPath("workspace", id),
      agentDir: expectedAgentPath("agentDir", id),
    };
    for (const pathKey of ["workspace", "agentDir"] as const) {
      const pathValue = entry[pathKey];
      const expected = expectedAgentPath(pathKey, id);
      if (pathValue === undefined) {
        canonicalPaths[pathKey] = expected;
        continue;
      }
      if (typeof pathValue !== "string" || pathValue.length === 0) {
        throw new Error(`${label}.${pathKey} must be a non-empty string when present`);
      }
      if (!isAbsolute(pathValue)) {
        throw new Error(`${label}.${pathKey} must be an absolute path, got "${pathValue}"`);
      }
      if (resolve(pathValue) !== expected) {
        throw new Error(
          `${label}.${pathKey} must equal "${expected}" for agent id "${id}", got "${pathValue}"`,
        );
      }
      canonicalPaths[pathKey] = expected;
    }
    if (entry.default === true) {
      throw new Error(
        `${label}.default cannot be true; the primary "${MAIN_AGENT_ID}" agent is always the default`,
      );
    }
    rejectUnknownKeys(entry, ALLOWED_EXTRA_AGENT_KEYS, label);
    const tools = validateExtraAgentTools(entry, label);
    const subagents = validateSubagentsBlock(
      entry.subagents,
      `${label}.subagents`,
      primaryProvider,
    );
    // Build the canonical entry from a fresh object, never from the raw
    // operator input. This guarantees:
    //   - workspace/agentDir are the canonical strings (a dot-segment-laden
    //     path that resolves to the canonical target is normalised before
    //     bake, matching what provision_agent_workspaces parses);
    //   - only allowlisted keys reach the image, at every nesting level.
    const canonical: NormalizedExtraAgent = {
      id,
      workspace: canonicalPaths.workspace,
      agentDir: canonicalPaths.agentDir,
      tools,
    };
    if (Object.keys(subagents).length > 0) {
      canonical.subagents = subagents;
    }
    if (typeof entry.description === "string") {
      canonical.description = entry.description;
    }
    if (entry.model !== undefined) {
      canonical.model = validateModelRef(`${label}.model`, entry.model, primaryProvider);
    }
    return canonical;
  });
  return {
    agents,
    defaults: validateAgentsDefaults(defaultsRaw),
    main: validateMainOverrides(mainRaw, primaryProvider),
  };
}

export function buildAgentsList(
  extras: NormalizedExtraAgent[],
  mainOverrides: { tools?: ExtraAgentTools; subagents?: JsonObject },
): Array<JsonObject | NormalizedExtraAgent> {
  const main: JsonObject = { ...MAIN_AGENT_ENTRY };
  if (mainOverrides.tools !== undefined) {
    main.tools = mainOverrides.tools;
  }
  if (mainOverrides.subagents !== undefined) {
    main.subagents = mainOverrides.subagents;
  }
  return [main, ...extras];
}
