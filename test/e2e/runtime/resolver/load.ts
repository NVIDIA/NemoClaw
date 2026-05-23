// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Load and lightly-validate the E2E metadata files.
 *
 * The full reference check happens in `plan.ts` during scenario resolution.
 * This module only asserts that each file exists and has the required
 * top-level sections so callers get a clear error before touching scenarios.
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

import {
  EXPECTED_FAILURE_ERROR_CLASSES,
  EXPECTED_FAILURE_PHASES,
  EXPECTED_FAILURE_SIDE_EFFECTS,
} from "./schema.ts";
import type {
  ScenariosFile,
  ExpectedStatesFile,
  SuitesFile,
  ExpectedFailurePhase,
  ExpectedFailureErrorClass,
  ExpectedFailureSideEffect,
} from "./schema.ts";

export interface ResolverInput {
  scenarios: ScenariosFile;
  expectedStates: ExpectedStatesFile;
  suites: SuitesFile;
  /** Optional source dir, used for resolving suite script paths. */
  sourceDir?: string;
}

function readYaml(p: string): unknown {
  const raw = fs.readFileSync(p, "utf8");
  return yaml.load(raw);
}

function ensureObject(doc: unknown, file: string): Record<string, unknown> {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`metadata file ${file} must parse to a YAML mapping`);
  }
  return doc as Record<string, unknown>;
}

function requireSections(
  doc: Record<string, unknown>,
  file: string,
  sections: string[],
): void {
  for (const s of sections) {
    if (!(s in doc)) {
      throw new Error(`metadata file ${file} is missing required section: ${s}`);
    }
  }
}

/**
 * Compile a YAML-authored `message_pattern` into a JS `RegExp`. RE2-style
 * inline flag prefixes (e.g. `(?i)`, `(?ims)`) are stripped and converted
 * to the corresponding `RegExp` flags so authors can write the same shape
 * the issue body shows without worrying about the underlying engine.
 *
 * Exported so the matcher uses identical compilation rules; throws on any
 * unsupported flag character or on an invalid pattern.
 */
export function compileMessagePattern(pattern: string): RegExp {
  let body = pattern;
  let flags = "";
  const inlineFlagMatch = /^\(\?([a-zA-Z]+)\)/.exec(pattern);
  if (inlineFlagMatch) {
    const allowed = new Set(["i", "m", "s"]);
    for (const ch of inlineFlagMatch[1]) {
      if (!allowed.has(ch)) {
        throw new Error(`unsupported inline regex flag '(?${inlineFlagMatch[1]})'; allowed: i, m, s`);
      }
      if (!flags.includes(ch)) flags += ch;
    }
    body = pattern.slice(inlineFlagMatch[0].length);
  }
  return new RegExp(body, flags);
}

/**
 * Validate an `expected_failure` block. `partial` controls whether every
 * required field must be present (state-level blocks: yes; scenario-level
 * override: no, since absent fields fall back to the state).
 */
function validateExpectedFailureBlock(
  block: unknown,
  origin: string,
  opts: { partial: boolean },
): void {
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    throw new Error(`${origin}.expected_failure must be a mapping`);
  }
  const b = block as Record<string, unknown>;
  if (b.phase !== undefined) {
    if (typeof b.phase !== "string" || !EXPECTED_FAILURE_PHASES.includes(b.phase as ExpectedFailurePhase)) {
      throw new Error(
        `${origin}.expected_failure.phase must be one of: ${EXPECTED_FAILURE_PHASES.join(", ")}`,
      );
    }
  } else if (!opts.partial) {
    throw new Error(`${origin}.expected_failure.phase is required`);
  }
  if (b.error_class !== undefined) {
    if (
      typeof b.error_class !== "string" ||
      !EXPECTED_FAILURE_ERROR_CLASSES.includes(b.error_class as ExpectedFailureErrorClass)
    ) {
      throw new Error(
        `${origin}.expected_failure.error_class must be one of: ${EXPECTED_FAILURE_ERROR_CLASSES.join(", ")}`,
      );
    }
  } else if (!opts.partial) {
    throw new Error(`${origin}.expected_failure.error_class is required`);
  }
  if (b.message_pattern !== undefined && typeof b.message_pattern !== "string") {
    throw new Error(`${origin}.expected_failure.message_pattern must be a string`);
  }
  if (typeof b.message_pattern === "string") {
    try {
      compileMessagePattern(b.message_pattern);
    } catch (err) {
      throw new Error(
        `${origin}.expected_failure.message_pattern is not a valid regex: ${(err as Error).message}`,
      );
    }
  }
  if (b.forbidden_side_effects !== undefined) {
    if (!Array.isArray(b.forbidden_side_effects)) {
      throw new Error(`${origin}.expected_failure.forbidden_side_effects must be a list`);
    }
    for (const effect of b.forbidden_side_effects) {
      if (
        typeof effect !== "string" ||
        !EXPECTED_FAILURE_SIDE_EFFECTS.includes(effect as ExpectedFailureSideEffect)
      ) {
        throw new Error(
          `${origin}.expected_failure.forbidden_side_effects entry '${String(effect)}' must be one of: ${EXPECTED_FAILURE_SIDE_EFFECTS.join(", ")}`,
        );
      }
    }
  }
  const known = new Set(["phase", "error_class", "message_pattern", "forbidden_side_effects"]);
  for (const k of Object.keys(b)) {
    if (!known.has(k)) {
      throw new Error(`${origin}.expected_failure has unknown key '${k}'`);
    }
  }
}

function validateScenarios(doc: Record<string, unknown>, file: string): ScenariosFile {
  requireSections(doc, file, [
    "platforms",
    "installs",
    "runtimes",
    "onboarding",
    "setup_scenarios",
  ]);
  const setup = doc.setup_scenarios as Record<string, unknown>;
  for (const [id, entry] of Object.entries(setup)) {
    if (!entry || typeof entry !== "object") {
      throw new Error(`scenario ${id} must be a mapping`);
    }
    const e = entry as Record<string, unknown>;
    if ("expected_states" in e) {
      throw new Error(
        `scenario ${id} uses array-form 'expected_states'; use singular 'expected_state'`,
      );
    }
    if (typeof e.alias_for_plan === "string") {
      continue;
    }
    if (typeof e.expected_state !== "string") {
      throw new Error(`scenario ${id} must declare a string 'expected_state'`);
    }
    if (!Array.isArray(e.suites)) {
      throw new Error(`scenario ${id} must declare a list of 'suites'`);
    }
    if ("runner_requirements" in e) {
      if (
        !Array.isArray(e.runner_requirements) ||
        e.runner_requirements.some((requirement) => typeof requirement !== "string")
      ) {
        throw new Error(`scenario ${id}.runner_requirements must be a list of strings`);
      }
    }
    if ("expected_failure" in e) {
      validateExpectedFailureBlock(e.expected_failure, `scenario ${id}`, { partial: true });
    }
    if ("skipped_capabilities" in e) {
      if (
        !Array.isArray(e.skipped_capabilities) ||
        e.skipped_capabilities.some((skip) => {
          if (!skip || typeof skip !== "object" || Array.isArray(skip)) return true;
          const s = skip as Record<string, unknown>;
          return (
            typeof s.id !== "string" ||
            typeof s.reason !== "string" ||
            ("suites" in s && (!Array.isArray(s.suites) || s.suites.some((suite) => typeof suite !== "string")))
          );
        })
      ) {
        throw new Error(`scenario ${id}.skipped_capabilities must list {id, reason, suites?}`);
      }
    }
    const dims = e.dimensions as Record<string, unknown> | undefined;
    if (!dims) {
      throw new Error(`scenario ${id} must declare 'dimensions'`);
    }
    for (const key of ["platform", "install", "runtime", "onboarding"]) {
      if (typeof dims[key] !== "string") {
        throw new Error(`scenario ${id}.dimensions.${key} must be a string`);
      }
    }
    const platformId = dims.platform as string;
    const platform = (doc.platforms as Record<string, Record<string, unknown> | undefined>)[
      platformId
    ];
    const requiresExplicitRunner =
      platform?.execution_target === "remote" ||
      platform?.os === "macos" ||
      platform?.os === "wsl" ||
      platform?.gpu !== undefined ||
      platform?.hardware !== undefined;
    if (
      requiresExplicitRunner &&
      (!Array.isArray(e.runner_requirements) || e.runner_requirements.length === 0)
    ) {
      throw new Error(`scenario ${id} must declare runner_requirements for platform ${platformId}`);
    }
  }
  return doc as unknown as ScenariosFile;
}

function validateExpectedStates(
  doc: Record<string, unknown>,
  file: string,
): ExpectedStatesFile {
  requireSections(doc, file, ["expected_states"]);
  const rawStates = doc.expected_states;
  if (!rawStates || typeof rawStates !== "object" || Array.isArray(rawStates)) {
    throw new Error(`metadata file ${file} section 'expected_states' must be a mapping`);
  }
  const states = rawStates as Record<string, unknown>;
  for (const [id, entry] of Object.entries(states)) {
    if (!entry || typeof entry !== "object") {
      throw new Error(`expected_state ${id} must be a mapping`);
    }
    const e = entry as Record<string, unknown>;
    if ("expected_failure" in e) {
      validateExpectedFailureBlock(e.expected_failure, `expected_state ${id}`, { partial: false });
    }
  }
  return doc as unknown as ExpectedStatesFile;
}

function validateSuites(doc: Record<string, unknown>, file: string): SuitesFile {
  requireSections(doc, file, ["suites"]);
  const suites = doc.suites as Record<string, unknown>;
  for (const [id, entry] of Object.entries(suites)) {
    if (!entry || typeof entry !== "object") {
      throw new Error(`suite ${id} must be a mapping`);
    }
    const e = entry as Record<string, unknown>;
    if (!Array.isArray(e.steps)) {
      throw new Error(`suite ${id} must declare a 'steps' array`);
    }
    for (const step of e.steps) {
      if (!step || typeof step !== "object") {
        throw new Error(`suite ${id} has a non-mapping step`);
      }
      const s = step as Record<string, unknown>;
      if (typeof s.id !== "string" || typeof s.script !== "string") {
        throw new Error(`suite ${id} has an invalid step (requires string id and script)`);
      }
    }
  }
  return doc as unknown as SuitesFile;
}

/**
 * Resolve the concrete on-disk locations of the three metadata files
 * given the E2E root directory (`test/e2e/`).
 *
 * Post-restructure layout:
 *   <e2e-root>/nemoclaw_scenarios/scenarios.yaml
 *   <e2e-root>/nemoclaw_scenarios/expected-states.yaml
 *   <e2e-root>/validation_suites/suites.yaml
 *
 * For backward compatibility (and for tests that synthesise a flat
 * fixture directory) we also accept a directory that already contains
 * all three YAML files side by side.
 */
function resolveMetadataPaths(dir: string): {
  scenarios: string;
  states: string;
  suites: string;
} {
  const flatScenarios = path.join(dir, "scenarios.yaml");
  const flatStates = path.join(dir, "expected-states.yaml");
  const flatSuites = path.join(dir, "suites.yaml");
  if (
    fs.existsSync(flatScenarios) &&
    fs.existsSync(flatStates) &&
    fs.existsSync(flatSuites)
  ) {
    return { scenarios: flatScenarios, states: flatStates, suites: flatSuites };
  }
  return {
    scenarios: path.join(dir, "nemoclaw_scenarios", "scenarios.yaml"),
    states: path.join(dir, "nemoclaw_scenarios", "expected-states.yaml"),
    suites: path.join(dir, "validation_suites", "suites.yaml"),
  };
}

export function loadMetadataFromDir(dir: string): ResolverInput {
  const { scenarios: scenariosPath, states: statesPath, suites: suitesPath } =
    resolveMetadataPaths(dir);
  const scenarios = validateScenarios(
    ensureObject(readYaml(scenariosPath), scenariosPath),
    scenariosPath,
  );
  const expectedStates = validateExpectedStates(
    ensureObject(readYaml(statesPath), statesPath),
    statesPath,
  );
  const suites = validateSuites(
    ensureObject(readYaml(suitesPath), suitesPath),
    suitesPath,
  );
  return { scenarios, expectedStates, suites, sourceDir: dir };
}

export function loadMetadataFromObjects(input: {
  scenarios: object;
  expectedStates: object;
  suites: object;
  sourceDir?: string;
}): ResolverInput {
  const scenarios = validateScenarios(
    ensureObject(input.scenarios, "<scenarios>"),
    "<scenarios>",
  );
  const expectedStates = validateExpectedStates(
    ensureObject(input.expectedStates, "<expected-states>"),
    "<expected-states>",
  );
  const suites = validateSuites(
    ensureObject(input.suites, "<suites>"),
    "<suites>",
  );
  return { scenarios, expectedStates, suites, sourceDir: input.sourceDir };
}
