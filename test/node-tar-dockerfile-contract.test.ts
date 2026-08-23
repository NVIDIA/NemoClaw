// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { NODE_BASES_REQUIRING_BUNDLED_NPM_TAR_PATCH } from "../scripts/patch-bundled-npm-tar.mts";
import {
  dockerfileRunCommandPositions,
  requireReviewedDockerfileRunCommands,
  requireSingleReviewedDockerfileRunCommand,
} from "./helpers/dockerfile-run-commands";

const repoRoot = path.resolve(import.meta.dirname, "..");
const dockerfiles = [
  {
    file: "Dockerfile.base",
    installsPatchDownloader: false,
    installsWithNpm: true,
    patchCount: 2,
  },
  { file: "Dockerfile", installsPatchDownloader: false, installsWithNpm: true, patchCount: 1 },
  {
    file: "agents/hermes/Dockerfile.base",
    installsPatchDownloader: false,
    installsWithNpm: true,
    patchCount: 2,
  },
  {
    file: "agents/hermes/Dockerfile",
    installsPatchDownloader: false,
    installsWithNpm: true,
    patchCount: 1,
  },
  {
    file: "agents/langchain-deepagents-code/Dockerfile.base",
    installsPatchDownloader: true,
    installsWithNpm: false,
    patchCount: 2,
  },
  {
    file: "agents/langchain-deepagents-code/Dockerfile",
    installsPatchDownloader: false,
    installsWithNpm: false,
    patchCount: 1,
  },
  {
    file: "agents/pi/Dockerfile.base",
    installsPatchDownloader: true,
    installsWithNpm: true,
    patchCount: 2,
  },
  {
    file: "agents/pi/Dockerfile",
    installsPatchDownloader: false,
    installsWithNpm: false,
    patchCount: 1,
  },
] as const;
const patchCommand = "node --experimental-strip-types /scripts/patch-bundled-npm-tar.mts";
const npmRootArguments = ["--npm-root", "/usr/local/lib/node_modules/npm"] as const;
const pinnedBaseDockerfiles = [
  "Dockerfile.base",
  "agents/hermes/Dockerfile.base",
  "agents/langchain-deepagents-code/Dockerfile.base",
  "agents/pi/Dockerfile.base",
] as const;
const reviewedNodeBases = new Set<string>(NODE_BASES_REQUIRING_BUNDLED_NPM_TAR_PATCH);

interface ShellToken {
  end: number;
  staticValue: string | undefined;
}

function isShellTokenBoundary(character: string): boolean {
  return (
    character === " " ||
    character === "\t" ||
    character === "\r" ||
    character === "\n" ||
    ";&|(){}<>".includes(character)
  );
}

function readShellToken(source: string, start: number): ShellToken | undefined {
  let cursor = start;
  while (cursor < source.length && isShellTokenBoundary(source[cursor]!)) cursor += 1;
  const tokenStart = cursor;
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  let expanded = false;
  let staticValue = "";
  token: while (cursor < source.length) {
    const character = source[cursor]!;
    switch (true) {
      case escaped:
        escaped = false;
        staticValue += character;
        cursor += 1;
        continue;
      case character === "\\" &&
        quote !== "'" &&
        (quote !== '"' || ["$", "`", '"', "\\"].includes(source[cursor + 1]!)):
        escaped = true;
        cursor += 1;
        continue;
      case quote !== null:
        switch (quote === "`" || (quote === '"' && character === "$")) {
          case true:
            expanded = true;
        }
        switch (character === quote) {
          case true:
            quote = null;
            break;
          default:
            staticValue += character;
        }
        cursor += 1;
        continue;
      case character === "'" || character === '"' || character === "`":
        expanded = expanded || character === "`";
        quote = character;
        cursor += 1;
        continue;
      case isShellTokenBoundary(character):
        break token;
      default:
        switch (character === "$" || "*?[~".includes(character)) {
          case true:
            expanded = true;
            break;
          default:
            staticValue += character;
        }
        cursor += 1;
    }
  }
  switch (cursor === tokenStart) {
    case true:
      return undefined;
  }
  return {
    end: cursor,
    staticValue: quote === null && !escaped && !expanded ? staticValue : undefined,
  };
}

type NpmSubcommand = { kind: "known"; value: string } | { kind: "none" } | { kind: "unclassified" };

function npmSubcommand(source: string, start: number): NpmSubcommand {
  let token = readShellToken(source, start);
  while (token !== undefined) {
    const value = token.staticValue;
    switch (value) {
      case undefined:
        return { kind: "unclassified" };
    }
    switch (value.startsWith("-")) {
      case false:
        return { kind: "known", value };
    }
    switch (value) {
      case "--silent":
        token = readShellToken(source, token.end);
        continue;
      case "--prefix": {
        const prefix = readShellToken(source, token.end);
        switch (prefix) {
          case undefined:
            return { kind: "unclassified" };
          default: {
            const prefixValue = prefix.staticValue;
            switch (
              prefixValue === undefined ||
              prefixValue === "" ||
              prefixValue.startsWith("-")
            ) {
              case true:
                return { kind: "unclassified" };
            }
            token = readShellToken(source, prefix.end);
            continue;
          }
        }
      }
      default: {
        const inlinePrefix = value.startsWith("--prefix=")
          ? value.slice("--prefix=".length)
          : undefined;
        switch (inlinePrefix) {
          case undefined:
          case "":
            return { kind: "unclassified" };
          default:
            token = readShellToken(source, token.end);
            continue;
        }
      }
    }
  }
  return { kind: "none" };
}

function npmConsumerPositions(source: string): number[] {
  const executableSource = source.replace(/\\\s*\n/gu, (continuation) =>
    " ".repeat(continuation.length),
  );
  return dockerfileRunCommandPositions(source, "npm").filter((index) => {
    const subcommand = npmSubcommand(executableSource, index + "npm".length);
    return (
      subcommand.kind === "unclassified" ||
      (subcommand.kind === "known" && (subcommand.value === "ci" || subcommand.value === "install"))
    );
  });
}

function nodeBaseReferences(source: string): string[] {
  return [
    ...new Set(
      [...source.matchAll(/^FROM\s+(node:[^\s]+@sha256:[0-9a-f]{64})(?:\s|$)/gmu)].map(
        (match) => match[1]!,
      ),
    ),
  ].sort();
}

function assertReviewedNodeBases(file: string, source: string): void {
  const bases = nodeBaseReferences(source);
  assert(bases.length > 0, `${file} must pin at least one upstream Node base image`);
  const unreviewed = bases.filter((base) => !reviewedNodeBases.has(base));
  assert.deepEqual(unreviewed, [], `${file} contains an unreviewed upstream Node base image`);
}

function completedStage(source: string): string {
  const finalStageStart = [...source.matchAll(/^FROM\b/gmu)].at(-1)?.index;
  assert(finalStageStart !== undefined, "Dockerfile must contain a completed image stage");
  return source.slice(finalStageStart);
}

function namedStage(source: string, name: string): string {
  const stageStart = source.indexOf(`FROM scratch AS ${name}`);
  assert(stageStart >= 0, `Dockerfile must contain the ${name} stage`);
  const nextStage = source.indexOf("\nFROM ", stageStart);
  return source.slice(stageStart, nextStage >= 0 ? nextStage : undefined);
}

describe("node-tar image remediation contract", () => {
  it("binds the remediation lifecycle to the affected upstream Node image pins", () => {
    const observedBases = new Set<string>();
    pinnedBaseDockerfiles.forEach((file) => {
      const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
      assertReviewedNodeBases(file, source);
      for (const base of nodeBaseReferences(source)) observedBases.add(base);
    });
    expect([...observedBases].sort()).toEqual(
      [...NODE_BASES_REQUIRING_BUNDLED_NPM_TAR_PATCH].sort(),
    );
  });

  // source-shape-contract: security -- Each managed Dockerfile must remain bound to a reviewed Node base digest.
  it("rejects an isolated unreviewed Deep Agents Code Node base pin", () => {
    const file = "agents/langchain-deepagents-code/Dockerfile.base";
    const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
    const reviewedBase = NODE_BASES_REQUIRING_BUNDLED_NPM_TAR_PATCH.find((base) =>
      base.startsWith("node:22-"),
    );
    assert(reviewedBase !== undefined, "the reviewed Node 22 base must be registered");
    const unreviewedBase = `node:22-trixie-slim@sha256:${"0".repeat(64)}`;
    const changedSource = source.replaceAll(reviewedBase, unreviewedBase);

    expect(() => assertReviewedNodeBases(file, changedSource)).toThrow(
      `${file} contains an unreviewed upstream Node base image`,
    );
  });

  it.each([
    "Dockerfile.base",
    "agents/hermes/Dockerfile.base",
    "agents/langchain-deepagents-code/Dockerfile.base",
    "agents/pi/Dockerfile.base",
  ])("installs curl before patching the bundled npm tar in $file", (file) => {
    const source = completedStage(fs.readFileSync(path.join(repoRoot, file), "utf8"));
    const curlInstall = source.indexOf("curl=");
    const patchRuns = requireReviewedDockerfileRunCommands(
      source,
      patchCommand,
      npmRootArguments,
      2,
    );

    expect(curlInstall, file).toBeGreaterThanOrEqual(0);
    expect(
      patchRuns.every((patchRun) => patchRun.commandStart > curlInstall),
      file,
    ).toBe(true);
  });

  it.each(dockerfiles)(
    "places bundled npm tar remediation in the final $file stage before any npm consumers",
    (entry) => {
      const { file, installsPatchDownloader, installsWithNpm } = entry;
      const dockerfile = fs.readFileSync(path.join(repoRoot, file), "utf8");
      const source = completedStage(dockerfile);
      const patchPayloadStage = ["hermes-npm-patch-payload", "openclaw-dependency-payload"].find(
        (stage) => source.includes(`COPY --from=${stage} / /`),
      );
      const patchPayloadLayer =
        patchPayloadStage === undefined
          ? -1
          : source.indexOf(`COPY --from=${patchPayloadStage} / /`);
      const patchInputStage =
        patchPayloadStage === undefined ? source : namedStage(dockerfile, patchPayloadStage);
      const flattenedPatchInputStage = patchInputStage
        .replace(/\\\s*\n/g, " ")
        .replace(/\s+/g, " ");
      const reviewedCopy = patchInputStage.indexOf("COPY scripts/lib/reviewed-npm-archive.mts");
      const helperCopy = patchInputStage.indexOf("scripts/lib/bundled-npm-package.mts");
      const patchCopy = patchInputStage.indexOf(
        "COPY scripts/patch-bundled-npm-tar.mts /scripts/patch-bundled-npm-tar.mts",
      );
      const patchRuns = requireReviewedDockerfileRunCommands(
        source,
        patchCommand,
        npmRootArguments,
        entry.patchCount,
      );
      const firstPatchRun = patchRuns[0]!.commandStart;
      const lastPatchRun = patchRuns.at(-1)!.commandStart;
      const patchInputReady = patchPayloadLayer >= 0 ? patchPayloadLayer : patchCopy;

      expect(reviewedCopy, file).toBeGreaterThanOrEqual(0);
      expect(
        flattenedPatchInputStage.includes(
          "COPY scripts/lib/reviewed-npm-archive.mts scripts/lib/bundled-npm-package.mts scripts/lib/reviewed-npm-audit.mts scripts/lib/openclaw-npm-remediation.mts /scripts/lib/",
        ) ||
          patchInputStage.includes(
            "COPY scripts/lib/reviewed-npm-archive.mts /scripts/lib/reviewed-npm-archive.mts",
          ),
        file,
      ).toBe(true);
      expect(helperCopy, file).toBeGreaterThan(reviewedCopy);
      expect(patchCopy, file).toBeGreaterThan(helperCopy);
      expect(firstPatchRun, file).toBeGreaterThan(patchInputReady);
      const aptInstall = source.indexOf(
        "RUN apt-get update && apt-get install -y --no-install-recommends",
        patchInputReady,
      );
      const curlPackage = source.indexOf("curl=8.14.1-2+deb13u4", aptInstall);
      const aptInstallCleanup = source.indexOf("&& rm -rf /var/lib/apt/lists/*", curlPackage);
      expect(
        aptInstall > patchCopy &&
          curlPackage > aptInstall &&
          aptInstallCleanup > curlPackage &&
          aptInstallCleanup < firstPatchRun,
        file,
      ).toBe(installsPatchDownloader);
      const npmConsumers = npmConsumerPositions(source);
      expect(npmConsumers.length > 0, file).toBe(installsWithNpm);
      expect(
        npmConsumers.every((index) => index > lastPatchRun),
        file,
      ).toBe(true);
    },
  );
});

describe("reviewed npm image remediation contract", () => {
  it.each([
    ["a flag-only global option", "npm --silent ci"],
    ["mixed global options", "npm --prefix /work --silent install"],
    ["repeated flag-only global options", "npm --silent --silent ci"],
    ["a nonempty inline global option operand", "npm --prefix=/work install"],
    ["a quoted global option operand", 'npm --prefix "/tmp/npm cache" ci'],
    ["an escaped-space global option operand", "npm --prefix /tmp/npm\\ cache install"],
    ["a quoted subcommand", 'npm "ci"'],
    ["an escaped subcommand", "npm in\\stall"],
    ["a dynamic subcommand", 'npm "$NPM_SUBCOMMAND"'],
    ["an incomplete inline global option operand", 'npm --prefix="/tmp/npm cache install'],
    ["a missing global option operand", "npm --prefix --silent ci"],
    ["an empty inline global option operand", "npm --prefix= --silent ci"],
    ["an unknown global option", "npm --future-option ci"],
  ])("discovers npm consumers with %s (#9933)", (_label, body) => {
    const source = `RUN ${body}\n`;

    expect(npmConsumerPositions(source)).toEqual([source.indexOf("npm")]);
  });

  it.each([
    "npm --silent view",
    "npm --prefix /work view",
    "npm --silent --silent view",
    "npm --prefix=/work view",
    'npm "view"',
  ])("ignores a supported global option before a non-consumer subcommand in %s (#9933)", (body) => {
    expect(npmConsumerPositions(`RUN ${body}\n`)).toEqual([]);
  });

  it("does not treat an assignment value as a pre-remediation npm consumer (#9933)", () => {
    const source = [
      "RUN VALUE=npm ci",
      `RUN ${patchCommand} ${npmRootArguments.join(" ")}`,
      "",
    ].join("\n");

    expect(npmConsumerPositions(source)).toEqual([]);
  });

  it.each([
    ["an if condition", "if npm ci; then true; fi"],
    ["an elif condition", "if false; then true; elif npm install; then true; fi"],
    ["a while condition", "while npm ci; do true; done"],
    ["an until condition", "until npm install; do true; done"],
    ["a subshell group", "( npm ci )"],
    ["a brace group", "{ npm install; }"],
    ["a case branch", "case value in value) npm ci ;; esac"],
    ["a negated command", "! npm install"],
    ["a quoted assignment value", 'NPM_CONFIG_CACHE="/tmp/npm cache" npm ci'],
    ["an escaped-space assignment value", "NPM_CONFIG_CACHE=/tmp/npm\\ cache npm install"],
    ["a flag-only global option", "npm --silent ci"],
    ["mixed global options", "npm --prefix /work --silent install"],
    ["a quoted global option operand", 'npm --prefix "/tmp/npm cache" ci'],
    ["an escaped-space global option operand", "npm --prefix /tmp/npm\\ cache install"],
    ["a quoted subcommand", 'npm "ci"'],
    ["an escaped subcommand", "npm in\\stall"],
    ["a dynamic subcommand", 'npm "$NPM_SUBCOMMAND"'],
    ["an incomplete inline global option operand", 'npm --prefix="/tmp/npm cache install'],
  ])("detects npm consumers in %s before the final patch (#9933)", (_label, body) => {
    const source = [`RUN ${body}`, `RUN ${patchCommand} ${npmRootArguments.join(" ")}`, ""].join(
      "\n",
    );
    const patchRun = requireSingleReviewedDockerfileRunCommand(
      source,
      patchCommand,
      npmRootArguments,
    );
    const npmConsumers = npmConsumerPositions(source);

    expect(npmConsumers).toEqual([source.indexOf(" npm") + 1]);
    expect(npmConsumers.every((index) => index > patchRun.commandStart)).toBe(false);
  });

  it.each([
    { file: "Dockerfile.base", installsWithNpm: true },
    { file: "agents/hermes/Dockerfile.base", installsWithNpm: true },
    { file: "agents/langchain-deepagents-code/Dockerfile.base", installsWithNpm: false },
    { file: "agents/pi/Dockerfile.base", installsWithNpm: true },
  ])(
    "patches tar before and after upgrading the complete npm tree in $file",
    ({ file, installsWithNpm }) => {
      const source = completedStage(fs.readFileSync(path.join(repoRoot, file), "utf8"));
      const patchRuns = requireReviewedDockerfileRunCommands(
        source,
        patchCommand,
        npmRootArguments,
        2,
      );
      const upgradeCopy = source.indexOf(
        "COPY scripts/upgrade-bundled-npm.mts /scripts/upgrade-bundled-npm.mts",
      );
      const upgradeRun = requireSingleReviewedDockerfileRunCommand(
        source,
        "node --experimental-strip-types /scripts/upgrade-bundled-npm.mts",
        npmRootArguments,
      ).commandStart;

      expect(upgradeCopy, file).toBeGreaterThanOrEqual(0);
      expect(patchRuns[0]!.commandStart, file).toBeGreaterThan(upgradeCopy);
      expect(upgradeRun, file).toBeGreaterThan(patchRuns[0]!.commandStart);
      expect(patchRuns[1]!.commandStart, file).toBeGreaterThan(upgradeRun);

      const npmConsumers = npmConsumerPositions(source);
      expect(npmConsumers.length > 0, file).toBe(installsWithNpm);
      expect(
        npmConsumers.every((index) => index > patchRuns[1]!.commandStart),
        file,
      ).toBe(true);
    },
  );
});
