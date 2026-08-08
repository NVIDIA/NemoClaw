// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function select(jobs: string): string {
  const root = mkdtempSync(join(tmpdir(), "nemoclaw-regression-selector-"));
  temporaryRoots.push(root);
  const output = join(root, "github-output");
  const result = spawnSync("bash", [".github/scripts/select-regression-e2e-jobs.sh"], {
    cwd: join(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: output, JOBS: jobs },
  });
  expect(result.status, result.stderr).toBe(0);
  return readFileSync(output, "utf8").trim();
}

describe("regression E2E selector", () => {
  it.each([
    "",
    " whatsapp-qr-compact-e2e ",
  ])("selects the WhatsApp regression for accepted jobs input %j", (jobs) => {
    expect(select(jobs)).toBe("whatsapp_qr_compact=true");
  });

  it.each([
    "unknown",
    "whatsapp-qr-compact-e2",
    "whatsapp-qr-compact-e2e-extra",
  ])("rejects unsupported jobs input %j", (jobs) => {
    expect(select(jobs)).toBe("whatsapp_qr_compact=false");
  });
});
