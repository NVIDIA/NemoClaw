// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

// Load YAML lazily via require to match the rest of the onboard pipeline
// (see src/lib/sandbox/config.ts and src/lib/policy/index.ts). Importing
// statically would force `yaml` into the CLI cold-start path even when no
// agents manifest is supplied.
type YamlLoader = { parse(input: string): unknown };
function loadYaml(): YamlLoader {
  return require("yaml") as YamlLoader;
}

const ALLOWED_TOP_KEYS = new Set<string>(["agents", "defaults", "main"]);
const AGENT_DATA_ROOT = "/sandbox/.openclaw";

// Defence-in-depth credential-name denylist: the authoritative reject lives
// at the build-time validator (scripts/generate-openclaw-config.mts) which
// only permits a small allowlist of nested keys. Even so, the host writes
// `NEMOCLAW_EXTRA_AGENTS_JSON` and the Dockerfile patcher base64-bakes the
// payload into `NEMOCLAW_EXTRA_AGENTS_JSON_B64` before the build runs. A
// pre-transport scan keeps obvious credential-named values from ever
// reaching the staged Dockerfile/build context if an operator accidentally
// drops `apiKey`, `token`, `clientSecret`, etc. into the YAML. We normalise
// the field name (lower-case, strip separators) so composite/camelCase
// variants such as `accessToken` or `private_key` are caught alongside the
// exact names.
const CREDENTIAL_NAME_SUBSTRINGS = [
  "apikey",
  "apitoken",
  "accesskey",
  "accesstoken",
  "refreshtoken",
  "sessiontoken",
  "bearertoken",
  "idtoken",
  "secretkey",
  "signingkey",
  "encryptionkey",
  "privatekey",
  "publickey",
  "token",
  "secret",
  "password",
  "passphrase",
  "credential",
  "bearer",
];
const CREDENTIAL_NAME_EXACT = new Set(["auth", "key"]);

function isCredentialName(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[-_]/g, "");
  if (CREDENTIAL_NAME_EXACT.has(normalised)) return true;
  return CREDENTIAL_NAME_SUBSTRINGS.some((needle) => normalised.includes(needle));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNoCredentialFields(value: unknown, label: string): void {
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (isCredentialName(key)) {
        throw new Error(
          `agents manifest field "${label}.${key}" looks like a credential and is not allowed; pass credentials through the OpenShell provider profile instead`,
        );
      }
      assertNoCredentialFields(child, `${label}.${key}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => {
      assertNoCredentialFields(child, `${label}[${index}]`);
    });
  }
}

function expectedAgentPath(kind: "workspace" | "agentDir", id: string): string {
  const segment = kind === "workspace" ? `workspace-${id}` : `agents/${id}`;
  return `${AGENT_DATA_ROOT}/${segment}`;
}

function fillAgentDefaults(entry: Record<string, unknown>): Record<string, unknown> {
  const id = entry.id;
  if (typeof id !== "string" || !id) {
    return entry;
  }
  const out: Record<string, unknown> = { ...entry };
  if (out.workspace === undefined) {
    out.workspace = expectedAgentPath("workspace", id);
  }
  if (out.agentDir === undefined) {
    out.agentDir = expectedAgentPath("agentDir", id);
  }
  return out;
}

export interface AgentsManifestPayload {
  agents: unknown[];
  defaults?: unknown;
  main?: unknown;
}

/**
 * Load and shallow-shape-check the agents manifest YAML. Heavy validation
 * (shape of each agent entry, model-ref/provider match, allowlists) lives
 * at the build-time validator in scripts/generate-openclaw-config.mts so
 * the build is the single source of truth for structured errors. We only
 * surface obvious early errors (missing file, top-level shape) and
 * auto-fill canonical workspace/agentDir paths from the agent id so the
 * caller can write a terse YAML.
 */
export function loadAgentsManifest(filePath: string): AgentsManifestPayload {
  const resolved = path.resolve(filePath);
  let raw: string;
  try {
    // Single fs call avoids the existsSync/statSync/readFileSync TOCTOU
    // window CodeQL flags as a race (CWE-367): the manifest path can change
    // between the pre-check and the read on a shared filesystem.
    raw = fs.readFileSync(resolved, "utf-8");
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr?.code === "ENOENT") {
      throw new Error(`--agents path not found: ${resolved}`);
    }
    if (nodeErr?.code === "EISDIR") {
      throw new Error(`--agents must point to a file: ${resolved}`);
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`--agents read error: ${reason}`);
  }
  let parsed: unknown;
  try {
    parsed = loadYaml().parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`--agents YAML parse error: ${reason}`);
  }
  if (parsed === null || parsed === undefined) {
    return { agents: [] };
  }
  if (!isObject(parsed)) {
    throw new Error("agents manifest must be a YAML mapping (object) at the top level");
  }
  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_TOP_KEYS.has(key)) {
      const allowed = [...ALLOWED_TOP_KEYS].sort().join(", ");
      throw new Error(
        `agents manifest contains unsupported top-level field "${key}". Allowed: ${allowed}`,
      );
    }
  }
  const agentsRaw = parsed.agents;
  let agents: unknown[];
  if (agentsRaw === undefined || agentsRaw === null) {
    agents = [];
  } else if (!Array.isArray(agentsRaw)) {
    throw new Error("agents manifest 'agents' must be a list when present");
  } else {
    agents = agentsRaw.map((entry) => (isObject(entry) ? fillAgentDefaults(entry) : entry));
  }
  const out: AgentsManifestPayload = { agents };
  if (parsed.defaults !== undefined) {
    out.defaults = parsed.defaults;
  }
  if (parsed.main !== undefined) {
    out.main = parsed.main;
  }
  assertNoCredentialFields(out, "agents-manifest");
  return out;
}

/**
 * Read the manifest at `filePath` and set `NEMOCLAW_EXTRA_AGENTS_JSON` so
 * the downstream Dockerfile patcher can base64-encode and bake it. The
 * patcher does not parse or shape-check the payload (that is the build
 * validator's job), so structured errors raised here would mask the
 * authoritative build-time errors; we keep host-side checks light.
 */
export function applyAgentsManifestEnv(filePath: string): AgentsManifestPayload {
  const payload = loadAgentsManifest(filePath);
  process.env.NEMOCLAW_EXTRA_AGENTS_JSON = JSON.stringify(payload);
  return payload;
}
