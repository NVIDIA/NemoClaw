// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { FIXED_TAR_VERSION } from "../../../scripts/patch-bundled-npm-tar.mts";
import {
  REVIEWED_NPM_ARCHIVE_SHA256,
  REVIEWED_NPM_TARBALL,
  REVIEWED_NPM_VERSION,
} from "../../../scripts/upgrade-bundled-npm.mts";
import {
  dockerfileInstructions,
  dockerfileRunCommandPositions,
  requireReviewedDockerfileRunCommands,
  requireSingleReviewedDockerfileRunCommand,
} from "../../helpers/dockerfile-run-commands";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
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
const reviewedNpmArchivePath = "/tmp/npm-12.0.2.tgz";
const reviewedNpmUpgradeArguments = [
  ...npmRootArguments,
  "--archive",
  reviewedNpmArchivePath,
] as const;
const hermesReviewedNpmArchivePath = "/scripts/npm-12.0.2.tgz";
const hermesReviewedNpmUpgradeArguments = [
  ...npmRootArguments,
  "--archive",
  hermesReviewedNpmArchivePath,
] as const;
const hermesFinalArchivePath = "/scripts/nemoclaw-bundled-npm-tar.tgz";
const hermesFinalPatchArguments = [
  ...npmRootArguments,
  "--archive",
  hermesFinalArchivePath,
] as const;
const pinnedBaseDockerfiles = [
  "Dockerfile.base",
  "agents/hermes/Dockerfile.base",
  "agents/langchain-deepagents-code/Dockerfile.base",
  "agents/pi/Dockerfile.base",
] as const;
const REVIEWED_NODE_BASE =
  "node:24.18.1-trixie-slim@sha256:ac39e4b5fcb2b1b34b20364fd58b2e898f3bb80731ee6f62a7536f9df3d6aadc";
const reviewedNodeBases = new Set<string>([REVIEWED_NODE_BASE]);
const directNodeDockerfiles = [
  "Dockerfile",
  "Dockerfile.base",
  "agents/hermes/Dockerfile",
  "agents/hermes/Dockerfile.base",
  "agents/langchain-deepagents-code/Dockerfile",
  "agents/langchain-deepagents-code/Dockerfile.base",
  "agents/pi/Dockerfile",
  "agents/pi/Dockerfile.base",
] as const;
const npmHelperInvocationMarkers = [
  /\/opt\/nemoclaw-build-tools\/npm-ci-locked\.sh/gu,
  /node --experimental-strip-types \/opt\/[^\s]*reviewed-npm-archive\.mts/gu,
  /node --experimental-strip-types \/opt\/[^\s]*seed-reviewed-npm-cache\.mts/gu,
] as const;

interface DirectNodeStage {
  readonly file: string;
  readonly name: string;
  readonly source: string;
}

function directNodeStages(file: string, source: string): DirectNodeStage[] {
  const starts = [...source.matchAll(/^FROM\s+([^\s]+)(?:\s+AS\s+(\S+))?$/gmu)];
  return starts.flatMap((match, index) =>
    match[1]!.startsWith("node:24.18.1-") || match[1] === "npm12"
      ? [
          {
            file,
            name: match[2] ?? "<final>",
            source: source.slice(match.index, starts[index + 1]?.index ?? source.length),
          },
        ]
      : [],
  );
}

function firstNpmInvocation(stage: DirectNodeStage): number {
  const commandPositions = ["npm", "npx"].flatMap((command) =>
    dockerfileRunCommandPositions(stage.source, command),
  );
  const helperPositions = npmHelperInvocationMarkers.flatMap((marker) =>
    [...stage.source.matchAll(marker)].map((match) => match.index!),
  );
  return Math.min(...commandPositions, ...helperPositions, Number.POSITIVE_INFINITY);
}

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
    expect([...observedBases]).toEqual([REVIEWED_NODE_BASE]);
  });

  // source-shape-contract: security -- Each managed Dockerfile must remain bound to a reviewed Node base digest.
  it("rejects an isolated unreviewed Deep Agents Code Node base pin", () => {
    const file = "agents/langchain-deepagents-code/Dockerfile.base";
    const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
    const reviewedBase = REVIEWED_NODE_BASE;
    const unreviewedBase = `node:24.18.1-trixie-slim@sha256:${"0".repeat(64)}`;
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
      const patchCopy = patchInputStage.indexOf("scripts/patch-bundled-npm-tar.mts");
      const patchRuns = requireReviewedDockerfileRunCommands(
        source,
        patchCommand,
        file === "agents/hermes/Dockerfile" ? hermesFinalPatchArguments : npmRootArguments,
        entry.patchCount,
      );
      const firstPatchRun = patchRuns[0]!.commandStart;
      const lastPatchRun = patchRuns.at(-1)!.commandStart;
      const patchInputReady = patchPayloadLayer >= 0 ? patchPayloadLayer : patchCopy;

      const archiveCopy = `COPY tools/mcp-tool-discovery-runtime/npm-cache-seed/tar-${FIXED_TAR_VERSION}.tgz ${hermesFinalArchivePath}`;
      const archiveInputIndex = patchInputStage.indexOf(archiveCopy);
      const archiveReady = patchPayloadLayer >= 0 ? patchPayloadLayer : archiveInputIndex;
      expect({
        archiveBeforePatch: archiveInputIndex >= 0 && firstPatchRun > archiveReady,
        archivePresent: archiveInputIndex >= 0,
      }).toEqual(
        file === "agents/hermes/Dockerfile"
          ? { archiveBeforePatch: true, archivePresent: true }
          : { archiveBeforePatch: false, archivePresent: false },
      );

      expect(reviewedCopy, file).toBeGreaterThanOrEqual(0);
      expect(
        flattenedPatchInputStage.includes(
          "COPY scripts/lib/reviewed-npm-archive.mts scripts/lib/bundled-npm-package.mts",
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
    "Dockerfile",
    "agents/hermes/Dockerfile",
    "agents/langchain-deepagents-code/Dockerfile",
    "agents/pi/Dockerfile",
  ])("installs reviewed npm in the final $file stage from immutable local bytes", (file) => {
    const dockerfile = fs.readFileSync(path.join(repoRoot, file), "utf8");
    const archiveStage = namedStage(dockerfile, "reviewed-npm-archive");
    const source = completedStage(dockerfile);
    const portableOptions = file === "agents/hermes/Dockerfile" ? "" : "--chmod=0444 ";
    const archiveSource = `ADD ${portableOptions}--checksum=sha256:${REVIEWED_NPM_ARCHIVE_SHA256} ${REVIEWED_NPM_TARBALL} /npm-${REVIEWED_NPM_VERSION}.tgz`;
    const selectedArchivePath =
      file === "agents/hermes/Dockerfile"
        ? hermesReviewedNpmArchivePath
        : reviewedNpmArchivePath;
    const directArchiveCopy = `COPY --from=reviewed-npm-archive /npm-${REVIEWED_NPM_VERSION}.tgz ${selectedArchivePath}`;
    const archiveCopy =
      file === "agents/hermes/Dockerfile"
        ? "COPY --from=hermes-npm-patch-payload / /"
        : directArchiveCopy;
    const archiveCopyIndex = source.indexOf(archiveCopy);
    const upgradeRun = requireSingleReviewedDockerfileRunCommand(
      source,
      "node --experimental-strip-types /scripts/upgrade-bundled-npm.mts",
      file === "agents/hermes/Dockerfile"
        ? hermesReviewedNpmUpgradeArguments
        : reviewedNpmUpgradeArguments,
    ).commandStart;
    const firstPrivatePatch = source.indexOf(patchCommand);

    expect(archiveStage).toContain(archiveSource);
    expect(
      file !== "agents/hermes/Dockerfile" ||
        namedStage(dockerfile, "hermes-npm-patch-payload").includes(directArchiveCopy),
    ).toBe(true);
    expect(archiveCopyIndex, file).toBeGreaterThanOrEqual(0);
    expect(upgradeRun, file).toBeGreaterThan(archiveCopyIndex);
    expect(firstPrivatePatch, file).toBeGreaterThan(upgradeRun);
  });

  it("prepares the root npm build stage from the same immutable archive", () => {
    const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
    const npm12 = directNodeStages("Dockerfile", dockerfile).find(({ name }) => name === "npm12");
    assert(npm12, "Dockerfile must contain the npm12 stage");

    expect(npm12.source).toContain(
      `COPY --from=reviewed-npm-archive /npm-${REVIEWED_NPM_VERSION}.tgz ${reviewedNpmArchivePath}`,
    );
    const upgradeRun = requireSingleReviewedDockerfileRunCommand(
      npm12.source,
      "node --experimental-strip-types /scripts/upgrade-bundled-npm.mts",
      reviewedNpmUpgradeArguments,
    ).commandStart;
    const tarRun = requireSingleReviewedDockerfileRunCommand(
      npm12.source,
      patchCommand,
      npmRootArguments,
    ).commandStart;
    const braceRun = npm12.source.indexOf(
      "node --experimental-strip-types /scripts/patch-bundled-npm-brace-expansion.mts",
    );
    const ipAddressRun = npm12.source.indexOf(
      "node --experimental-strip-types /scripts/lib/patch-bundled-npm-ip-address.mts",
    );

    expect(upgradeRun).toBeGreaterThan(npm12.source.indexOf(reviewedNpmArchivePath));
    expect(tarRun).toBeGreaterThan(upgradeRun);
    expect(braceRun).toBeGreaterThan(tarRun);
    expect(ipAddressRun).toBeGreaterThan(braceRun);
  });

  // source-shape-contract: compatibility -- Hermes archive staging and adjacent runtime checks must share existing layers so the final image stays within the Docker import ceiling.
  it("keeps Hermes npm migration inputs and runtime finalization layer-bounded", () => {
    const dockerfile = fs.readFileSync(path.join(repoRoot, "agents/hermes/Dockerfile"), "utf8");
    const payload = namedStage(dockerfile, "hermes-npm-patch-payload");
    const npmUpgrade = requireSingleReviewedDockerfileRunCommand(
      completedStage(dockerfile),
      "node --experimental-strip-types /scripts/upgrade-bundled-npm.mts",
      hermesReviewedNpmUpgradeArguments,
    );
    const finalization = dockerfileInstructions(completedStage(dockerfile)).filter(
      ({ body, keyword }) => keyword === "RUN" && body.includes('hermes_path="$(command -v hermes'),
    );

    expect(payload).toContain(
      `COPY --from=reviewed-npm-archive /npm-${REVIEWED_NPM_VERSION}.tgz ${hermesReviewedNpmArchivePath}`,
    );
    expect(payload).toContain(
      `COPY tools/mcp-tool-discovery-runtime/npm-cache-seed/tar-${FIXED_TAR_VERSION}.tgz ${hermesFinalArchivePath}`,
    );
    expect(payload).not.toContain("/tmp/");
    expect(npmUpgrade.instruction.body).not.toContain("/tmp/");
    expect(finalization).toHaveLength(1);
    expect(
      [
        "chmod -R a+rX /opt/hermes/.venv",
        "hermes_web_dist=/opt/hermes/hermes_cli/web_dist",
        "apt-get autoremove --purge -y",
      ].every((marker) => finalization[0]!.body.includes(marker)),
    ).toBe(true);
  });

  // source-shape-contract: security -- Direct Node stages must upgrade reviewed npm before any npm-backed build boundary executes.
  it("upgrades and verifies reviewed npm before every direct Node stage npm boundary", () => {
    const rootDockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
    const stages = directNodeDockerfiles.flatMap((file) =>
      directNodeStages(file, fs.readFileSync(path.join(repoRoot, file), "utf8")),
    );
    const invokingStages = stages.filter((stage) => Number.isFinite(firstNpmInvocation(stage)));
    const upgrade = "node --experimental-strip-types /scripts/upgrade-bundled-npm.mts";

    expect(stages.map(({ file, name }) => `${file}:${name}`)).toEqual([
      "Dockerfile:npm12",
      "Dockerfile:builder",
      "Dockerfile:managed-bootstrap-entrypoint-builder",
      "Dockerfile:codex-acp-runtime",
      "Dockerfile:wechat-npm-cache",
      "Dockerfile:openclaw-managed-messaging-npm-cache-0",
      "Dockerfile:openclaw-managed-messaging-npm-cache-1",
      "Dockerfile.base:native-security-builder",
      "Dockerfile.base:<final>",
      "agents/hermes/Dockerfile:managed-bootstrap-entrypoint-builder",
      "agents/hermes/Dockerfile.base:native-security-builder",
      "agents/hermes/Dockerfile.base:<final>",
      "agents/langchain-deepagents-code/Dockerfile:managed-bootstrap-entrypoint-builder",
      "agents/langchain-deepagents-code/Dockerfile.base:native-security-builder",
      "agents/langchain-deepagents-code/Dockerfile.base:<final>",
      "agents/pi/Dockerfile:managed-bootstrap-entrypoint-builder",
      "agents/pi/Dockerfile.base:native-security-builder",
      "agents/pi/Dockerfile.base:<final>",
    ]);
    expect(
      rootDockerfile.match(
        /^COPY scripts\/lib\/seed-reviewed-npm-cache[.]mts \/scripts\/lib\/seed-reviewed-npm-cache[.]mts$/gmu,
      ),
    ).toHaveLength(2);
    expect(
      rootDockerfile.match(
        /^COPY scripts\/checks\/materialize-locked-npm-cache-seed[.]mts \/scripts\/checks\/materialize-locked-npm-cache-seed[.]mts$/gmu,
      ),
    ).toHaveLength(2);
    expect(
      rootDockerfile.match(
        /node --experimental-strip-types \/scripts\/lib\/seed-reviewed-npm-cache[.]mts/gmu,
      ),
    ).toHaveLength(3);
    expect(rootDockerfile).toContain(
      "node --experimental-strip-types /scripts/lib/reviewed-npm-archive.mts",
    );
    expect(rootDockerfile).not.toContain("/opt/nemoclaw-build-tools/seed-reviewed-npm-cache.mts");
    expect(rootDockerfile).not.toContain(
      "/opt/nemoclaw-build-tools/lib/seed-reviewed-npm-cache.mts",
    );
    expect(invokingStages.map(({ file, name }) => `${file}:${name}`)).toEqual([
      "Dockerfile:builder",
      "Dockerfile:codex-acp-runtime",
      "Dockerfile:wechat-npm-cache",
      "Dockerfile:openclaw-managed-messaging-npm-cache-1",
      "Dockerfile.base:<final>",
      "agents/hermes/Dockerfile.base:<final>",
      "agents/pi/Dockerfile.base:<final>",
    ]);
    expect(
      invokingStages.every((stage) => {
        const position = stage.source.indexOf(upgrade);
        return (
          (position >= 0 || stage.source.startsWith("FROM npm12 AS ")) &&
          position < firstNpmInvocation(stage)
        );
      }),
    ).toBe(true);
    expect(REVIEWED_NPM_VERSION).toBe("12.0.2");
  });

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
