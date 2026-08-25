// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

const GUARD_PATH = path.resolve("scripts/openclaw-config-guard.py");
const fixtures: string[] = [];
const RUN_UNLOCK_AS_CURRENT_USER = String.raw`
import importlib.util
import os
import sys
guard_path, config_dir = sys.argv[1:3]
spec = importlib.util.spec_from_file_location("nemoclaw_openclaw_config_guard", guard_path)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
identity = module.Identity(
    root_uid=os.getuid(),
    root_gid=os.getgid(),
    sandbox_uid=os.getuid(),
    sandbox_gid=os.getgid(),
)
module.os.geteuid = lambda: 0
module._production_identity = lambda: identity
module.PRODUCTION_CONFIG_DIR = config_dir
module.JOURNAL_PATH = os.path.join(os.path.dirname(config_dir), ".nemoclaw-test", "transaction.json")
module.MUTEX_PATH = os.path.join(os.path.dirname(config_dir), ".nemoclaw-test", "mutation.lock")
module.NODE_BINARY_PATH = os.environ["NEMOCLAW_TEST_NODE_PATH"]
module.JSON5_MODULE_PATH = os.environ["NEMOCLAW_TEST_JSON5_PATH"]
raise SystemExit(module.main(["unlock", "--config-dir", config_dir]))
`;

function mode(filePath: string): number {
  return fs.lstatSync(filePath).mode & 0o7777;
}

function fileIdentity(filePath: string): [number, Buffer] {
  const fd = fs.openSync(filePath, "r");
  try {
    return [fs.fstatSync(fd).ino, fs.readFileSync(fd)];
  } finally {
    fs.closeSync(fd);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

afterEach(() => {
  for (const root of fixtures.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("rejects malformed JSON without mutating the idempotent mutable unlock posture (#7538)", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-guard-unlock-")));
  fixtures.push(root);
  const configDir = path.join(root, ".openclaw");
  const configPath = path.join(configDir, "openclaw.json");
  const hashPath = path.join(configDir, ".config-hash");
  const nodePath = path.join(root, ".nemoclaw-test-node");
  const malformedConfig = Buffer.from('{"gateway":\n');
  fs.mkdirSync(configDir);
  fs.writeFileSync(nodePath, `#!/bin/sh\nexec ${shellQuote(process.execPath)} "$@"\n`, {
    mode: 0o500,
  });
  fs.writeFileSync(configPath, malformedConfig, { mode: 0o660 });
  fs.writeFileSync(
    hashPath,
    `${createHash("sha256").update(malformedConfig).digest("hex")}  openclaw.json\n`,
    { mode: 0o660 },
  );
  fs.chmodSync(configPath, 0o660);
  fs.chmodSync(hashPath, 0o660);
  fs.chmodSync(configDir, 0o2770);
  fs.chmodSync(root, 0o755);
  const fileIdentities = [configPath, hashPath].map(fileIdentity);

  const result = spawnSync("python3", ["-c", RUN_UNLOCK_AS_CURRENT_USER, GUARD_PATH, configDir], {
    encoding: "utf-8",
    timeout: 15_000,
    env: {
      ...process.env,
      NEMOCLAW_TEST_NODE_PATH: nodePath,
      NEMOCLAW_TEST_JSON5_PATH: fs.realpathSync(path.resolve("nemoclaw/node_modules/json5")),
    },
  });
  const lines = result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; code?: string });

  expect(result.status).toBe(1);
  expect(lines).toContainEqual(
    expect.objectContaining({ type: "issue", code: "invalid-config-json5" }),
  );
  expect([mode(root), mode(configDir), mode(configPath), mode(hashPath)]).toEqual([
    0o755, 0o2770, 0o660, 0o660,
  ]);
  expect([configPath, hashPath].map(fileIdentity)).toEqual(fileIdentities);
});
