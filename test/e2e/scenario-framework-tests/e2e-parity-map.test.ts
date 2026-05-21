// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CHECK_BIN = path.join(REPO_ROOT, "scripts/e2e/check-parity-map.ts");

function makeRepo(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-parity-map-"));
  fs.mkdirSync(path.join(tmp, "test/e2e/docs"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "test/e2e/docs/parity-inventory.generated.json"),
    JSON.stringify(
      {
        generated_by: "test",
        entrypoints: [
          {
            script: "test/e2e/test-new.sh",
            assertions: [
              { script: "test/e2e/test-new.sh", line: 1, text: "CLI ready", polarity: "pass", normalized_id: "cli.ready", mapping_status: "unmapped" },
              { script: "test/e2e/test-new.sh", line: 2, text: "GPU ready", polarity: "pass", normalized_id: "gpu.ready", mapping_status: "unmapped" },
              { script: "test/e2e/test-new.sh", line: 3, text: "Old behavior", polarity: "fail", normalized_id: "old.behavior", mapping_status: "unmapped" },
            ],
          },
        ],
        totals: { scripts: 1, assertions: 3, zero_assertion_scripts: 0 },
      },
      null,
      2,
    ),
  );
  return tmp;
}

function writeMap(root: string, yaml: string) {
  fs.writeFileSync(path.join(root, "test/e2e/docs/parity-map.yaml"), yaml.trimStart());
}

function runCheck(root: string, args: string[] = []) {
  return spawnSync(path.join(REPO_ROOT, "node_modules/.bin/tsx"), [CHECK_BIN, "--root", root, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: Number(process.env.E2E_SPAWN_TIMEOUT_MS ?? 60_000),
  });
}

describe("rebuild/upgrade parity map records", () => {
  it("parity_map_should_classify_all_rebuild_upgrade_legacy_assertions", () => {
    const inventory = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "test/e2e/docs/parity-inventory.generated.json"), "utf8")) as {
      entrypoints: Array<{ script: string; assertions: Array<{ text: string }> }>;
    };
    const parityMap = yaml.load(fs.readFileSync(path.join(REPO_ROOT, "test/e2e/docs/parity-map.yaml"), "utf8")) as {
      scripts: Record<string, { assertions?: Array<{ legacy?: string; id?: string }> }>;
    };
    const expectedIds = new Set([
      "suite.rebuild.workspace_state_preserved",
      "suite.rebuild.agent_version_upgraded",
      "suite.rebuild.inference_still_works",
      "suite.rebuild.policy_presets_preserved",
      "suite.upgrade.sandbox_registry_preserved",
      "suite.upgrade.gateway_version_upgraded",
      "suite.upgrade.survivor_agent_reachable",
    ]);
    const mappedIds = new Set<string>();
    for (const script of [
      "test-rebuild-openclaw.sh",
      "test-rebuild-hermes.sh",
      "test-upgrade-stale-sandbox.sh",
      "test-openshell-gateway-upgrade.sh",
    ]) {
      const entry = inventory.entrypoints.find((item) => path.basename(item.script) === script);
      expect(entry, `missing inventory for ${script}`).toBeTruthy();
      const scriptMap = parityMap.scripts[script];
      expect(scriptMap, `missing parity map entry for ${script}`).toBeTruthy();
      const mappedLegacyAssertions = new Set((scriptMap.assertions ?? []).map((assertion) => assertion.legacy));
      for (const assertion of entry?.assertions ?? []) {
        expect(mappedLegacyAssertions, `${script} missing ${assertion.text}`).toContain(assertion.text);
      }
      for (const assertion of scriptMap.assertions ?? []) {
        if (assertion.id) mappedIds.add(assertion.id);
      }
    }
    for (const id of expectedIds) expect(mappedIds).toContain(id);
  });
});

describe("parity map schema validation", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeRepo();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("check_parity_map_should_pass_non_strict_with_seeded_empty_entries", () => {
    writeMap(
      tmp,
      `
scripts:
  test-new.sh:
    scenario: ""
    assertions: []
`,
    );
    const r = runCheck(tmp);
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });

  it("check_parity_map_should_fail_when_script_entry_missing", () => {
    writeMap(tmp, "scripts: {}\n");
    const r = runCheck(tmp);
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/test-new\.sh/);
  });

  it("check_parity_map_should_validate_status_required_fields", () => {
    writeMap(
      tmp,
      `
scripts:
  test-new.sh:
    status: migrated
    scenario: ubuntu-repo-cloud-openclaw
    assertions:
      - legacy: "CLI ready"
        status: mapped
      - legacy: "GPU ready"
        status: deferred
        reason: requires-gpu-runner
        owner: e2e
      - legacy: "Old behavior"
        status: retired
        reason: obsolete
        reviewer: e2e
`,
    );
    const r = runCheck(tmp);
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/id/);
    expect(r.stdout + r.stderr).toMatch(/runner_requirement|secret_requirement/);
    expect(r.stdout + r.stderr).toMatch(/approved_at/);
  });

  it("check_parity_map_strict_should_fail_on_empty_or_uncategorized_assertions", () => {
    writeMap(
      tmp,
      `
scripts:
  test-new.sh:
    scenario: ""
    assertions: []
`,
    );
    const empty = runCheck(tmp, ["--strict"]);
    expect(empty.status).not.toBe(0);
    expect(empty.stdout + empty.stderr).toMatch(/strict|empty|uncategorized/i);

    writeMap(
      tmp,
      `
scripts:
  test-new.sh:
    scenario: ubuntu-repo-cloud-openclaw
    assertions:
      - legacy: "CLI ready"
        id: smoke.cli.available
`,
    );
    const missingStatus = runCheck(tmp, ["--strict"]);
    expect(missingStatus.status).not.toBe(0);
    expect(missingStatus.stdout + missingStatus.stderr).toMatch(/status/);
  });

  it("check_parity_map_should_reject_unknown_legacy_assertion_strings", () => {
    writeMap(
      tmp,
      `
scripts:
  test-new.sh:
    scenario: ubuntu-repo-cloud-openclaw
    assertions:
      - legacy: "CLI redy"
        id: smoke.cli.available
        status: mapped
`,
    );
    const r = runCheck(tmp);
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/CLI redy/);
    expect(r.stdout + r.stderr).toMatch(/unknown|inventory/i);
  });

  it("check_parity_map_should_reject_duplicate_ids_unless_reusable", () => {
    writeMap(
      tmp,
      `
scripts:
  test-new.sh:
    scenario: ubuntu-repo-cloud-openclaw
    assertions:
      - legacy: "CLI ready"
        id: smoke.cli.available
        status: mapped
      - legacy: "GPU ready"
        id: smoke.cli.available
        status: mapped
`,
    );
    const duplicate = runCheck(tmp);
    expect(duplicate.status).not.toBe(0);
    expect(duplicate.stdout + duplicate.stderr).toMatch(/duplicate|smoke\.cli\.available/);

    writeMap(
      tmp,
      `
scripts:
  test-new.sh:
    scenario: ubuntu-repo-cloud-openclaw
    assertions:
      - legacy: "CLI ready"
        id: smoke.cli.available
        status: mapped
        reusable: true
      - legacy: "GPU ready"
        id: smoke.cli.available
        status: mapped
        reusable: true
      - legacy: "Old behavior"
        status: retired
        reason: obsolete
        reviewer: e2e
        approved_at: "2026-05-13"
`,
    );
    const reusable = runCheck(tmp);
    expect(reusable.status, reusable.stdout + reusable.stderr).toBe(0);
  });
});
