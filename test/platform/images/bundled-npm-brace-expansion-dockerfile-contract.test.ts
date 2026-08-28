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
} from "../../../scripts/patch-bundled-npm-brace-expansion.mts";
import { REVIEWED_NPM_VERSION as UPGRADED_NPM_VERSION } from "../../../scripts/upgrade-bundled-npm.mts";
import { requireSingleReviewedDockerfileRunCommand } from "../../helpers/dockerfile-run-commands";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
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
  "node --experimental-strip-types /scripts/patch-bundled-npm-brace-expansion.mts";
const npmRootArguments = ["--npm-root", "/usr/local/lib/node_modules/npm"] as const;
const hermesTarCacheSeedArguments = [
  ...npmRootArguments,
  "--archive",
  "/tmp/nemoclaw-bundled-npm-tar.tgz",
] as const;
const tarPatchArgumentsByDockerfile = {
  Dockerfile: npmRootArguments,
  "agents/hermes/Dockerfile": hermesTarCacheSeedArguments,
  "agents/langchain-deepagents-code/Dockerfile": npmRootArguments,
} as const;

describe("bundled npm brace-expansion image remediation contract", () => {
  it("binds the replacement to the reviewed npm and registry artifact", () => {
    expect(REVIEWED_NPM_VERSION).toBe(UPGRADED_NPM_VERSION);
    expect(REVIEWED_NPM_VERSION).toBe("11.18.0");
    expect(FIXED_BRACE_EXPANSION_VERSION).toBe("5.0.9");
    expect(FIXED_BRACE_EXPANSION_INTEGRITY).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/u);
    expect(FIXED_BRACE_EXPANSION_TARBALL).toBe(
      "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.9.tgz",
    );
  });

  it.each(baseDockerfiles)("patches the reviewed npm tree after upgrading it in %s", (file) => {
    const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
    const copy = source.indexOf(copyInstruction);
    const upgrade = requireSingleReviewedDockerfileRunCommand(
      source,
      "node --experimental-strip-types /scripts/upgrade-bundled-npm.mts",
      npmRootArguments,
    ).commandStart;
    const patch = requireSingleReviewedDockerfileRunCommand(
      source,
      patchInstruction,
      npmRootArguments,
    );

    expect(copy, file).toBeGreaterThanOrEqual(0);
    expect(upgrade, file).toBeGreaterThan(copy);
    expect(patch.commandStart, file).toBeGreaterThan(upgrade);
  });

  it.each(
    finalDockerfiles,
  )("reasserts the private package fix in the completed %s filesystem", (file) => {
    const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
    const copy = source.indexOf(copyInstruction);
    const tarPatch = requireSingleReviewedDockerfileRunCommand(
      source,
      "node --experimental-strip-types /scripts/patch-bundled-npm-tar.mts",
      tarPatchArgumentsByDockerfile[file],
    ).commandStart;
    const bracePatch = requireSingleReviewedDockerfileRunCommand(
      source,
      patchInstruction,
      npmRootArguments,
    );

    expect(copy, file).toBeGreaterThanOrEqual(0);
    expect(tarPatch, file).toBeGreaterThan(copy);
    expect(bracePatch.commandStart, file).toBeGreaterThan(tarPatch);
  });
});
