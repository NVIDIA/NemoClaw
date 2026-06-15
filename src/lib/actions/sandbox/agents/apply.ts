// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { loadAgentsManifest } from "../../../onboard/agents-manifest";
import { buildOpenshellExecArgs } from "../exec";

// Lazy-require `ensureLiveSandboxOrExit` because its import chain pulls in
// `runner`/`./platform`, which the Vitest TS loader cannot resolve at module
// load. Matches the pattern in `auto-pair-approval.ts`.
type EnsureLive = (
  sandboxName: string,
  options?: { allowNonReadyPhase?: boolean },
) => Promise<unknown>;
function lazyEnsureLive(): EnsureLive {
  return (require("../gateway-state") as typeof import("../gateway-state"))
    .ensureLiveSandboxOrExit as EnsureLive;
}

interface OpenClawAgentEntry {
  id: string;
  workspace?: string;
  agentDir?: string;
}

export interface AgentsApplyDiff {
  toAdd: Array<{ id: string; workspace?: string; agentDir?: string }>;
  toDelete: string[];
  rebuildOnlyFields: string[];
}

const MAIN_AGENT_ID = "main";
const PROTECTED_IDS = new Set<string>([MAIN_AGENT_ID]);

function hasNonEmptyFields(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).length > 0;
  }
  return false;
}

// Manifest fields that v1 apply cannot reconcile without a rebuild.
// `main.tools`/`main.subagents`, `defaults.subagents.*`, per-agent `model`,
// per-agent `subagents.*`, and per-agent `tools` all live in baked
// `openclaw.json` keys that require `openclaw config set` choreography we
// have not built yet; for now they require `nemoclaw onboard --agents <file>
// --recreate-sandbox`. The live `openclaw agents add` path does not bake a
// tool policy, so silently adding an agent that declares `tools` would let a
// manifest-required security boundary go missing in the sandbox.
function findRebuildOnlyFields(manifest: {
  agents: unknown[];
  defaults?: unknown;
  main?: unknown;
}): string[] {
  const findings: string[] = [];
  if (hasNonEmptyFields(manifest.defaults)) {
    findings.push("defaults");
  }
  if (hasNonEmptyFields(manifest.main)) {
    findings.push("main");
  }
  for (const entry of manifest.agents) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "?";
    if (record.model !== undefined) {
      findings.push(`agents[${id}].model`);
    }
    if (hasNonEmptyFields(record.subagents)) {
      findings.push(`agents[${id}].subagents`);
    }
    if (hasNonEmptyFields(record.tools)) {
      findings.push(`agents[${id}].tools`);
    }
  }
  return findings;
}

function findManifestToolsByAgentId(manifestAgents: unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of manifestAgents) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== "string" || !id) continue;
    if (hasNonEmptyFields(record.tools)) {
      ids.add(id);
    }
  }
  return ids;
}

export function computeAgentsApplyDiff(
  currentList: OpenClawAgentEntry[],
  manifestAgents: unknown[],
): { toAdd: AgentsApplyDiff["toAdd"]; toDelete: string[] } {
  const currentIds = new Set(currentList.map((entry) => entry.id));
  const manifestIds = new Set<string>();
  const toAdd: AgentsApplyDiff["toAdd"] = [];
  for (const entry of manifestAgents) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== "string" || !id) continue;
    manifestIds.add(id);
    if (id === MAIN_AGENT_ID) continue;
    if (currentIds.has(id)) continue;
    toAdd.push({
      id,
      workspace: typeof record.workspace === "string" ? record.workspace : undefined,
      agentDir: typeof record.agentDir === "string" ? record.agentDir : undefined,
    });
  }
  const toDelete: string[] = [];
  for (const entry of currentList) {
    if (PROTECTED_IDS.has(entry.id)) continue;
    if (!manifestIds.has(entry.id)) {
      toDelete.push(entry.id);
    }
  }
  return { toAdd, toDelete };
}

export function buildAgentsApplyDiff(
  currentList: OpenClawAgentEntry[],
  manifest: { agents: unknown[]; defaults?: unknown; main?: unknown },
): AgentsApplyDiff {
  const { toAdd, toDelete } = computeAgentsApplyDiff(currentList, manifest.agents);
  return {
    toAdd,
    toDelete,
    rebuildOnlyFields: findRebuildOnlyFields(manifest),
  };
}

export interface RunAgentsApplyOptions {
  sandboxName: string;
  manifestPath: string;
  yes?: boolean;
  nonInteractive?: boolean;
}

export interface RunAgentsApplyDeps {
  ensureLive?: EnsureLive;
  listAgents?: (sandboxName: string) => OpenClawAgentEntry[];
  addAgent?: (sandboxName: string, id: string, workspace: string | undefined) => void;
  deleteAgent?: (sandboxName: string, id: string) => void;
  log?: (message: string) => void;
  exit?: (code: number) => never;
}

function defaultListAgents(sandboxName: string): OpenClawAgentEntry[] {
  const { getOpenshellBinary } =
    require("../../../adapters/openshell/runtime") as typeof import("../../../adapters/openshell/runtime");
  const result = spawnSync(
    getOpenshellBinary(),
    buildOpenshellExecArgs(sandboxName, ["openclaw", "agents", "list", "--json"]),
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
  );
  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    throw new Error(
      `openclaw agents list --json failed (exit ${result.status ?? "?"})${stderr ? `: ${stderr}` : ""}`,
    );
  }
  const parsed = JSON.parse(String(result.stdout || "[]"));
  if (!Array.isArray(parsed)) {
    throw new Error("openclaw agents list --json did not return a JSON array");
  }
  return parsed.filter((entry): entry is OpenClawAgentEntry => {
    return (
      entry !== null &&
      typeof entry === "object" &&
      typeof (entry as { id?: unknown }).id === "string"
    );
  });
}

function defaultAddAgent(sandboxName: string, id: string, workspace: string | undefined): void {
  const { getOpenshellBinary } =
    require("../../../adapters/openshell/runtime") as typeof import("../../../adapters/openshell/runtime");
  const args = ["openclaw", "agents", "add", id, "--non-interactive"];
  if (workspace) {
    args.push("--workspace", workspace);
  }
  const result = spawnSync(getOpenshellBinary(), buildOpenshellExecArgs(sandboxName, args), {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`openclaw agents add ${id} failed (exit ${result.status ?? "?"})`);
  }
}

function defaultDeleteAgent(sandboxName: string, id: string): void {
  const { getOpenshellBinary } =
    require("../../../adapters/openshell/runtime") as typeof import("../../../adapters/openshell/runtime");
  const result = spawnSync(
    getOpenshellBinary(),
    buildOpenshellExecArgs(sandboxName, [
      "openclaw",
      "agents",
      "delete",
      id,
      "--force",
      "--non-interactive",
    ]),
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(`openclaw agents delete ${id} failed (exit ${result.status ?? "?"})`);
  }
}

export async function runAgentsApply(
  options: RunAgentsApplyOptions,
  deps: RunAgentsApplyDeps = {},
): Promise<void> {
  const log = deps.log ?? ((message: string) => console.log(message));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const ensureLive = deps.ensureLive ?? lazyEnsureLive();
  const listAgents = deps.listAgents ?? defaultListAgents;
  const addAgent = deps.addAgent ?? defaultAddAgent;
  const deleteAgent = deps.deleteAgent ?? defaultDeleteAgent;

  await ensureLive(options.sandboxName, { allowNonReadyPhase: false });

  const manifest = loadAgentsManifest(options.manifestPath);
  const currentList = listAgents(options.sandboxName);
  const diff = buildAgentsApplyDiff(currentList, manifest);

  log(`  Sandbox: ${options.sandboxName}`);
  log(`  Manifest: ${options.manifestPath}`);
  log(
    `  Plan: ${diff.toAdd.length} agent(s) to add, ${diff.toDelete.length} to delete, ${currentList.length} currently present.`,
  );
  for (const entry of diff.toAdd) {
    log(`    + ${entry.id}`);
  }
  for (const id of diff.toDelete) {
    log(`    - ${id}`);
  }
  if (diff.rebuildOnlyFields.length > 0) {
    log("");
    log("  ⚠  The following manifest fields require a sandbox rebuild and are not applied here:");
    for (const field of diff.rebuildOnlyFields) {
      log(`     - ${field}`);
    }
    log("  Run `nemoclaw onboard --agents <file> --recreate-sandbox` to bake those fields.");
  }
  if (diff.toAdd.length === 0 && diff.toDelete.length === 0) {
    log("  No roster changes to apply.");
    return;
  }
  if (!options.yes && options.nonInteractive) {
    log("  Pass --yes to apply roster changes in non-interactive mode.");
    exit(1);
  }
  if (!options.yes && !options.nonInteractive) {
    log("  Pass --yes to confirm the roster changes above.");
    exit(2);
  }

  const toolsAgentIds = findManifestToolsByAgentId(manifest.agents);
  for (const id of diff.toDelete) {
    log(`  Deleting agent: ${id}`);
    deleteAgent(options.sandboxName, id);
  }
  for (const entry of diff.toAdd) {
    if (toolsAgentIds.has(entry.id)) {
      log(
        `  ⚠  Manifest declares tools for "${entry.id}"; the live add cannot bake a tool policy. Rerun \`nemoclaw onboard --agents <file> --recreate-sandbox\` to apply it.`,
      );
    }
    log(`  Adding agent: ${entry.id}`);
    addAgent(options.sandboxName, entry.id, entry.workspace);
  }
  log("  Apply complete.");
}
