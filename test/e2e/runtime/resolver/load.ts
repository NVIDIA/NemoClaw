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

import type {
  ScenariosFile,
  ExpectedStatesFile,
  SuitesFile,
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
