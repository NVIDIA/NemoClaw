// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import {
  FIXED_BRACE_EXPANSION_INTEGRITY,
  FIXED_BRACE_EXPANSION_TARBALL,
  FIXED_BRACE_EXPANSION_VERSION,
  REVIEWED_NPM_VERSION,
} from "../scripts/patch-bundled-npm-brace-expansion.mts";
import { REVIEWED_NPM_VERSION as UPGRADED_NPM_VERSION } from "../scripts/upgrade-bundled-npm.mts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const baseDockerfiles = [
  "Dockerfile.base",
  "agents/hermes/Dockerfile.base",
  "agents/langchain-deepagents-code/Dockerfile.base",
] as const;
const finalDockerfiles = [
  "Dockerfile",
  "agents/hermes/Dockerfile",
  "agents/langchain-deepagents-code/Dockerfile",
] as const;
const copyInstruction =
  "COPY scripts/patch-bundled-npm-brace-expansion.mts /scripts/patch-bundled-npm-brace-expansion.mts";
const patchInstruction =
  "RUN node --experimental-strip-types /scripts/patch-bundled-npm-brace-expansion.mts";

describe("bundled npm brace-expansion image remediation contract", () => {
  it("binds the replacement to the reviewed npm and registry artifact", () => {
    expect(REVIEWED_NPM_VERSION).toBe(UPGRADED_NPM_VERSION);
    expect(REVIEWED_NPM_VERSION).toBe("11.18.0");
    expect(FIXED_BRACE_EXPANSION_VERSION).toBe("5.0.8");
    expect(FIXED_BRACE_EXPANSION_INTEGRITY).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/u);
    expect(FIXED_BRACE_EXPANSION_TARBALL).toBe(
      "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.8.tgz",
    );
  });

  it.each(baseDockerfiles)("patches the reviewed npm tree after upgrading it in %s", (file) => {
    const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
    const copy = source.indexOf(copyInstruction);
    const upgrade = source.indexOf(
      "RUN node --experimental-strip-types /scripts/upgrade-bundled-npm.mts",
    );
    const patch = source.indexOf(patchInstruction);

    expect(copy, file).toBeGreaterThanOrEqual(0);
    expect(upgrade, file).toBeGreaterThan(copy);
    expect(patch, file).toBeGreaterThan(upgrade);
    expect(source.slice(patch)).toContain("--npm-root /usr/local/lib/node_modules/npm");
  });

  it.each(
    finalDockerfiles,
  )("reasserts the private package fix in the completed %s filesystem", (file) => {
    const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
    const copy = source.indexOf(copyInstruction);
    const tarPatch = source.indexOf(
      "RUN node --experimental-strip-types /scripts/patch-bundled-npm-tar.mts",
    );
    const bracePatch = source.indexOf(patchInstruction);

    expect(copy, file).toBeGreaterThanOrEqual(0);
    expect(tarPatch, file).toBeGreaterThan(copy);
    expect(bracePatch, file).toBeGreaterThan(tarPatch);
    expect(source.slice(bracePatch)).toContain("--npm-root /usr/local/lib/node_modules/npm");
  });
});
