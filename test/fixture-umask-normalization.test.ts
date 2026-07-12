// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

import vitestConfig from "../vitest.config";

const RUNTIME_CONFIG_GUARD = path.join(
  import.meta.dirname,
  "..",
  "agents",
  "hermes",
  "runtime-config-guard.py",
);

type ProjectEntry = { test?: { name?: string; setupFiles?: string[] } };
const FIXTURE_UMASK_SETUP = "test/helpers/normalize-fixture-umask.ts";

// Regression coverage for #6448. The shared setup file
// test/helpers/normalize-fixture-umask.ts must force the conventional CI
// file-creation umask (0o022) in every test worker, so Hermes/OpenClaw guard
// fixtures are never created group/world-writable on a developer host with a
// permissive ambient umask (e.g. 0002). Without it, the production
// runtime-config guard fails those fixtures closed with
// `UnsafePathError: refusing group/world-writable runtime config path`.

it("pins the test worker umask to the deterministic 0o022 baseline (#6448)", () => {
  // process.umask(mask) sets the umask and returns the previous value; setting it
  // to the value the setup already installed is a no-op, and the returned
  // previous value proves the setup pinned the worker to exactly 0o022 —
  // independent of the developer's ambient umask. The exact value matters: tests
  // assert group-readable fixture modes (e.g. a Hermes .env at 0o640) that only
  // hold at 0o022.
  const previous = process.umask(0o022);
  expect(previous).toBe(0o022);
});

it("keeps in-process fixture files free of group/world write bits (#6448)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-umask-regression-"));
  try {
    const file = path.join(dir, "config.yaml");
    fs.writeFileSync(file, "model: test\n");
    expect(fs.statSync(file).mode & 0o022).toBe(0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("propagates the safe umask to spawned fixture processes (#6448)", () => {
  // Guard fixtures are written by python/bash children spawned from the worker.
  // umask is inherited across spawn, so a child creating a normal file (which,
  // unlike tempfile.mkstemp, respects umask) must also produce a non
  // group/world-writable mode.
  const result = spawnSync(
    "python3",
    [
      "-c",
      [
        "import os, stat, sys, tempfile",
        "d = tempfile.mkdtemp()",
        "p = os.path.join(d, 'config.yaml')",
        "open(p, 'w', encoding='utf-8').write('model: test\\n')",
        "sys.stdout.write(str(stat.S_IMODE(os.stat(p).st_mode)))",
      ].join("\n"),
    ],
    { encoding: "utf-8", timeout: 5000 },
  );
  expect(result.status, result.stderr).toBe(0);
  const mode = Number.parseInt(result.stdout.trim(), 10);
  expect(mode & 0o022).toBe(0);
});

it("does not weaken the guard: an explicitly group/world-writable config is still rejected (#6448)", () => {
  // The normalization only affects how test fixtures are created; the production
  // guard must still fail closed on an explicitly unsafe (0o666) runtime config
  // path. This proves the harness change did not relax the security boundary.
  const result = spawnSync(
    "python3",
    [
      "-c",
      String.raw`
import importlib.util, os, sys, tempfile

spec = importlib.util.spec_from_file_location("guard", sys.argv[1])
guard = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = guard
spec.loader.exec_module(guard)

d = tempfile.mkdtemp()
os.chmod(d, 0o700)
p = os.path.join(d, "config.yaml")
open(p, "w", encoding="utf-8").write("model: test\n")
os.chmod(p, 0o666)
try:
    guard._open_regular(p).close()
except guard.UnsafePathError as exc:
    sys.stdout.write("REJECTED:" + str(exc))
else:
    sys.stdout.write("ACCEPTED")
`,
      RUNTIME_CONFIG_GUARD,
    ],
    { encoding: "utf-8", timeout: 5000 },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("REJECTED:");
  expect(result.stdout).toContain("group/world-writable");
});

// Named vitest projects (config objects), used by the config-contract guards
// below. A future edit that drops or misorders the setup would otherwise only
// resurface the permissive-umask failures on hosts with a permissive ambient
// umask (CI at 0o022 would not catch it).
function namedVitestProjects(): { name: string; setupFiles?: string[] }[] {
  const projects = (vitestConfig.test?.projects ?? []) as ProjectEntry[];
  return projects
    .map((project) => project.test)
    .filter((test): test is { name: string; setupFiles?: string[] } => test?.name !== undefined);
}

it("derives npm test projects and keeps omitted live projects off the fixture umask (#6448)", () => {
  const npmCli = process.env.npm_execpath ?? "";
  expect(npmCli).not.toBe("");

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-npm-test-projects-"));
  const fakeBin = path.join(fixtureRoot, "bin");
  const commandLog = path.join(fixtureRoot, "commands.log");
  const scriptShell = path.join(fixtureRoot, "script-shell");

  try {
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      scriptShell,
      `#!/bin/sh\nPATH="$FAKE_BIN:${path.dirname(process.execPath)}:/usr/bin:/bin"\nexport PATH\nexec /bin/sh "$@"\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(fakeBin, "npm"),
      '#!/bin/sh\nprintf \'npm %s\\n\' "$*" >> "$COMMAND_LOG"\n',
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(fakeBin, "vitest"),
      '#!/bin/sh\nprintf \'vitest %s\\n\' "$*" >> "$COMMAND_LOG"\n',
      { mode: 0o755 },
    );

    const result = spawnSync(process.execPath, [npmCli, "test"], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf8",
      env: {
        ...process.env,
        COMMAND_LOG: commandLog,
        FAKE_BIN: fakeBin,
        npm_config_script_shell: scriptShell,
      },
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);

    const vitestInvocation = fs
      .readFileSync(commandLog, "utf8")
      .split("\n")
      .find((line) => line.startsWith("vitest "));
    expect(vitestInvocation).toBeDefined();
    const selectedProjects = [...vitestInvocation!.matchAll(/--project\s+(\S+)/g)].map(
      ([, name]) => name,
    );
    expect(selectedProjects.length).toBeGreaterThan(0);

    const setupFilesByName = new Map(
      namedVitestProjects().map((test) => [test.name, test.setupFiles ?? []]),
    );
    const selectedProjectNames = new Set(selectedProjects);
    for (const name of selectedProjects) {
      const setupFiles = setupFilesByName.get(name);
      expect(setupFiles, name).toContain(FIXTURE_UMASK_SETUP);
      expect(setupFiles?.indexOf(FIXTURE_UMASK_SETUP), name).toBe(0);
    }
    for (const test of namedVitestProjects().filter(
      (project) => !selectedProjectNames.has(project.name),
    )) {
      expect(test.setupFiles ?? [], test.name).not.toContain(FIXTURE_UMASK_SETUP);
    }
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
