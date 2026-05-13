// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const PATCH_SCRIPT = path.join(REPO_ROOT, "scripts", "rcf_patch.py");

function runPatch(source: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rcf-patch-"));
  const file = path.join(dir, "mutate.js");
  fs.writeFileSync(file, source);
  try {
    const result = spawnSync("python3", [PATCH_SCRIPT, file], {
      encoding: "utf-8",
      timeout: 5000,
    });
    return {
      result,
      patched: fs.readFileSync(file, "utf-8"),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function replaceConfigFileBody(properties: string) {
  return `
async function replaceConfigFile(params) {
  const snapshot = params.snapshot;
  const writeOptions = params.writeOptions ?? {};
  if (! await tryWriteSingleTopLevelIncludeMutation({
${properties}
  })) await writeConfigFile(params.nextConfig, {
    baseSnapshot: snapshot,
    ...writeOptions,
    ...params.writeOptions
  });
}
`;
}

describe("rcf_patch.py", () => {
  it("patches replaceConfigFile with either snapshot/nextConfig property order", () => {
    for (const properties of [
      "    snapshot,\n    nextConfig: params.nextConfig",
      "    nextConfig: params.nextConfig,\n    snapshot",
    ]) {
      const { result, patched } = runPatch(replaceConfigFileBody(properties));
      expect(result.status).toBe(0);
      expect(patched).toContain("OPENSHELL_SANDBOX");
      expect(patched).toContain("try { if (!await tryWriteSingleTopLevelIncludeMutation");
    }
  });

  it("ignores braces inside strings and comments when locating replaceConfigFile", () => {
    const { result, patched } = runPatch(`
async function replaceConfigFile(params) {
  const stringBrace = "}";
  // comment brace: }
  /* block comment brace: } */
  const snapshot = params.snapshot;
  const writeOptions = params.writeOptions ?? {};
  if (!await tryWriteSingleTopLevelIncludeMutation({
    nextConfig: params.nextConfig,
    snapshot
  })) await writeConfigFile(params.nextConfig, {
    baseSnapshot: snapshot,
    ...writeOptions,
    ...params.writeOptions
  });
}
`);

    expect(result.status).toBe(0);
    expect(patched).toContain('const stringBrace = "}";');
    expect(patched).toContain("comment brace: }");
    expect(patched).toContain("OPENSHELL_SANDBOX");
  });

  it("fails closed when replaceConfigFile lacks the expected write block", () => {
    const { result, patched } = runPatch(`
async function replaceConfigFile(params) {
  await writeConfigFile(params.nextConfig, {});
}
`);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "tryWriteSingleTopLevelIncludeMutation/writeConfigFile pattern not found",
    );
    expect(patched).not.toContain("OPENSHELL_SANDBOX");
  });
});
