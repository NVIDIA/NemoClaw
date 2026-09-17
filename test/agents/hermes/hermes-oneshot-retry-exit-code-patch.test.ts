// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const root = path.join(import.meta.dirname, "../../..");
const patcher = path.join(root, "agents", "hermes", "patch-oneshot-retry-exit-code.py");
const fixtures: string[] = [];

const oneshotFixture = `\
def decide_exit_code(result, response):
    if (result.get("failed") or result.get("partial")) and not (response or "").strip():
        return 2

    if not (response or "").strip():
        return 1

    return 0
`;

function fixtureFile() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-oneshot-exit-code-"));
  fixtures.push(fixture);
  const oneshotModule = path.join(fixture, "oneshot.py");
  fs.writeFileSync(oneshotModule, oneshotFixture);
  return oneshotModule;
}

function runPatcher(oneshotModule: string) {
  return spawnSync("python3", ["-I", patcher, oneshotModule], {
    encoding: "utf8",
    timeout: 5000,
  });
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

describe("Hermes oneshot retry exit-code patch", () => {
  it("is a no-op replacement when applied to an already-patched module", () => {
    const oneshotModule = fixtureFile();
    expect(runPatcher(oneshotModule).status).toBe(0);
    const first = fs.readFileSync(oneshotModule, "utf8");

    expect(runPatcher(oneshotModule).status).toBe(0);
    expect(fs.readFileSync(oneshotModule, "utf8")).toBe(first);
  });

  it("fails loudly when the unpatched gate shape has moved", () => {
    const oneshotModule = fixtureFile();
    fs.writeFileSync(
      oneshotModule,
      oneshotFixture.replace('result.get("partial")', 'result.get("degraded")'),
    );

    const result = runPatcher(oneshotModule);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Hermes oneshot exit-code gate changed");
  });

  it("exits non-zero for a failed run even when it produced response text", () => {
    const oneshotModule = fixtureFile();
    expect(runPatcher(oneshotModule).status).toBe(0);

    const probe = `\
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("patched_oneshot", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

retry_exhausted = module.decide_exit_code(
    {"failed": True, "completed": False, "error": "429 Too Many Requests"},
    "API call failed after 3 retries: 429 Too Many Requests",
)
delivered = module.decide_exit_code({"failed": False, "completed": True}, "56")
empty_unflagged = module.decide_exit_code({}, "")

print(json.dumps({
    "retry_exhausted": retry_exhausted,
    "delivered": delivered,
    "empty_unflagged": empty_unflagged,
}))
`;
    const probeResult = spawnSync("python3", ["-I", "-c", probe, oneshotModule], {
      encoding: "utf8",
      timeout: 5000,
    });

    expect(probeResult.status, probeResult.stderr).toBe(0);
    const observed = JSON.parse(probeResult.stdout) as {
      retry_exhausted: number;
      delivered: number;
      empty_unflagged: number;
    };
    // Before this patch, a failed run whose own error text became the
    // response fell through to exit 0 (NVIDIA/NemoClaw#11848).
    expect(observed.retry_exhausted).not.toBe(0);
    expect(observed.delivered).toBe(0);
    expect(observed.empty_unflagged).toBe(1);
  });
});
