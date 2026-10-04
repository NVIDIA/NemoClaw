// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..", "..");
const url = (...segments: string[]) => pathToFileURL(path.join(repoRoot, ...segments)).href;

describe("credential filter package boundary", () => {
  it("resolves both package wrappers to one generated implementation (#8291)", () => {
    // Native resolution bypasses the Vitest source alias so this checks the
    // generated files that the published CLI and plugin load.
    const script =
      `const cli = await import(${JSON.stringify(url("dist/lib/security/credential-filter.js"))});` +
      `const plugin = await import(${JSON.stringify(url("nemoclaw/dist/security/credential-filter.js"))});` +
      `const patterns = await import(${JSON.stringify(url("dist/lib/security/secret-patterns.js"))});` +
      `const boundary = await import(${JSON.stringify(
        url("nemoclaw/dist/shared/credential-filter-boundary.cjs"),
      )});` +
      `const fixture = {headers:{Authorization:"Bearer opaque-package-contract-secret"},args:["--api-key","opaque-value"],model:"keep-me"};` +
      `process.stdout.write(JSON.stringify([cli.stripCredentials === boundary.stripCredentials, plugin.stripCredentials === boundary.stripCredentials, cli.sanitizeEnvFileContent === boundary.sanitizeEnvFileContent, plugin.sanitizeEnvFileContent === boundary.sanitizeEnvFileContent, patterns.SECRET_PATTERNS === boundary.SECRET_PATTERNS, cli.stripCredentials(fixture), plugin.stripCredentials(fixture)]));`;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
    });
    const placeholder = "[STRIPPED_BY_MIGRATION]";
    const expected = {
      headers: { Authorization: placeholder },
      args: ["--api-key", placeholder],
      model: "keep-me",
    };
    expect(JSON.parse(output)).toEqual([true, true, true, true, true, expected, expected]);
  });

  it("includes the CommonJS module and declaration in the plugin build (#8291)", () => {
    const sharedDirectory = path.join(repoRoot, "nemoclaw", "dist", "shared");
    expect(fs.existsSync(path.join(sharedDirectory, "credential-filter-boundary.cjs"))).toBe(true);
    expect(fs.existsSync(path.join(sharedDirectory, "credential-filter-boundary.d.cts"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(sharedDirectory, "credential-filter-boundary.js"))).toBe(false);
  });
});
