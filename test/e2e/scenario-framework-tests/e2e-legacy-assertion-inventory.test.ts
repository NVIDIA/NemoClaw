// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildLegacyAssertionInventory } from "../../../scripts/e2e/extract-legacy-assertions";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const EXTRACT_BIN = path.join(REPO_ROOT, "scripts/e2e/extract-legacy-assertions.ts");

function makeRepo(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-inventory-"));
  fs.mkdirSync(path.join(tmp, "test/e2e/docs"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "test/e2e/docs/parity-map.yaml"), "scripts: {}\n");
  return tmp;
}

function writeEntrypoint(root: string, name: string, body: string) {
  fs.writeFileSync(path.join(root, "test/e2e", name), body);
}

function runExtractor(args: string[]) {
  return spawnSync(path.join(REPO_ROOT, "node_modules/.bin/tsx"), [EXTRACT_BIN, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: Number(process.env.E2E_SPAWN_TIMEOUT_MS ?? 60_000),
  });
}

describe("legacy assertion inventory extraction", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeRepo();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("extract_legacy_assertions_should_find_pass_and_fail_helper_calls", () => {
    writeEntrypoint(tmp, "test-helper.sh", '#!/usr/bin/env bash\npass "CLI ready"\nfail "CLI missing"\n');

    const inventory = buildLegacyAssertionInventory(tmp);
    const script = inventory.entrypoints.find((entry) => entry.script === "test/e2e/test-helper.sh");

    expect(script?.assertions).toEqual([
      expect.objectContaining({ line: 2, text: "CLI ready", polarity: "pass", normalized_id: "cli.ready" }),
      expect.objectContaining({ line: 3, text: "CLI missing", polarity: "fail", normalized_id: "cli.missing" }),
    ]);
  });

  it("extract_legacy_assertions_should_find_direct_pass_fail_output", () => {
    writeEntrypoint(
      tmp,
      "test-direct.sh",
      '#!/usr/bin/env bash\necho "PASS: gateway healthy"\necho "FAIL: gateway unhealthy"\n',
    );

    const inventory = buildLegacyAssertionInventory(tmp);
    const script = inventory.entrypoints.find((entry) => entry.script === "test/e2e/test-direct.sh");

    expect(script?.assertions).toEqual([
      expect.objectContaining({ line: 2, text: "gateway healthy", polarity: "pass" }),
      expect.objectContaining({ line: 3, text: "gateway unhealthy", polarity: "fail" }),
    ]);
  });

  it("extract_legacy_assertions_should_handle_helper_wrapped_assertions", () => {
    writeEntrypoint(
      tmp,
      "test-wrapped.sh",
      '#!/usr/bin/env bash\nretry_until pass "sandbox listed"\nif true; then pass "sandbox listed"; fi\n',
    );

    const inventory = buildLegacyAssertionInventory(tmp);
    const script = inventory.entrypoints.find((entry) => entry.script === "test/e2e/test-wrapped.sh");

    expect(script?.assertions).toEqual([
      expect.objectContaining({ line: 2, text: "sandbox listed", polarity: "pass" }),
      expect.objectContaining({ line: 3, text: "sandbox listed", polarity: "pass" }),
    ]);
  });

  it("extract_legacy_assertions_should_include_zero_assertion_scripts", () => {
    writeEntrypoint(tmp, "test-no-assertions.sh", "#!/usr/bin/env bash\necho setup-only\n");

    const inventory = buildLegacyAssertionInventory(tmp);
    const script = inventory.entrypoints.find((entry) => entry.script === "test/e2e/test-no-assertions.sh");

    expect(script?.assertions).toEqual([]);
    expect(script?.zero_assertion_review).toEqual(
      expect.objectContaining({ reason: expect.stringMatching(/review|todo/i) }),
    );
  });

  it("extract_legacy_assertions_should_generate_deterministic_json", () => {
    writeEntrypoint(tmp, "test-b.sh", '#!/usr/bin/env bash\npass "B ready"\n');
    writeEntrypoint(tmp, "test-a.sh", '#!/usr/bin/env bash\npass "A ready"\n');
    writeEntrypoint(tmp, "brev-e2e.test.ts", 'console.log("PASS: brev provisioned");\n');

    const out1 = path.join(tmp, "one.json");
    const out2 = path.join(tmp, "two.json");
    const first = runExtractor(["--root", tmp, "--output", out1]);
    const second = runExtractor(["--root", tmp, "--output", out2]);

    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(second.status, second.stdout + second.stderr).toBe(0);
    expect(fs.readFileSync(out1, "utf8")).toBe(fs.readFileSync(out2, "utf8"));

    const parsed = JSON.parse(fs.readFileSync(out1, "utf8"));
    expect(parsed.entrypoints.map((entry: { script: string }) => entry.script)).toEqual([
      "test/e2e/brev-e2e.test.ts",
      "test/e2e/test-a.sh",
      "test/e2e/test-b.sh",
    ]);
  });
});
