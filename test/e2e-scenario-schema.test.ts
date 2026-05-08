// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

const E2E_DIR = path.join(import.meta.dirname, "e2e");
const SCENARIOS_PATH = path.join(E2E_DIR, "scenarios.yaml");
const STATES_PATH = path.join(E2E_DIR, "expected-states.yaml");
const SUITES_PATH = path.join(E2E_DIR, "suites.yaml");

type AnyRecord = Record<string, unknown>;

function loadYaml(p: string): AnyRecord {
  const raw = fs.readFileSync(p, "utf8");
  const doc = yaml.load(raw);
  if (!doc || typeof doc !== "object") {
    throw new Error(`YAML file ${p} did not parse to an object`);
  }
  return doc as AnyRecord;
}

describe("E2E scenario metadata schema", () => {
  it("should_parse_all_metadata_files", () => {
    expect(fs.existsSync(SCENARIOS_PATH)).toBe(true);
    expect(fs.existsSync(STATES_PATH)).toBe(true);
    expect(fs.existsSync(SUITES_PATH)).toBe(true);
    expect(() => loadYaml(SCENARIOS_PATH)).not.toThrow();
    expect(() => loadYaml(STATES_PATH)).not.toThrow();
    expect(() => loadYaml(SUITES_PATH)).not.toThrow();
  });

  it("should_have_required_top_level_sections", () => {
    const scenarios = loadYaml(SCENARIOS_PATH);
    expect(scenarios).toHaveProperty("platforms");
    expect(scenarios).toHaveProperty("installs");
    expect(scenarios).toHaveProperty("runtimes");
    expect(scenarios).toHaveProperty("onboarding");
    expect(scenarios).toHaveProperty("setup_scenarios");

    const states = loadYaml(STATES_PATH);
    expect(states).toHaveProperty("expected_states");

    const suites = loadYaml(SUITES_PATH);
    expect(suites).toHaveProperty("suites");
  });

  it("should_define_initial_required_scenarios", () => {
    const scenarios = loadYaml(SCENARIOS_PATH);
    const setup = scenarios.setup_scenarios as AnyRecord;
    expect(setup).toBeTypeOf("object");
    expect(setup).toHaveProperty("ubuntu-repo-cloud-openclaw");
    expect(setup).toHaveProperty("ubuntu-repo-cloud-hermes");
    expect(setup).toHaveProperty("gpu-repo-local-ollama-openclaw");
  });

  it("should_use_singular_expected_state_field", () => {
    const scenarios = loadYaml(SCENARIOS_PATH);
    const setup = scenarios.setup_scenarios as AnyRecord;
    for (const [id, entry] of Object.entries(setup)) {
      const s = entry as AnyRecord;
      expect(s, `scenario ${id} missing expected_state`).toHaveProperty("expected_state");
      expect(typeof s.expected_state, `scenario ${id}.expected_state must be a string`).toBe(
        "string",
      );
      expect(
        (s as AnyRecord).expected_states,
        `scenario ${id} must not have array-style expected_states`,
      ).toBeUndefined();
    }
  });

  it("should_define_initial_expected_states", () => {
    const states = loadYaml(STATES_PATH);
    const es = states.expected_states as AnyRecord;
    // Initial three states must exist; Phase 9 adds additional states
    // (e.g. preflight-failure-no-sandbox) alongside their first consumer.
    for (const id of [
      "cloud-openclaw-ready",
      "cloud-hermes-ready",
      "local-ollama-openclaw-ready",
    ]) {
      expect(es, `expected state ${id} should be defined`).toHaveProperty(id);
    }
  });

  it("should_define_initial_suites", () => {
    const suites = loadYaml(SUITES_PATH);
    const s = suites.suites as AnyRecord;
    for (const id of [
      "smoke",
      "inference",
      "credentials",
      "local-ollama-inference",
      "ollama-proxy",
    ]) {
      expect(s, `suite ${id} should be defined`).toHaveProperty(id);
    }
  });
});
