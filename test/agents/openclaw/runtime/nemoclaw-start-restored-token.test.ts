// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it, onTestFinished } from "vitest";
import { extractShellFunctionFromSource } from "../../../helpers/shell-source";

const START_SCRIPT = path.join(
  import.meta.dirname,
  "..",
  "../../..",
  "scripts",
  "nemoclaw-start.sh",
);
const JSON5_MODULE = path.join(
  import.meta.dirname,
  "..",
  "../../..",
  "nemoclaw",
  "node_modules",
  "json5",
);

it("rotates a restored redaction marker before exporting gateway auth (#11764)", () => {
  const source = fs.readFileSync(START_SCRIPT, "utf8");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-restored-token-"));
  onTestFinished(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const configDir = path.join(tempDir, ".openclaw");
  const configPath = path.join(configDir, "openclaw.json");
  const moduleRoot = path.join(tempDir, "opt", "nemoclaw");
  const scriptPath = path.join(tempDir, "run.sh");
  const redactionMarker = "[STRIPPED_BY_MIGRATION]";
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.join(moduleRoot, "node_modules"), { recursive: true });
  fs.cpSync(JSON5_MODULE, path.join(moduleRoot, "node_modules", "json5"), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ gateway: { auth: { token: redactionMarker } } }));

  const adapt = (name: string) =>
    extractShellFunctionFromSource(source, name)
      .replaceAll("/sandbox/.openclaw/openclaw.json", configPath)
      .replaceAll("/opt/nemoclaw", moduleRoot)
      .replaceAll("/usr/local/bin/node", process.execPath);
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      adapt("_read_gateway_token"),
      adapt("ensure_gateway_token"),
      adapt("ensure_gateway_token_if_missing"),
      adapt("export_gateway_token"),
      'run_openclaw_config_as_owner() { "$@"; }',
      'export OPENCLAW_GATEWAY_TOKEN="stale-token"',
      "ensure_gateway_token_if_missing",
      "export_gateway_token",
      'printf "TOKEN=%s\\n" "$OPENCLAW_GATEWAY_TOKEN"',
    ].join("\n"),
    { mode: 0o700 },
  );

  const result = spawnSync("bash", [scriptPath], { encoding: "utf8", timeout: 5000 });
  const restored = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const freshToken = restored.gateway.auth.token as string;
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(freshToken).not.toBe("");
  expect(freshToken).not.toBe(redactionMarker);
  expect(result.stdout).toBe(`TOKEN=${freshToken}\n`);
  expect(result.stdout).not.toContain("stale-token");
  expect(result.stdout).not.toContain(redactionMarker);
});
