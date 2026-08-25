// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import {
  FIXED_IP_ADDRESS_INTEGRITY,
  FIXED_IP_ADDRESS_TARBALL,
  FIXED_IP_ADDRESS_VERSION,
  REVIEWED_NPM_VERSION,
} from "../../../scripts/lib/patch-bundled-npm-ip-address.mts";
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
  "COPY scripts/lib/patch-bundled-npm-ip-address.mts /scripts/lib/patch-bundled-npm-ip-address.mts";
const patchCommand =
  "node --experimental-strip-types /scripts/lib/patch-bundled-npm-ip-address.mts";
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

describe("bundled npm ip-address image remediation contract", () => {
  it("binds the replacement to the reviewed npm and registry artifact", () => {
    expect(REVIEWED_NPM_VERSION).toBe(UPGRADED_NPM_VERSION);
    expect(REVIEWED_NPM_VERSION).toBe("11.18.0");
    expect(FIXED_IP_ADDRESS_VERSION).toBe("10.3.1");
    expect(FIXED_IP_ADDRESS_INTEGRITY).toBe(
      "sha512-1e9d3kb97NHJTIJDZW9rKqW2h6+dFa50Dy0fpPSMQp2ADje5gvKsXmdiK6dwY5t76TaTt5+P5N1Y/LoToIxP6g==",
    );
    expect(FIXED_IP_ADDRESS_TARBALL).toBe(
      "https://registry.npmjs.org/ip-address/-/ip-address-10.3.1.tgz",
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
    const patch = requireSingleReviewedDockerfileRunCommand(source, patchCommand, npmRootArguments);

    expect(copy, file).toBeGreaterThanOrEqual(0);
    expect(upgrade, file).toBeGreaterThan(copy);
    expect(patch.commandStart, file).toBeGreaterThan(upgrade);
  });

  it.each(finalDockerfiles)("reasserts the private package fix in the completed %s", (file) => {
    const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
    const copy = source.indexOf(copyInstruction);
    const tarPatch = requireSingleReviewedDockerfileRunCommand(
      source,
      "node --experimental-strip-types /scripts/patch-bundled-npm-tar.mts",
      tarPatchArgumentsByDockerfile[file],
    ).commandStart;
    const bracePatch = requireSingleReviewedDockerfileRunCommand(
      source,
      "node --experimental-strip-types /scripts/patch-bundled-npm-brace-expansion.mts",
      npmRootArguments,
    ).commandStart;
    const ipAddressPatch = requireSingleReviewedDockerfileRunCommand(
      source,
      patchCommand,
      npmRootArguments,
    );

    expect(copy, file).toBeGreaterThanOrEqual(0);
    expect(tarPatch, file).toBeGreaterThan(copy);
    expect(bracePatch, file).toBeGreaterThan(tarPatch);
    expect(ipAddressPatch.commandStart, file).toBeGreaterThan(bracePatch);
  });
});
