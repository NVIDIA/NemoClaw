// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { extractShellFunctionFromSource } from "../../../helpers/shell-source.ts";

const START_SCRIPT = path.resolve(import.meta.dirname, "../../../../scripts/nemoclaw-start.sh");
const fixtures: string[] = [];

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function writeProject(stateRoot: string, name: string): string {
  const pluginRoot = path.join(
    stateRoot,
    "npm",
    "projects",
    name,
    "node_modules",
    "@tencent-weixin",
    "openclaw-weixin",
  );
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, "package.json"),
    `${JSON.stringify({ name: "@tencent-weixin/openclaw-weixin", version: "2.4.3" })}\n`,
  );
  return pluginRoot;
}

function runRepair(stateRoot: string) {
  const source = fs.readFileSync(START_SCRIPT, "utf8");
  const repair = extractShellFunctionFromSource(source, "restore_openclaw_weixin_extension_link")
    .replace("local state_root=/sandbox/.openclaw", `local state_root=${shellQuote(stateRoot)}`);
  return spawnSync("bash", ["-c", `set -euo pipefail\n${repair}\nrestore_openclaw_weixin_extension_link`], {
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fs.rmSync(fixture, { recursive: true, force: true });
});

describe("OpenClaw managed WeChat extension restoration", () => {
  it("restores the exact reviewed npm project link", () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wechat-extension-"));
    fixtures.push(stateRoot);
    const pluginRoot = writeProject(stateRoot, "tencent-weixin-openclaw-weixin-reviewed");

    const result = runRepair(stateRoot);

    expect(result.status, result.stderr).toBe(0);
    expect(
      fs.realpathSync(path.join(stateRoot, "extensions", "openclaw-weixin")),
    ).toBe(fs.realpathSync(pluginRoot));
  });

  it("refuses ambiguous reviewed npm projects", () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wechat-extension-"));
    fixtures.push(stateRoot);
    writeProject(stateRoot, "candidate-one");
    writeProject(stateRoot, "candidate-two");

    const result = runRepair(stateRoot);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ambiguous OpenClaw WeChat package projects");
    expect(fs.existsSync(path.join(stateRoot, "extensions", "openclaw-weixin"))).toBe(false);
  });
});
