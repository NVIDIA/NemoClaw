// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const DOCKERFILE = path.join(ROOT, "Dockerfile");

function openclawStateRepairCommand(): string {
  const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
  const [, instruction] = dockerfile.match(
    /# Flatten stale published base images[\s\S]*?\nRUN ([\s\S]*?)\n\n# Stale-base fallback for the gateway\/root-in-sandbox-group setup/,
  )!;
  return instruction.trim().replace(/\\\n/g, " ");
}

function runUnsafeStateTarget(
  relativeTarget: string,
  setup: (target: string, temporaryRoot: string) => void,
) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-unsafe-state-"));
  const sandboxRoot = path.join(temporaryRoot, "sandbox");
  const openclawDir = path.join(sandboxRoot, ".openclaw");
  const target = path.join(openclawDir, relativeTarget);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  setup(target, temporaryRoot);
  const command = openclawStateRepairCommand()
    .replaceAll("/sandbox/.openclaw-data", path.join(sandboxRoot, ".openclaw-data"))
    .replaceAll("/sandbox/.openclaw", openclawDir)
    .replaceAll("/sandbox/.npm", path.join(sandboxRoot, ".npm"))
    .replaceAll("/tmp/nemoclaw-legacy-openclaw-layout", path.join(temporaryRoot, "legacy-marker"))
    .replaceAll("/root/.npm", path.join(temporaryRoot, "root-npm"));
  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'install() { local target="${*: -1}"; mkdir -p "$target"; }',
    "chown() { :; }",
    'stat() { command stat -f "%l" "${@: -1}"; }',
    command,
  ].join("\n");
  const scriptPath = path.join(temporaryRoot, "run-state-repair.sh");
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
  return { result, target, temporaryRoot };
}

it.each([
  {
    label: "symlinked exec approvals",
    relativeTarget: "exec-approvals.json",
    setup: (target: string, temporaryRoot: string) => {
      const outside = path.join(temporaryRoot, "outside-exec-approvals.json");
      fs.writeFileSync(outside, "{}\n");
      fs.symlinkSync(outside, target);
    },
  },
  {
    label: "hard-linked exec approvals",
    relativeTarget: "exec-approvals.json",
    setup: (target: string, temporaryRoot: string) => {
      const outside = path.join(temporaryRoot, "outside-exec-approvals.json");
      fs.writeFileSync(outside, "{}\n");
      fs.linkSync(outside, target);
    },
  },
  {
    label: "hard-linked SQLite state",
    relativeTarget: "state/openclaw.sqlite",
    setup: (target: string, temporaryRoot: string) => {
      const outside = path.join(temporaryRoot, "outside-openclaw.sqlite");
      fs.writeFileSync(outside, "sqlite-fixture");
      fs.linkSync(outside, target);
    },
  },
])("rejects $label before changing its inode", ({ relativeTarget, setup }) => {
  const fixture = runUnsafeStateTarget(relativeTarget, setup);
  try {
    expect(fixture.result.status).not.toBe(0);
    expect(fixture.result.stderr).toContain(
      `ERROR: refusing unsafe OpenClaw state file: ${fixture.target}`,
    );
  } finally {
    fs.rmSync(fixture.temporaryRoot, { recursive: true, force: true });
  }
});
