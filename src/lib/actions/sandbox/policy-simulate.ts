// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Host-side orchestration for `sandbox policy simulate`. Loads the trace
 * and the policy under test (either a candidate YAML file or the sandbox's
 * registered policy set — built-in presets plus custom/generated policies),
 * runs the pure simulation engine from `src/lib/policy/simulate`, and
 * returns a typed result the command can render. Registry and filesystem
 * access live here — behind injectable deps — so the command class stays a
 * thin argv adapter.
 *
 * The evaluation is static: it reflects the policy content the registry
 * records, not the live gateway. Sources that cannot be loaded are surfaced
 * as notes instead of being silently skipped — a missing allow-source can
 * only make results more conservative (never over-claim an allow).
 */

import fs from "node:fs";
import path from "node:path";

import {
  type ParsedPreset,
  type ParsedTrace,
  parsePolicyContent,
  parseTraceLines,
  simulate,
  type SimulationSummary,
} from "../../policy/simulate";
import { ROOT } from "../../runner";
import * as registryModule from "../../state/registry";

const PRESETS_DIR = path.join(ROOT, "nemoclaw-blueprint", "policies", "presets");

export interface SimulatePolicyOptions {
  sandboxName: string;
  /** Path to a JSONL trace file, or the literal "-" for stdin. */
  fromFile: string;
  /** Candidate policy YAML to test instead of the active sandbox policy. */
  policyFile?: string;
  /** Override name applied to candidate presets loaded from policyFile. */
  presetName?: string;
  /** Trace lines already read from stdin when fromFile is "-". */
  stdinLines?: string[];
}

export type SimulatePolicyResult =
  | { kind: "ok"; summary: SimulationSummary; notes: string[] }
  | { kind: "error"; lines: string[] };

export interface SimulatePolicyDeps {
  fileExists?: (p: string) => boolean;
  loadTrace?: (p: string) => ParsedTrace;
  loadPolicy?: (p: string) => ParsedPreset[];
  getSandboxPolicies?: (name: string) => string[];
  getCustomPolicies?: (name: string) => Array<{ name: string; content: string }>;
  presetsDir?: string;
}

function defaultGetSandboxPolicies(name: string): string[] {
  return registryModule.getSandbox(name)?.policies ?? [];
}

function defaultGetCustomPolicies(name: string): Array<{ name: string; content: string }> {
  return registryModule
    .getCustomPolicies(name)
    .map((entry) => ({ name: entry.name, content: entry.content }));
}

/**
 * Default file-backed loaders. The parsing itself is pure and lives in
 * `src/lib/policy/simulate`; only the reads happen here at the host
 * boundary.
 */
function defaultLoadTrace(filePath: string): ParsedTrace {
  return parseTraceLines(fs.readFileSync(filePath, "utf8").split("\n"));
}

function defaultLoadPolicy(filePath: string): ParsedPreset[] {
  return parsePolicyContent(fs.readFileSync(filePath, "utf8"));
}

/**
 * Load the sandbox's registered policy set: built-in preset files named by
 * the registry plus custom/generated policy content recorded on the sandbox
 * entry (which includes generated MCP bridge policies). Sources that cannot
 * be loaded are reported in `notes` — never silently skipped.
 */
function loadRegisteredPolicySet(
  sandboxName: string,
  deps: Required<
    Pick<
      SimulatePolicyDeps,
      "fileExists" | "loadPolicy" | "getSandboxPolicies" | "getCustomPolicies" | "presetsDir"
    >
  >,
): { presets: ParsedPreset[]; notes: string[] } {
  const notes: string[] = [];
  const presets: ParsedPreset[] = [];

  for (const presetName of deps.getSandboxPolicies(sandboxName)) {
    const presetFile = path.join(deps.presetsDir, `${presetName}.yaml`);
    if (!deps.fileExists(presetFile)) {
      notes.push(
        `Applied preset '${presetName}' has no readable file at ${presetFile}; its allows are not evaluated (results may under-report allowed).`,
      );
      continue;
    }
    try {
      presets.push(...deps.loadPolicy(presetFile));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notes.push(
        `Applied preset '${presetName}' could not be parsed (${message}); its allows are not evaluated (results may under-report allowed).`,
      );
    }
  }

  for (const custom of deps.getCustomPolicies(sandboxName)) {
    try {
      const parsed = parsePolicyContent(custom.content);
      if (parsed.length === 0) {
        notes.push(
          `Custom policy '${custom.name}' contains no evaluable endpoints; it is not part of this simulation.`,
        );
        continue;
      }
      presets.push(...parsed.map((p) => ({ ...p, name: `${custom.name}` })));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notes.push(
        `Custom policy '${custom.name}' could not be parsed (${message}); its allows are not evaluated (results may under-report allowed).`,
      );
    }
  }

  return { presets, notes };
}

export function simulateSandboxPolicy(
  options: SimulatePolicyOptions,
  deps: SimulatePolicyDeps = {},
): SimulatePolicyResult {
  const fileExists = deps.fileExists ?? fs.existsSync;
  const loadTrace = deps.loadTrace ?? defaultLoadTrace;
  const loadPolicy = deps.loadPolicy ?? defaultLoadPolicy;
  const getSandboxPolicies = deps.getSandboxPolicies ?? defaultGetSandboxPolicies;
  const getCustomPolicies = deps.getCustomPolicies ?? defaultGetCustomPolicies;
  const presetsDir = deps.presetsDir ?? PRESETS_DIR;

  let trace: ParsedTrace;
  if (options.fromFile === "-") {
    trace = parseTraceLines(options.stdinLines ?? []);
  } else {
    if (!fileExists(options.fromFile)) {
      return { kind: "error", lines: [`Trace file not found: ${options.fromFile}`] };
    }
    try {
      trace = loadTrace(options.fromFile);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        kind: "error",
        lines: [`Failed to read trace file ${options.fromFile}: ${message}`],
      };
    }
  }

  if (trace.requests.length === 0 && trace.invalidLines.length === 0) {
    return {
      kind: "error",
      lines: [
        'No trace requests found. Check that the file is JSONL with a "host" field per line.',
      ],
    };
  }

  let presets: ParsedPreset[];
  const notes: string[] = [];
  if (options.policyFile) {
    if (!fileExists(options.policyFile)) {
      return { kind: "error", lines: [`Policy file not found: ${options.policyFile}`] };
    }
    try {
      presets = loadPolicy(options.policyFile);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        kind: "error",
        lines: [`Failed to parse policy file ${options.policyFile}: ${message}`],
      };
    }
    if (presets.length === 0) {
      return {
        kind: "error",
        lines: [`No parseable endpoints found in policy file: ${options.policyFile}`],
      };
    }
    if (options.presetName) {
      const name = options.presetName;
      presets = presets.map((p) => ({ ...p, name }));
    }
    notes.push(
      "Candidate mode: only the provided policy file was evaluated; the sandbox's registered policy set was not.",
    );
  } else {
    const registered = loadRegisteredPolicySet(options.sandboxName, {
      fileExists,
      loadPolicy,
      getSandboxPolicies,
      getCustomPolicies,
      presetsDir,
    });
    presets = registered.presets;
    notes.push(...registered.notes);
    if (presets.length === 0) {
      return {
        kind: "error",
        lines: [
          `No registered policy content found for sandbox "${options.sandboxName}".`,
          `Add a preset first: nemoclaw ${options.sandboxName} policy-add <preset>`,
          ...registered.notes,
        ],
      };
    }
  }

  return { kind: "ok", summary: simulate(trace.requests, presets, trace.invalidLines), notes };
}
