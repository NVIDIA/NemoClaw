// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { expect, it } from "vitest";

import { readYaml, type Workflow } from "../../helpers/e2e-workflow-contract.ts";

function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o700 });
}

function portableCleanupRun(): string {
  const workflow = readYaml<Workflow>(".github/workflows/portable-profile-e2e.yaml");
  const cleanup = workflow.jobs["portable-launch"]?.steps?.find(
    (step) => step.name === "Clean up portable runtime",
  );
  expect(cleanup).toBeDefined();
  return cleanup?.run ?? "";
}

it("restores the portable user manager and linger state after refusing a changed drop-in", () => {
  const root = fs.mkdtempSync("/tmp/portable-cpu-delegation-restoration-");
  const bin = path.join(root, "bin");
  const changed = path.join(root, "changed.conf");
  const receipt = path.join(root, "receipt");
  const commandLog = path.join(root, "commands.log");
  const expected = "[Service]\nDelegate=cpu memory pids\n";
  fs.mkdirSync(bin, { mode: 0o700 });
  writeExecutable(path.join(bin, "sudo"), '#!/usr/bin/env bash\nexec "$@"\n');
  writeExecutable(
    path.join(bin, "systemctl"),
    '#!/usr/bin/env bash\nprintf "systemctl\\t%s\\n" "$*" >>"$FAKE_CLEANUP_LOG"\n',
  );
  writeExecutable(
    path.join(bin, "loginctl"),
    '#!/usr/bin/env bash\nprintf "loginctl\\t%s\\n" "$*" >>"$FAKE_CLEANUP_LOG"\n',
  );
  fs.writeFileSync(changed, `${expected}unexpected\n`);
  fs.writeFileSync(
    receipt,
    [`file\tdelegation\t${changed}`, "manager-active\t501\t", "linger\tfixture-user\t"].join("\n") +
      "\n",
  );

  const cleanupRun = portableCleanupRun();
  expect(cleanupRun).toContain('sudo rmdir -- "$directory" || cleanup_failed=1');
  const fixtureStart = cleanupRun.indexOf('uid="$(id -u)"');
  expect(fixtureStart).toBeGreaterThanOrEqual(0);
  const cleanupFixture = cleanupRun
    .slice(fixtureStart)
    .replace('uid="$(id -u)"', 'uid="501"')
    .replace(
      'delegation_drop_in="/etc/systemd/system/user@.service.d/90-nemoclaw-cpu-delegation.conf"',
      `delegation_drop_in=${JSON.stringify(changed)}`,
    );

  try {
    const result = spawnSync("bash", ["-c", `set -eo pipefail\n${cleanupFixture}`], {
      encoding: "utf8",
      env: {
        ...process.env,
        E2E_PORTABLE_CPU_DELEGATION_RECEIPT: receipt,
        FAKE_CLEANUP_LOG: commandLog,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        USER: "fixture-user",
      },
      killSignal: "SIGKILL",
      timeout: 15_000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Refusing changed Portable CPU-delegation fixture file");
    expect(result.stderr).toContain(
      "Portable CPU-delegation cleanup detected invalid fixture state or a cleanup command failed",
    );
    expect(fs.readFileSync(commandLog, "utf8").trim().split("\n")).toEqual([
      "systemctl\tstop user@501.service",
      "systemctl\tdaemon-reload",
      "systemctl\tstart user@501.service",
      "loginctl\tdisable-linger fixture-user",
    ]);
    expect(fs.readFileSync(changed, "utf8")).toBe(`${expected}unexpected\n`);
    expect(fs.existsSync(receipt)).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
