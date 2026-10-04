// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildTrustedProxyEnvSourceShell } from "./trusted-proxy-env";

const tempRoots = new Set<string>();

function tempPath(name: string): { file: string; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-trusted-proxy-env-"));
  tempRoots.add(root);
  return { file: path.join(root, name), root };
}

function runSource(file: string) {
  return spawnSync(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `${buildTrustedProxyEnvSourceShell(file)}\nprintf 'PROXY=[%s]' "\${HTTP_PROXY:-}"`,
    ],
    { encoding: "utf8", env: { ...process.env, HTTP_PROXY: "" } },
  );
}

afterEach(() => {
  tempRoots.forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
  tempRoots.clear();
});

describe("trusted proxy env source shell", () => {
  it("suppresses source output while preserving exported proxy variables", () => {
    const { file } = tempPath("proxy-env.sh");
    fs.writeFileSync(
      file,
      "printf 'NEMOCLAW_MCP_PROBE_HTTP_CODE=200\\n'\nexport HTTP_PROXY=http://proxy.test:3128\n",
      { mode: 0o444 },
    );
    fs.chmodSync(file, 0o444);

    const result = runSource(file);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("PROXY=[http://proxy.test:3128]");
    expect(result.stdout).not.toContain("NEMOCLAW_MCP_PROBE_HTTP_CODE");
  });

  it("fails closed for a writable proxy env file", () => {
    const { file } = tempPath("proxy-env.sh");
    fs.writeFileSync(file, "export HTTP_PROXY=http://proxy.test:3128\n", { mode: 0o644 });
    fs.chmodSync(file, 0o644);

    const result = runSource(file);

    expect(result.status).toBe(126);
    expect(result.stderr).toContain("unsafe permissions");
    expect(result.stdout).not.toContain("PROXY=");
  });

  it("fails closed for a symlink or a source-time error", () => {
    const symlinkFixture = tempPath("proxy-env.sh");
    const target = path.join(symlinkFixture.root, "target.sh");
    fs.writeFileSync(target, "export HTTP_PROXY=http://proxy.test:3128\n", { mode: 0o444 });
    fs.symlinkSync(target, symlinkFixture.file);

    const symlinkResult = runSource(symlinkFixture.file);
    expect(symlinkResult.status).toBe(126);
    expect(symlinkResult.stderr).toContain("expected regular root-owned mode 444 file");

    const failureFixture = tempPath("proxy-env.sh");
    fs.writeFileSync(failureFixture.file, "return 1\n", { mode: 0o444 });
    fs.chmodSync(failureFixture.file, 0o444);

    const failureResult = runSource(failureFixture.file);
    expect(failureResult.status).toBe(126);
    expect(failureResult.stderr).toContain("could not be sourced safely");
  });
});
