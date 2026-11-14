// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";
import {
  FIXED_IP_ADDRESS_INTEGRITY,
  FIXED_IP_ADDRESS_TARBALL,
  FIXED_IP_ADDRESS_VERSION,
  REVIEWED_NPM_VERSION,
} from "../../../scripts/lib/patch-bundled-npm-ip-address.mts";
import { REVIEWED_NPM_VERSION as UPGRADED_NPM_VERSION } from "../../../scripts/upgrade-bundled-npm.mts";
import {
  dockerfileInstructions,
  dockerfileRunCommandPositions,
  requireDockerfileCopySources,
  requireReviewedDockerfileRunCommands,
  requireSingleDockerfileCopySource,
  requireSingleReviewedDockerfileRunCommand,
} from "../../helpers/dockerfile-run-commands";

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
const copySource = "scripts/lib/patch-bundled-npm-ip-address.mts";
const copyDestination = "/scripts/lib/patch-bundled-npm-ip-address.mts";
const patchCommand = "node /scripts/lib/patch-bundled-npm-ip-address.mts";
const npmRootArguments = ["--npm-root", "/usr/local/lib/node_modules/npm"] as const;
const hermesTarCacheSeedArguments = [
  ...npmRootArguments,
  "--archive",
  "/scripts/nemoclaw-bundled-npm-tar.tgz",
] as const;
const tarPatchArgumentsByDockerfile = {
  Dockerfile: npmRootArguments,
  "agents/hermes/Dockerfile": hermesTarCacheSeedArguments,
  "agents/langchain-deepagents-code/Dockerfile": npmRootArguments,
} as const;
const tarPatchCountByDockerfile = {
  Dockerfile: 2,
  "agents/hermes/Dockerfile": 1,
  "agents/langchain-deepagents-code/Dockerfile": 1,
} as const;

describe("bundled npm ip-address image remediation contract", () => {
  it("binds the replacement to the reviewed npm and registry artifact", () => {
    expect(REVIEWED_NPM_VERSION).toBe(UPGRADED_NPM_VERSION);
    expect(REVIEWED_NPM_VERSION).toBe("12.0.2");
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
    const copy = requireSingleDockerfileCopySource(source, copySource, copyDestination).start;
    const upgrade = requireSingleReviewedDockerfileRunCommand(
      source,
      "node /scripts/upgrade-bundled-npm.mts",
      npmRootArguments,
    ).commandStart;
    const patch = requireSingleReviewedDockerfileRunCommand(source, patchCommand, npmRootArguments);

    expect(copy, file).toBeGreaterThanOrEqual(0);
    expect(upgrade, file).toBeGreaterThan(copy);
    expect(patch.commandStart, file).toBeGreaterThan(upgrade);
  });

  it.each(finalDockerfiles)("reasserts the private package fix in the completed %s", (file) => {
    const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
    const copy = requireDockerfileCopySources(
      source,
      copySource,
      copyDestination,
      tarPatchCountByDockerfile[file],
    ).at(-1)!.start;
    const tarPatches = requireReviewedDockerfileRunCommands(
      source,
      "node /scripts/patch-bundled-npm-tar.mts",
      tarPatchArgumentsByDockerfile[file],
      tarPatchCountByDockerfile[file],
    );
    const tarPatch = tarPatches.at(-1)!.commandStart;
    const bracePatches = requireReviewedDockerfileRunCommands(
      source,
      "node /scripts/patch-bundled-npm-brace-expansion.mts",
      npmRootArguments,
      tarPatchCountByDockerfile[file],
    );
    const bracePatch = bracePatches.at(-1)!.commandStart;
    const ipAddressPatches = requireReviewedDockerfileRunCommands(
      source,
      patchCommand,
      npmRootArguments,
      tarPatchCountByDockerfile[file],
    );
    const ipAddressPatch = ipAddressPatches.at(-1)!;

    expect(tarPatch, file).toBeGreaterThan(copy);
    expect(bracePatch, file).toBeGreaterThan(tarPatch);
    expect(ipAddressPatch.commandStart, file).toBeGreaterThan(bracePatch);
  });
});

describe("bundled npm Undici image remediation contract", () => {
  it.each([
    ...baseDockerfiles,
    ...finalDockerfiles,
    "agents/pi/Dockerfile.base",
    "agents/pi/Dockerfile",
  ])("patches global npm after the reviewed upgrade in %s", (file) => {
    const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
    const count = file === "Dockerfile" ? 2 : 1;
    const copies = requireDockerfileCopySources(
      source,
      "scripts/lib/patch-bundled-npm-undici.mts",
      "/scripts/lib/patch-bundled-npm-undici.mts",
      count,
    );
    const previous = requireReviewedDockerfileRunCommands(
      source,
      patchCommand,
      npmRootArguments,
      count,
    );
    const patches = requireReviewedDockerfileRunCommands(
      source,
      "node /scripts/lib/patch-bundled-npm-undici.mts",
      npmRootArguments,
      count,
    );
    patches.forEach((patch, index) => {
      expect(patch.commandStart, file).toBeGreaterThan(copies[index].start);
      expect(patch.commandStart, file).toBeGreaterThan(previous[index].commandStart);
    });
  });
});

describe.each(["Dockerfile.base", "Dockerfile"])(
  "%s OpenClaw workspace override remediation",
  (file) => {
    it.each(["2026.9.2", "2026.9.5", "2026.9.7", "2026.10.5", ""])(
      "applies overrides only for the reviewed version: %s",
      (version) => {
        const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
        const helper = "/scripts/lib/patch-openclaw-dependency-overrides.mts";
        const copies = requireDockerfileCopySources(
          source,
          helper.slice(1),
          helper,
          file === "Dockerfile" ? 2 : 1,
        );
        const calls = dockerfileRunCommandPositions(source, `node ${helper}`);
        const installs = dockerfileRunCommandPositions(
          source,
          "node /usr/local/lib/nemoclaw/openclaw-runtime/node_modules/openclaw/scripts/postinstall-bundled-plugins.mjs",
        );
        expect(calls).toHaveLength(1);
        expect(installs).toHaveLength(1);
        copies.forEach((copy) => expect(calls[0]).toBeGreaterThan(copy.start));
        expect(calls[0]).toBeGreaterThan(installs[0]);
        const instruction = dockerfileInstructions(source).find(
          (entry) => entry.start <= calls[0] && entry.end > calls[0],
        )!;
        // Execute the owning RUN with only its node boundary replaced. This checks
        // the version guard and actual argument handoff without installing packages.
        const result = spawnSync(
          "/bin/sh",
          ["-c", `node() { printf '%s\\n' "$@"; }; ${instruction.body}`],
          { encoding: "utf8", env: { PATH: "/usr/bin:/bin", OPENCLAW_VERSION: version } },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe(
          ["2026.9.2", "2026.10.5"].includes(version)
            ? `${helper}\n/usr/local/lib/nemoclaw/openclaw-runtime/node_modules/openclaw\n`
            : "",
        );
      },
    );
  },
);
