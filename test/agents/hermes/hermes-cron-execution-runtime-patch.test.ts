// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const root = path.join(import.meta.dirname, "../../..");
const patcher = path.join(root, "agents", "hermes", "patch-cron-execution-runtime.py");
const dockerfile = fs.readFileSync(path.join(root, "agents", "hermes", "Dockerfile"), "utf8");
const imageBuildProbes = fs.readFileSync(
  path.join(root, "agents", "hermes", "image-build-probes.py"),
  "utf8",
);
const fixtures: string[] = [];

const upstreamExecutions = `\
from hermes_constants import get_hermes_home

EXECUTIONS_FILE = get_hermes_home().resolve() / "cron" / "executions.db"
`;

const upstreamBackup = `\
_QUICK_STATE_FILES = (
    "state.db",
    "cron/jobs.json",
    "cron/executions.db",
)
`;

function fixtureFiles(options: { executions?: string; backup?: string } = {}) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-cron-runtime-"));
  fixtures.push(fixture);
  const executions = path.join(fixture, "executions.py");
  const backup = path.join(fixture, "backup.py");
  fs.writeFileSync(executions, options.executions ?? upstreamExecutions);
  fs.writeFileSync(backup, options.backup ?? upstreamBackup);
  return { executions, backup };
}

function runPatcher(executions: string, backup: string) {
  return spawnSync("python3", ["-I", patcher, "--executions", executions, "--backup", backup], {
    encoding: "utf8",
    timeout: 5000,
  });
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

describe("Hermes cron execution runtime patch", () => {
  it("relocates the ledger and quick snapshot entry together and remains idempotent", () => {
    const files = fixtureFiles();

    const first = runPatcher(files.executions, files.backup);
    expect(first.status, first.stderr).toBe(0);
    expect(fs.readFileSync(files.executions, "utf8")).toContain(
      'get_hermes_home().resolve() / "runtime" / "cron-executions.db"',
    );
    expect(fs.readFileSync(files.backup, "utf8")).toContain('"runtime/cron-executions.db"');
    expect(fs.readFileSync(files.executions, "utf8")).not.toContain('/ "cron" / "executions.db"');
    expect(fs.readFileSync(files.backup, "utf8")).not.toContain('"cron/executions.db"');

    const second = runPatcher(files.executions, files.backup);
    expect(second.status, second.stderr).toBe(0);
  });

  it("fails closed before either file changes when a pinned source shape drifts", () => {
    const driftedBackup = upstreamBackup.replace(
      '"cron/executions.db"',
      '"cron/execution-history.db"',
    );
    const files = fixtureFiles({ backup: driftedBackup });

    const result = runPatcher(files.executions, files.backup);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cron execution runtime source shape changed");
    expect(fs.readFileSync(files.executions, "utf8")).toBe(upstreamExecutions);
    expect(fs.readFileSync(files.backup, "utf8")).toBe(driftedBackup);
  });

  it("rejects a partially applied pair instead of splitting the runtime contract", () => {
    const files = fixtureFiles({
      executions: upstreamExecutions.replace(
        '/ "cron" / "executions.db"',
        '/ "runtime" / "cron-executions.db"',
      ),
    });

    const result = runPatcher(files.executions, files.backup);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("only partially applied");
    expect(fs.readFileSync(files.backup, "utf8")).toBe(upstreamBackup);
  });

  it("hash-binds both upstream modules and requires installed-path build probes", () => {
    const digest = createHash("sha256").update(fs.readFileSync(patcher)).digest("hex");

    expect(dockerfile).toContain(`ARG NEMOCLAW_HERMES_CRON_RUNTIME_PATCHER_SHA256=${digest}`);
    expect(dockerfile).toContain(
      "ARG NEMOCLAW_HERMES_CRON_EXECUTIONS_SOURCE_SHA256=" +
        "b37215a27a453191420622f78dc8962fa44feac2521a6f51d71b18831e7cacb7",
    );
    expect(dockerfile).toContain(
      "ARG NEMOCLAW_HERMES_BACKUP_SOURCE_SHA256=" +
        "1bcef6f736f1d52055837789f24becdba4a670f0a1abb5ac9973b1a1a7306f35",
    );
    expect(dockerfile).toContain(
      "COPY agents/hermes/patch-cron-execution-runtime.py " +
        "/opt/nemoclaw-hermes-config/patch-cron-execution-runtime.py",
    );
    expect(dockerfile).toMatch(
      /patch-cron-execution-runtime[.]py \\\n\s+--executions \/opt\/hermes\/cron\/executions[.]py \\\n\s+--backup \/opt\/hermes\/hermes_cli\/backup[.]py/u,
    );
    expect(imageBuildProbes).toContain(
      'expected = get_hermes_home().resolve() / "runtime" / "cron-executions.db"',
    );
    expect(imageBuildProbes).toContain('assert "cron/executions.db" not in _QUICK_STATE_FILES');
  });
});
