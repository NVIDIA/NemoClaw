// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * State file manager for the NemoClaw maintainer skills.
 *
 * Subcommands:
 *   init                          Create state file and .git/info/exclude entry
 *   show                          Print current state
 *   exclude <number> <reason>     Add PR to permanent exclusion list (triage only processes PRs)
 *   unexclude <number>            Remove from exclusion list
 *   history <action> <item> <note> Add a history entry
 *   set-queue <json>              Update queue from triage output (pipe JSON to stdin)
 *   set-hotspots <json>           Update hotspots from hotspot output (pipe JSON to stdin)
 *
 * Usage: node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/state.ts <subcommand> [args]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const STATE_DIR = resolve(".nemoclaw-maintainer");
const STATE_PATH = resolve(STATE_DIR, "state.json");
const GIT_EXCLUDE = resolve(".git", "info", "exclude");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HistoryEntry {
  at: string;
  item: string;
  action: string;
  note: string;
}

interface StateFile {
  version: number;
  repo: string;
  updatedAt: string | null;
  priorities: string[];
  gates: Record<string, boolean>;
  excluded: {
    prs: Record<string, { reason: string; excludedAt: string }>;
    issues: Record<string, { reason: string; excludedAt: string }>;
  };
  queue: {
    generatedAt: string | null;
    topAction: unknown;
    items: unknown[];
    nearMisses: unknown[];
  };
  hotspots: {
    generatedAt: string | null;
    files: unknown[];
  };
  activeWork: {
    kind: string | null;
    target: string | null;
    branch: string | null;
    goal: string | null;
    startedAt: string | null;
  };
  history: HistoryEntry[];
}

// ---------------------------------------------------------------------------
// State CRUD
// ---------------------------------------------------------------------------

function defaultState(): StateFile {
  return {
    version: 1,
    repo: "NVIDIA/NemoClaw",
    updatedAt: null,
    priorities: [
      "reduce_pr_backlog",
      "reduce_security_risk",
      "increase_test_coverage",
      "cool_hot_files",
    ],
    gates: {
      greenCi: true,
      noConflicts: true,
      noMajorCodeRabbit: true,
      testsForTouchedRiskyCode: true,
      autoApprove: true,
      autoPushSmallFixes: true,
      autoMerge: false,
    },
    excluded: { prs: {}, issues: {} },
    queue: { generatedAt: null, topAction: null, items: [], nearMisses: [] },
    hotspots: { generatedAt: null, files: [] },
    activeWork: { kind: null, target: null, branch: null, goal: null, startedAt: null },
    history: [],
  };
}

function loadState(): StateFile {
  if (!existsSync(STATE_PATH)) {
    return defaultState();
  }
  return JSON.parse(readFileSync(STATE_PATH, "utf-8")) as StateFile;
}

function saveState(state: StateFile): void {
  state.updatedAt = new Date().toISOString();
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

function ensureExclude(): void {
  if (!existsSync(GIT_EXCLUDE)) return;
  const content = readFileSync(GIT_EXCLUDE, "utf-8");
  const entry = ".nemoclaw-maintainer/";
  if (!content.includes(entry)) {
    appendFileSync(GIT_EXCLUDE, `\n${entry}\n`);
    console.error(`Added ${entry} to ${GIT_EXCLUDE}`);
  }
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

function cmdInit(): void {
  mkdirSync(STATE_DIR, { recursive: true });
  if (!existsSync(STATE_PATH)) {
    saveState(defaultState());
    console.log(`Created ${STATE_PATH}`);
  } else {
    console.log(`${STATE_PATH} already exists`);
  }
  ensureExclude();
}

function cmdShow(): void {
  const state = loadState();
  console.log(JSON.stringify(state, null, 2));
}

function cmdExclude(numberStr: string, reason: string): void {
  const state = loadState();
  state.excluded.prs[numberStr] = {
    reason,
    excludedAt: new Date().toISOString(),
  };
  saveState(state);
  console.log(`Excluded PR #${numberStr}: ${reason}`);
}

function cmdUnexclude(numberStr: string): void {
  const state = loadState();
  delete state.excluded.prs[numberStr];
  delete state.excluded.issues[numberStr];
  saveState(state);
  console.log(`Unexcluded #${numberStr}`);
}

function cmdHistory(action: string, item: string, note: string): void {
  const state = loadState();
  state.history.push({
    at: new Date().toISOString(),
    item,
    action,
    note,
  });
  if (state.history.length > 50) {
    state.history = state.history.slice(-50);
  }
  saveState(state);
  console.log(`Added history: ${action} ${item}`);
}

function cmdSetQueue(): void {
  const input = readFileSync(0, "utf-8");
  let triageOutput: Record<string, unknown>;
  try {
    triageOutput = JSON.parse(input);
  } catch (err) {
    console.error(`Failed to parse triage JSON from stdin: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const state = loadState();

  state.queue = {
    generatedAt: triageOutput.generatedAt ?? new Date().toISOString(),
    topAction: triageOutput.queue?.[0] ?? null,
    items: triageOutput.queue ?? [],
    nearMisses: triageOutput.nearMisses ?? [],
  };
  saveState(state);
  console.log(`Queue updated: ${state.queue.items.length} items, ${state.queue.nearMisses.length} near misses`);
}

function cmdSetHotspots(): void {
  const input = readFileSync(0, "utf-8");
  let hotspotOutput: Record<string, unknown>;
  try {
    hotspotOutput = JSON.parse(input);
  } catch (err) {
    console.error(`Failed to parse hotspot JSON from stdin: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const state = loadState();

  state.hotspots = {
    generatedAt: hotspotOutput.generatedAt ?? new Date().toISOString(),
    files: hotspotOutput.hotspots ?? [],
  };
  saveState(state);
  console.log(`Hotspots updated: ${state.hotspots.files.length} entries`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const [subcommand, ...args] = process.argv.slice(2);

  switch (subcommand) {
    case "init":
      cmdInit();
      break;
    case "show":
      cmdShow();
      break;
    case "exclude":
      if (args.length < 2) {
        console.error("Usage: state.ts exclude <number> <reason>");
        process.exit(1);
      }
      cmdExclude(args[0], args.slice(1).join(" "));
      break;
    case "unexclude":
      if (args.length < 1) {
        console.error("Usage: state.ts unexclude <number>");
        process.exit(1);
      }
      cmdUnexclude(args[0]);
      break;
    case "history":
      if (args.length < 3) {
        console.error("Usage: state.ts history <action> <item> <note>");
        process.exit(1);
      }
      cmdHistory(args[0], args[1], args.slice(2).join(" "));
      break;
    case "set-queue":
      cmdSetQueue();
      break;
    case "set-hotspots":
      cmdSetHotspots();
      break;
    default:
      console.error(
        "Usage: state.ts <init|show|exclude|unexclude|history|set-queue|set-hotspots> [args]",
      );
      process.exit(1);
  }
}

main();
