#!/usr/bin/env -S node --experimental-strip-types

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { packReviewedNpmArchive } from "./lib/reviewed-npm-archive.mts";
import {
  commitStagedReplacementTransaction,
  discardStagedReplacements,
  type StagedReplacement,
  type StagedReplacementTransactionHook,
  stageDirectoryReplacement,
  stageFileReplacement,
} from "./lib/staged-replacement-transaction.mts";
import { patchReviewedOpenClawPluginAxiosRoot } from "./openclaw-plugin-axios-security-revision.mts";

type JsonObject = Record<string, any>;
type Pin = Readonly<{ integrity: string; name: string; tarball: string; version: string }>;
type DependencyOverride = Readonly<{ observed: string; published: string; target: string }>;
type DependencyOverrides = Readonly<Record<string, Readonly<Record<string, DependencyOverride>>>>;
type PluginReview = Readonly<{
  archiveIntegrity: string;
  archiveTarball: string;
  dependencyOverrides: DependencyOverrides;
  replacements: readonly string[];
}>;

const PINS: Readonly<Record<string, Pin>> = Object.freeze({
  "body-parser": {
    name: "body-parser",
    version: "2.3.0",
    integrity:
      "sha512-2cGmJupaNgg+QUwVLAucDuWuoMZ6EX9iHDRswZ5lsNYEmwPaRknMPCLZz07yTzVq/83p4o/wzbDZbBrTvGGTIw==",
    tarball: "https://registry.npmjs.org/body-parser/-/body-parser-2.3.0.tgz",
  },
  "content-type": {
    name: "content-type",
    version: "2.0.0",
    integrity:
      "sha512-j/O/d7GcZCyNl7/hwZAb606rzqkyvaDctLmckbxLzHvFBzTJHuGEdodATcP3yIRoDrLHkIATJuvzbFlp/ki2cQ==",
    tarball: "https://registry.npmjs.org/content-type/-/content-type-2.0.0.tgz",
  },
  "form-data": {
    name: "form-data",
    version: "2.5.6",
    integrity:
      "sha512-Ogz/E85h9tlfJzpI6TuFpGcHZFhLrb9Gw8wq9v40CxSCPnv7ahKr6Xgtkn0KYCDQJ8DNn5VoMO8EXr9V5PadyA==",
    tarball: "https://registry.npmjs.org/form-data/-/form-data-2.5.6.tgz",
  },
  qs: {
    name: "qs",
    version: "6.15.3",
    integrity:
      "sha512-O9gl3zCl5h5blw1KGUzQKhA5oUXSl8rwUIM5o0S3nCXMliSvy5Dzx7/DJcI+SwgICv+IneSZwhBh1oSyEHA71A==",
    tarball: "https://registry.npmjs.org/qs/-/qs-6.15.3.tgz",
  },
  undici: {
    name: "undici",
    version: "8.5.0",
    integrity:
      "sha512-xamtWoB1EshgjpmlXd7GGm2VfdDtw1+rD8uhry8pSNW3If6S8E0m2T2+orSKeZXEn/aPJMviCpDBA65WJt8zhg==",
    tarball: "https://registry.npmjs.org/undici/-/undici-8.5.0.tgz",
  },
  "protobufjs-7": {
    name: "protobufjs",
    version: "7.6.5",
    integrity:
      "sha512-/FPD0nUc9jH6rfFjji9IBqOz4pcSE3CsT1m7Ep6Mdb0LxSUMj8hgl6GomOvZzpNpAqqGaXA0P3VSrZLFzIhQrw==",
    tarball: "https://registry.npmjs.org/protobufjs/-/protobufjs-7.6.5.tgz",
  },
  "protobufjs-8": {
    name: "protobufjs",
    version: "8.7.1",
    integrity:
      "sha512-agdGHrXNTv0IrYscJPDou/PlEJk1c/hBZ9o/B5NH2i/nSPtPqacNxzgwf1CebXxFMjMrZH5sqv9uQuw96aGt/A==",
    tarball: "https://registry.npmjs.org/protobufjs/-/protobufjs-8.7.1.tgz",
  },
  ws: {
    name: "ws",
    version: "8.21.1",
    integrity:
      "sha512-+0NTnW77fFN/DjQi6k/Sq/Yvk4Sgajw7urW8V+asjXnRgDs9gyGkdb7EzgfhA4goXsRIZKE28fzIXBHEzhuiWw==",
    tarball: "https://registry.npmjs.org/ws/-/ws-8.21.1.tgz",
  },
});

const HTTP_REPLACEMENTS = ["body-parser", "content-type", "form-data", "qs"] as const;
const SLACK_REPLACEMENTS = [...HTTP_REPLACEMENTS, "ws"] as const;

function pluginReview(
  archiveIntegrity: string,
  archiveTarball: string,
  replacements: readonly string[],
  dependencyOverrides: DependencyOverrides = {},
): PluginReview {
  return { archiveIntegrity, archiveTarball, dependencyOverrides, replacements };
}

function httpDependencyOverrides(hasownVersion: "2.0.3" | "2.0.4"): DependencyOverrides {
  return {
    express: {
      "content-type": { observed: "1.0.5", published: "^1.0.5", target: "2.0.0" },
    },
    "form-data": {
      hasown: { observed: hasownVersion, published: "^2.0.4", target: hasownVersion },
      "mime-types": { observed: "3.0.2", published: "^2.1.35", target: "3.0.2" },
    },
    qs: {
      "side-channel": { observed: "1.1.0", published: "^1.1.1", target: "1.1.0" },
    },
  };
}

const REVIEWED_PLUGINS: Readonly<Record<string, PluginReview>> = Object.freeze({
  "@openclaw/slack@2026.5.22": pluginReview(
    "sha512-KEy2Ct9ydjV1gFE7GWaOexnYsRWnOTtBqhYuKSE/sTnbu3guyz67L7yJxIXD8t9qh8m+ChdPpNZ1Lz+1iMpPjg==",
    "https://registry.npmjs.org/@openclaw/slack/-/slack-2026.5.22.tgz",
    SLACK_REPLACEMENTS,
    httpDependencyOverrides("2.0.3"),
  ),
  "@openclaw/msteams@2026.5.22": pluginReview(
    "sha512-yiO8SXS77RSgKV8cG66TZS7m9ZneabN9toYN+EqmqJUf3NlADNVzLVEZTwFKDovg6eP7E8ihj2b0bJjOrb+ovA==",
    "https://registry.npmjs.org/@openclaw/msteams/-/msteams-2026.5.22.tgz",
    HTTP_REPLACEMENTS,
    httpDependencyOverrides("2.0.3"),
  ),
  "@openclaw/slack@2026.5.27": pluginReview(
    "sha512-A4SGrW52uLEVDEFqxXyLQGY+q0yc2I6IQ992HdumVGu3Cw1yc6g2P4D612paMORjOKe+TSk7/5KMUGqRbtCzpA==",
    "https://registry.npmjs.org/@openclaw/slack/-/slack-2026.5.27.tgz",
    SLACK_REPLACEMENTS,
    httpDependencyOverrides("2.0.3"),
  ),
  "@openclaw/msteams@2026.5.27": pluginReview(
    "sha512-zKMIt/7Y0JmuYOFIgG1uzXw24Y+jWoRntS7v7WnOArbT7jp5v3ld1/bfuzd195viHd5ViJZ7SftR6VUG/HvVzQ==",
    "https://registry.npmjs.org/@openclaw/msteams/-/msteams-2026.5.27.tgz",
    HTTP_REPLACEMENTS,
    httpDependencyOverrides("2.0.3"),
  ),
  "@openclaw/slack@2026.6.10": pluginReview(
    "sha512-OOsMLjPcbWhQRM5XDwfdrACjJmKqavFtpuIlhHAXWrLrd/p7SyIVE9AoKS0yxOx6bqGDIMJ9+knzdViHMLgBdA==",
    "https://registry.npmjs.org/@openclaw/slack/-/slack-2026.6.10.tgz",
    SLACK_REPLACEMENTS,
    httpDependencyOverrides("2.0.4"),
  ),
  "@openclaw/msteams@2026.6.10": pluginReview(
    "sha512-GjHnCPvjbnI0C7mEFcdT2uKDH4/WwOe2dZBfQiWxBtkE76m6TNG0J9dJjD4mc8/pk8rXSO0cWw+KV9jzWtF9VA==",
    "https://registry.npmjs.org/@openclaw/msteams/-/msteams-2026.6.10.tgz",
    HTTP_REPLACEMENTS,
    httpDependencyOverrides("2.0.4"),
  ),
  "@openclaw/discord@2026.5.22": pluginReview(
    "sha512-Kgvnx/jcNmgKmULO7IonCX/IiXGkYbtf8EYcthVi/TeV7iT7OS08y3Jauv+PvWY+vtrfUZ+79fPMSgIKLisdkw==",
    "https://registry.npmjs.org/@openclaw/discord/-/discord-2026.5.22.tgz",
    ["undici", "ws"],
  ),
  "@openclaw/discord@2026.5.27": pluginReview(
    "sha512-7iDvLnAuu3/aTX5NtP9kGPAm/BiRRz3lf08aIzsNU0qE3rI6eLPOH0z89O2YsRFFRBh+kXlrKjtUM9zTBaUIQg==",
    "https://registry.npmjs.org/@openclaw/discord/-/discord-2026.5.27.tgz",
    ["undici", "ws"],
  ),
  "@openclaw/discord@2026.6.10": pluginReview(
    "sha512-NKp/j00l+rk5PC0Lv/0fOIiiQJ1c/OpG9471zqXUDKQie6pQ1Fi9KUZUouyoTMmfLh/n4S0CkEMqrON40eBKXA==",
    "https://registry.npmjs.org/@openclaw/discord/-/discord-2026.6.10.tgz",
    ["undici", "ws"],
  ),
  "@openclaw/diagnostics-otel@2026.5.22": pluginReview(
    "sha512-MZAdSDjHhkAjGGzpI5mL6+LB0o9ZIDaSO+gXgudL6X5DzHFMkKocjghxOkHU1NThBbqGzSBLzBzTM3K1ekq+Cg==",
    "https://registry.npmjs.org/@openclaw/diagnostics-otel/-/diagnostics-otel-2026.5.22.tgz",
    ["protobufjs-8"],
  ),
  "@openclaw/diagnostics-otel@2026.5.27": pluginReview(
    "sha512-YvucuB5qVGrY0rDQEHVNR8LJWXROhu+AUWqTcWcIVTrbOo834KFWtBmxXxuYvQH7Dbhm66cgbBOHZ3TyOHldWA==",
    "https://registry.npmjs.org/@openclaw/diagnostics-otel/-/diagnostics-otel-2026.5.27.tgz",
    ["protobufjs-8"],
  ),
  "@openclaw/diagnostics-otel@2026.6.10": pluginReview(
    "sha512-EJt0fjk4bcR3N/9u00f1pL0BJYG5yfC09DV3l6rWDmytpE2vUeBZWpx4pOmFDreGV+7DKxhCbQDgDAmvZGjLag==",
    "https://registry.npmjs.org/@openclaw/diagnostics-otel/-/diagnostics-otel-2026.6.10.tgz",
    ["protobufjs-7"],
  ),
  "@openclaw/whatsapp@2026.5.22": pluginReview(
    "sha512-hCga/55Iq1NwJ5dka7RQtvI3bPylXZ76/k3ngE9sNswA/GRUuhhYfr4u1YYPtzfx8aMo6JL5ccf5YA633w0bUg==",
    "https://registry.npmjs.org/@openclaw/whatsapp/-/whatsapp-2026.5.22.tgz",
    ["protobufjs-8", "ws"],
  ),
  "@openclaw/whatsapp@2026.5.27": pluginReview(
    "sha512-YK0LHyZunO3sQQ6KRZ1UvCQL1UA9K8hduclWSWBMt0dPaamiKSP+oXFEZ4e8gTeTRCZTOwaMPO7RdwguSm6lsA==",
    "https://registry.npmjs.org/@openclaw/whatsapp/-/whatsapp-2026.5.27.tgz",
    ["protobufjs-8"],
  ),
  "@openclaw/whatsapp@2026.6.10": pluginReview(
    "sha512-k/XrRdZY77SHrdaRwJOEB7/JRbjp4yVgGD/ZNyakjTMqo32XRVtwPBUnj7726rW8Kl5yyOMQQLKFiD9MDfhmPQ==",
    "https://registry.npmjs.org/@openclaw/whatsapp/-/whatsapp-2026.6.10.tgz",
    ["protobufjs-7"],
  ),
});

const REVIEWED_TREE_PROBLEMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "@openclaw/slack@2026.5.22": [
    "missing: @types/express@^5.0.0, required by @slack/bolt@4.7.2",
    "invalid: form-data@2.5.6 <plugin-root>/node_modules/form-data",
  ],
  "@openclaw/msteams@2026.5.22": [
    "invalid: uuid@14.0.0 <plugin-root>/node_modules/uuid",
    "invalid: form-data@2.5.6 <plugin-root>/node_modules/form-data",
  ],
  "@openclaw/slack@2026.5.27": [
    "missing: @types/express@^5.0.0, required by @slack/bolt@4.7.2",
    "invalid: form-data@2.5.6 <plugin-root>/node_modules/form-data",
  ],
  "@openclaw/msteams@2026.5.27": [
    "invalid: uuid@14.0.0 <plugin-root>/node_modules/uuid",
    "invalid: form-data@2.5.6 <plugin-root>/node_modules/form-data",
  ],
  "@openclaw/slack@2026.6.10": [
    "missing: @types/express@^5.0.0, required by @slack/bolt@4.7.3",
    "invalid: @types/retry@0.12.5 <plugin-root>/node_modules/@types/retry",
    "invalid: form-data@2.5.6 <plugin-root>/node_modules/form-data",
  ],
  "@openclaw/msteams@2026.6.10": [
    "invalid: uuid@14.0.0 <plugin-root>/node_modules/uuid",
    "invalid: form-data@2.5.6 <plugin-root>/node_modules/form-data",
  ],
  "@openclaw/discord@2026.5.22": [
    "invalid: opusscript@0.1.1 <plugin-root>/node_modules/opusscript",
    "missing: @emnapi/core@^1.7.1, required by @napi-rs/wasm-runtime@1.1.4",
    "missing: @emnapi/runtime@^1.7.1, required by @napi-rs/wasm-runtime@1.1.4",
  ],
  "@openclaw/discord@2026.5.27": [
    "missing: @emnapi/core@^1.7.1, required by @napi-rs/wasm-runtime@1.1.4",
    "missing: @emnapi/runtime@^1.7.1, required by @napi-rs/wasm-runtime@1.1.4",
  ],
  "@openclaw/discord@2026.6.10": [
    "missing: @emnapi/core@^1.7.1, required by @napi-rs/wasm-runtime@1.1.4",
    "missing: @emnapi/runtime@^1.7.1, required by @napi-rs/wasm-runtime@1.1.4",
  ],
  "@openclaw/diagnostics-otel@2026.5.22": [
    "invalid: protobufjs@8.7.1 <plugin-root>/node_modules/protobufjs",
  ],
  "@openclaw/diagnostics-otel@2026.5.27": [
    "invalid: protobufjs@8.7.1 <plugin-root>/node_modules/protobufjs",
  ],
  "@openclaw/diagnostics-otel@2026.6.10": [],
  "@openclaw/whatsapp@2026.5.22": [
    "invalid: protobufjs@8.7.1 <plugin-root>/node_modules/protobufjs",
    "missing: sharp@*, required by baileys@7.0.0-rc13",
    "invalid: file-type@22.0.1 <plugin-root>/node_modules/file-type",
  ],
  "@openclaw/whatsapp@2026.5.27": [
    "invalid: protobufjs@8.7.1 <plugin-root>/node_modules/protobufjs",
    "missing: sharp@*, required by baileys@7.0.0-rc13",
    "invalid: file-type@22.0.1 <plugin-root>/node_modules/file-type",
  ],
  "@openclaw/whatsapp@2026.6.10": [
    "missing: sharp@*, required by baileys@7.0.0-rc13",
    "invalid: file-type@22.0.1 <plugin-root>/node_modules/file-type",
  ],
});

function dependencies(manifest: JsonObject, label: string): JsonObject {
  const value = manifest.dependencies;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must declare dependencies`);
  }
  return value;
}

function normalizedTreeProblems(pluginRoot: string, problems: unknown): string[] {
  if (!Array.isArray(problems) || problems.some((problem) => typeof problem !== "string")) {
    throw new Error("OpenClaw plugin npm tree problems must be a string array");
  }
  const resolvedRoot = path.resolve(pluginRoot);
  return (problems as string[])
    .map((problem) => problem.replaceAll(resolvedRoot, "<plugin-root>"))
    .sort();
}

export function assertReviewedOpenClawPluginTreeReport(options: {
  expectedSpec: string;
  pluginRoot: string;
  report: JsonObject;
  status: number;
}): void {
  const expected = REVIEWED_TREE_PROBLEMS[options.expectedSpec];
  if (!expected) throw new Error(`${options.expectedSpec} has no reviewed npm tree baseline`);
  const manifest = readJson(path.join(path.resolve(options.pluginRoot), "package.json"));
  if (packageSpec(manifest) !== options.expectedSpec) {
    throw new Error(`${options.expectedSpec} npm tree package identity changed`);
  }
  const problems = normalizedTreeProblems(options.pluginRoot, options.report.problems ?? []);
  const reviewed = [...expected].sort();
  if (
    !Number.isInteger(options.status) ||
    options.status < 0 ||
    options.status > 1 ||
    (options.status === 0) !== (problems.length === 0) ||
    JSON.stringify(problems) !== JSON.stringify(reviewed)
  ) {
    throw new Error(
      `${options.expectedSpec} npm tree differs from the reviewed baseline: ${JSON.stringify({
        status: options.status,
        problems,
        reviewed,
      })}`,
    );
  }
}

export function verifyReviewedOpenClawPluginTree(pluginRoot: string, expectedSpec: string): void {
  const resolvedRoot = path.resolve(pluginRoot);
  requireRealDirectory(resolvedRoot, `${expectedSpec} npm tree root`);
  const result = spawnSync("npm", ["ls", "--omit=dev", "--all", "--json"], {
    cwd: resolvedRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  let report: JsonObject;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${expectedSpec} npm tree output was not JSON: ${String(error)}`);
  }
  assertReviewedOpenClawPluginTreeReport({
    expectedSpec,
    pluginRoot: resolvedRoot,
    report,
    status: result.status ?? 2,
  });
}

function readJson(file: string): JsonObject {
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new Error(`${file} must be a regular file`);
    }
    const parsed = JSON.parse(readFileSync(descriptor, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${file} must contain a JSON object`);
    }
    return parsed as JsonObject;
  } finally {
    closeSync(descriptor);
  }
}

function jsonContents(value: JsonObject): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function requireRealDirectory(directory: string, label: string): void {
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${directory}`);
  }
}

function requireDescendantPath(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`OpenClaw plugin candidate must be a descendant of ${root}: ${candidate}`);
  }
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (!existsSync(current)) break;
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink()) {
      throw new Error(`OpenClaw plugin candidate path contains a symbolic link: ${current}`);
    }
    if (current !== candidate && !metadata.isDirectory()) {
      throw new Error(`OpenClaw plugin candidate parent must be a directory: ${current}`);
    }
  }
}

function rejectUnsafeTree(directory: string, label: string): void {
  requireRealDirectory(directory, label);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) rejectUnsafeTree(child, label);
    else if (!entry.isFile()) throw new Error(`${label} contains an unsafe member: ${child}`);
  }
}

type ContentEntry = Readonly<{ digest: string; mode: number; path: string }>;

function contentSnapshot(directory: string, label: string): ContentEntry[] {
  rejectUnsafeTree(directory, label);
  const entries: ContentEntry[] = [];
  const visit = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      if (name.includes("\n") || name.includes("\r") || name.includes("\\")) {
        throw new Error(`${label} contains an unsafe name: ${name}`);
      }
      const child = path.join(current, name);
      const metadata = lstatSync(child);
      if (metadata.isDirectory()) {
        visit(child);
      } else if (metadata.isFile()) {
        const descriptor = openSync(child, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const openedMetadata = fstatSync(descriptor);
          if (!openedMetadata.isFile()) {
            throw new Error(`${label} contains an unsafe member: ${child}`);
          }
          entries.push({
            digest: createHash("sha512").update(readFileSync(descriptor)).digest("base64"),
            mode: openedMetadata.mode & 0o777,
            path: path.relative(directory, child),
          });
        } finally {
          closeSync(descriptor);
        }
      }
    }
  };
  visit(directory);
  return entries;
}

function changedPackedContentEntries(source: ContentEntry[], packed: ContentEntry[]): string[] {
  const sourceByPath = new Map(source.map((entry) => [entry.path, entry]));
  return packed
    .flatMap((packedEntry) => {
      const sourceEntry = sourceByPath.get(packedEntry.path);
      if (!sourceEntry) return [`${packedEntry.path}: added during packing`];
      if (sourceEntry.digest !== packedEntry.digest) {
        return [`${packedEntry.path}: contents changed during packing`];
      }
      if (sourceEntry.mode !== packedEntry.mode) {
        return [
          `${packedEntry.path}: mode changed during packing (${sourceEntry.mode.toString(8)} -> ${packedEntry.mode.toString(8)})`,
        ];
      }
      return [];
    })
    .slice(0, 20);
}

function packageSpec(manifest: JsonObject): string {
  return `${String(manifest.name)}@${String(manifest.version)}`;
}

function replacementDirectory(replacementRoot: string, replacementKey: string): string {
  const directory = path.join(replacementRoot, replacementKey);
  rejectUnsafeTree(directory, `reviewed ${replacementKey} replacement`);
  const pin = PINS[replacementKey];
  const manifest = readJson(path.join(directory, "package.json"));
  if (!pin || manifest.name !== pin.name || manifest.version !== pin.version) {
    throw new Error(`reviewed ${replacementKey} replacement identity changed`);
  }
  return directory;
}

function observedVersions(replacementKey: string): readonly string[] {
  if (replacementKey === "body-parser") return ["2.2.2", "2.3.0"];
  if (replacementKey === "content-type") return ["1.0.5", "2.0.0"];
  if (replacementKey === "form-data") return ["2.5.4", "2.5.6"];
  if (replacementKey === "qs") return ["6.14.2", "6.15.2", "6.15.3"];
  if (replacementKey === "undici") return ["8.3.0", "8.5.0"];
  if (replacementKey === "protobufjs-7") return ["7.6.3", "7.6.5"];
  if (replacementKey === "protobufjs-8") return ["8.4.0", "8.7.1"];
  if (replacementKey === "ws") return ["8.20.1", "8.21.0", "8.21.1"];
  return [];
}

function lockEntry(pin: Pin, manifest: JsonObject): JsonObject {
  const entry: JsonObject = {
    version: pin.version,
    resolved: pin.tarball,
    integrity: pin.integrity,
    license: manifest.license,
  };
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "peerDependenciesMeta",
    "engines",
    "bin",
  ] as const) {
    if (manifest[field] !== undefined) entry[field] = structuredClone(manifest[field]);
  }
  return entry;
}

export function patchReviewedOpenClawPluginRoot(
  pluginRoot: string,
  replacementRoot: string,
  options: { injectFailure?: StagedReplacementTransactionHook } = {},
): string | null {
  requireRealDirectory(pluginRoot, "installed OpenClaw plugin");
  const manifestPath = path.join(pluginRoot, "package.json");
  const manifest = readJson(manifestPath);
  const spec = packageSpec(manifest);
  const review = REVIEWED_PLUGINS[spec];
  if (!review) return null;
  const shrinkwrapPath = path.join(pluginRoot, "npm-shrinkwrap.json");
  const shrinkwrap = readJson(shrinkwrapPath);
  if (shrinkwrap.lockfileVersion !== 3 || !shrinkwrap.packages?.[""]) {
    throw new Error(`${spec} must ship an npm lockfileVersion 3 shrinkwrap`);
  }
  const root = shrinkwrap.packages[""] as JsonObject;
  const bundled = new Set<string>([
    ...(Array.isArray(manifest.bundledDependencies) ? manifest.bundledDependencies : []),
    ...(Array.isArray(root.bundleDependencies) ? root.bundleDependencies : []),
  ]);

  const packages = shrinkwrap.packages as JsonObject;
  const planned = review.replacements.map((replacementKey) => {
    const pin = PINS[replacementKey];
    if (!pin) throw new Error(`${spec} uses an unknown reviewed replacement: ${replacementKey}`);
    const installedRoot = path.join(pluginRoot, "node_modules", pin.name);
    requireRealDirectory(installedRoot, `${spec} installed ${pin.name}`);
    const installed = readJson(path.join(installedRoot, "package.json"));
    if (
      installed.name !== pin.name ||
      !observedVersions(replacementKey).includes(installed.version)
    ) {
      throw new Error(`${spec} has unexpected installed ${pin.name}@${String(installed.version)}`);
    }
    const replacement = replacementDirectory(replacementRoot, replacementKey);
    const replacementManifest = readJson(path.join(replacement, "package.json"));
    return { installedRoot, pin, replacement, replacementKey, replacementManifest };
  });
  const plannedByName = new Map(planned.map((replacement) => [replacement.pin.name, replacement]));
  const installedOwnerReplacements: Array<{
    contents: string;
    manifestPath: string;
    ownerName: string;
  }> = [];

  for (const [ownerName, overrides] of Object.entries(review.dependencyOverrides)) {
    const plannedOwner = plannedByName.get(ownerName);
    const ownerRoot = plannedOwner
      ? plannedOwner.replacement
      : path.join(pluginRoot, "node_modules", ownerName);
    requireRealDirectory(ownerRoot, `${spec} compatibility owner ${ownerName}`);
    const ownerManifestPath = path.join(ownerRoot, "package.json");
    const ownerManifest = plannedOwner
      ? plannedOwner.replacementManifest
      : readJson(ownerManifestPath);
    const ownerDependencies = dependencies(ownerManifest, `${spec} ${ownerName} manifest`);
    const ownerLock = packages[`node_modules/${ownerName}`] as JsonObject | undefined;
    if (!ownerLock || typeof ownerLock !== "object" || Array.isArray(ownerLock)) {
      throw new Error(`${spec} shrinkwrap is missing ${ownerName}`);
    }
    const ownerLockDependencies = plannedOwner
      ? undefined
      : dependencies(ownerLock, `${spec} ${ownerName} shrinkwrap entry`);
    for (const [dependencyName, override] of Object.entries(overrides)) {
      if (ownerDependencies[dependencyName] !== override.published) {
        throw new Error(
          `${spec} ${ownerName} ${dependencyName} dependency does not match the review`,
        );
      }
      if (ownerLockDependencies && ownerLockDependencies[dependencyName] !== override.published) {
        throw new Error(
          `${spec} ${ownerName} ${dependencyName} shrinkwrap dependency does not match the review`,
        );
      }
      const installedDependencyRoot = path.join(pluginRoot, "node_modules", dependencyName);
      requireRealDirectory(
        installedDependencyRoot,
        `${spec} compatibility dependency ${dependencyName}`,
      );
      const installedDependency = readJson(path.join(installedDependencyRoot, "package.json"));
      if (
        installedDependency.name !== dependencyName ||
        installedDependency.version !== override.observed
      ) {
        throw new Error(`${spec} ${dependencyName} compatibility state does not match the review`);
      }
      const replacementDependency = plannedByName.get(dependencyName);
      const retainedVersion = replacementDependency?.pin.version ?? override.observed;
      if (override.target !== retainedVersion) {
        throw new Error(`${spec} ${dependencyName} compatibility target is inconsistent`);
      }
      ownerDependencies[dependencyName] = override.target;
      if (ownerLockDependencies) ownerLockDependencies[dependencyName] = override.target;
    }
    if (!plannedOwner) {
      installedOwnerReplacements.push({
        contents: jsonContents(ownerManifest),
        manifestPath: ownerManifestPath,
        ownerName,
      });
    }
  }

  for (const { pin, replacementManifest } of planned) {
    manifest.dependencies = { ...manifest.dependencies, [pin.name]: pin.version };
    root.dependencies = { ...root.dependencies, [pin.name]: pin.version };
    bundled.add(pin.name);
    packages[`node_modules/${pin.name}`] = lockEntry(pin, replacementManifest);
  }
  manifest.bundledDependencies = [...bundled].sort();
  root.bundleDependencies = [...bundled].sort();
  const manifestReplacement = jsonContents(manifest);
  const shrinkwrapReplacement = jsonContents(shrinkwrap);
  const staged: StagedReplacement[] = [];
  try {
    for (const { installedRoot, pin, replacement, replacementManifest } of planned) {
      const stagedDependency = stageDirectoryReplacement({
        label: `${spec} ${pin.name} dependency`,
        livePath: installedRoot,
        sourcePath: replacement,
      });
      writeFileSync(
        path.join(stagedDependency.stagedPath, "package.json"),
        jsonContents(replacementManifest),
      );
      staged.push(stagedDependency);
    }
    for (const owner of installedOwnerReplacements) {
      staged.push(
        stageFileReplacement({
          contents: owner.contents,
          label: `${spec} ${owner.ownerName} compatibility manifest`,
          livePath: owner.manifestPath,
        }),
      );
    }
    staged.push(
      stageFileReplacement({
        contents: manifestReplacement,
        label: `${spec} package manifest`,
        livePath: manifestPath,
      }),
      stageFileReplacement({
        contents: shrinkwrapReplacement,
        label: `${spec} npm shrinkwrap`,
        livePath: shrinkwrapPath,
      }),
    );
    commitStagedReplacementTransaction({
      injectFailure: options.injectFailure,
      replacements: staged,
      verify: () => {
        if (readFileSync(manifestPath, "utf8") !== manifestReplacement) {
          throw new Error(`${spec} package manifest remediation did not commit exactly`);
        }
        if (readFileSync(shrinkwrapPath, "utf8") !== shrinkwrapReplacement) {
          throw new Error(`${spec} npm shrinkwrap remediation did not commit exactly`);
        }
        for (const { installedRoot, pin } of planned) {
          rejectUnsafeTree(installedRoot, `${spec} installed ${pin.name}`);
          const installed = readJson(path.join(installedRoot, "package.json"));
          if (installed.name !== pin.name || installed.version !== pin.version) {
            throw new Error(`${spec} did not retain the reviewed ${pin.name} remediation`);
          }
        }
        const committedShrinkwrap = readJson(shrinkwrapPath);
        for (const [ownerName, overrides] of Object.entries(review.dependencyOverrides)) {
          const ownerManifest = readJson(
            path.join(pluginRoot, "node_modules", ownerName, "package.json"),
          );
          const ownerDependencies = dependencies(
            ownerManifest,
            `${spec} committed ${ownerName} manifest`,
          );
          const ownerLock = committedShrinkwrap.packages?.[`node_modules/${ownerName}`];
          const ownerLockDependencies = dependencies(
            ownerLock,
            `${spec} committed ${ownerName} shrinkwrap entry`,
          );
          for (const [dependencyName, override] of Object.entries(overrides)) {
            if (
              ownerDependencies[dependencyName] !== override.target ||
              ownerLockDependencies[dependencyName] !== override.target
            ) {
              throw new Error(
                `${spec} did not retain the reviewed ${ownerName} ${dependencyName} compatibility metadata`,
              );
            }
            const dependency = readJson(
              path.join(pluginRoot, "node_modules", dependencyName, "package.json"),
            );
            if (dependency.version !== override.target) {
              throw new Error(
                `${spec} did not retain the reviewed ${dependencyName} compatibility package`,
              );
            }
          }
        }
      },
    });
  } catch (error) {
    discardStagedReplacements(staged);
    throw error;
  }
  return spec;
}

function installedPluginCandidates(stateDirectory: string): string[] {
  const openClawRoot = path.resolve(stateDirectory);
  requireRealDirectory(openClawRoot, "OpenClaw state directory");
  const names = ["slack", "msteams", "diagnostics-otel", "whatsapp", "discord"];
  const candidates = names.flatMap((name) => [
    path.join(openClawRoot, "extensions", name),
    path.join(openClawRoot, "npm", "node_modules", "@openclaw", name),
  ]);
  const projectsRoot = path.join(openClawRoot, "npm", "projects");
  if (existsSync(projectsRoot)) {
    requireDescendantPath(openClawRoot, projectsRoot);
    requireRealDirectory(projectsRoot, "OpenClaw npm projects root");
    for (const project of readdirSync(projectsRoot, { withFileTypes: true })) {
      if (!project.isDirectory() || project.isSymbolicLink()) {
        throw new Error(`OpenClaw npm projects root contains an unsafe entry: ${project.name}`);
      }
      for (const name of names) {
        candidates.push(path.join(projectsRoot, project.name, "node_modules", "@openclaw", name));
      }
    }
  }
  for (const candidate of candidates) requireDescendantPath(openClawRoot, candidate);
  return candidates.filter((candidate) => existsSync(path.join(candidate, "package.json")));
}

export function patchInstalledOpenClawPluginCore(options: {
  expectedPackageSpec?: string;
  replacementRoot: string;
  stateDirectory: string;
}): string[] {
  const replacementRoot = path.resolve(options.replacementRoot);
  const patched = installedPluginCandidates(path.resolve(options.stateDirectory))
    .map((candidate) => patchReviewedOpenClawPluginRoot(candidate, replacementRoot))
    .filter((spec): spec is string => spec !== null);
  if (options.expectedPackageSpec && !patched.includes(options.expectedPackageSpec)) {
    throw new Error(
      `OpenClaw reported success but ${options.expectedPackageSpec} was not found in a reviewed install layout`,
    );
  }
  return patched;
}

function runTar(args: string[]): string {
  const result = spawnSync("tar", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`tar ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function safeArchiveMembers(archivePath: string): string[] {
  const resolved = path.resolve(archivePath);
  const members = runTar(["-tzf", resolved]).split("\n").filter(Boolean);
  const entryTypes = runTar(["-tvzf", resolved])
    .split("\n")
    .filter(Boolean)
    .map((entry) => entry[0]);
  if (
    !members.includes("package/package.json") ||
    entryTypes.length !== members.length ||
    entryTypes.some((type) => type !== "-" && type !== "d") ||
    members.some((member) => {
      const normalized = member.endsWith("/") ? member.slice(0, -1) : member;
      return (
        (normalized !== "package" && !normalized.startsWith("package/")) ||
        normalized.includes("\\") ||
        normalized.split("/").some((part) => part === "" || part === "." || part === "..")
      );
    })
  ) {
    throw new Error(`OpenClaw plugin archive has an unsafe member: ${resolved}`);
  }
  return members;
}

export function verifyRemediatedArchiveContents(
  packageRoot: string,
  archivePath: string,
  expectedSpec?: string,
): void {
  const resolvedPackageRoot = path.resolve(packageRoot);
  const resolvedArchive = path.resolve(archivePath);
  const source = contentSnapshot(resolvedPackageRoot, "remediated plugin source tree");
  safeArchiveMembers(resolvedArchive);
  const unpackedRoot = mkdtempSync(
    path.join(path.dirname(resolvedArchive), "nemoclaw-remediated-verify-"),
  );
  try {
    runTar([
      "-xzf",
      resolvedArchive,
      "--strip-components=1",
      "--no-same-owner",
      "-C",
      unpackedRoot,
    ]);
    const packed = contentSnapshot(unpackedRoot, "remediated plugin archive tree");
    const changes = changedPackedContentEntries(source, packed);
    if (changes.length > 0) {
      throw new Error(
        `remediated plugin archive contents changed during packing: ${changes.join("; ")}`,
      );
    }
    if (expectedSpec) verifyReviewedOpenClawPluginTree(unpackedRoot, expectedSpec);
  } finally {
    rmSync(unpackedRoot, { recursive: true, force: true });
  }
}

function classifyArchive(archivePath: string): string {
  const resolved = path.resolve(archivePath);
  safeArchiveMembers(resolved);
  const manifest = JSON.parse(runTar(["-xOzf", resolved, "package/package.json"]));
  const spec = packageSpec(manifest);
  const reviewed = REVIEWED_PLUGINS[spec];
  if (!reviewed) return "";
  const observedIntegrity = `sha512-${createHash("sha512")
    .update(readFileSync(resolved))
    .digest("base64")}`;
  if (observedIntegrity !== reviewed.archiveIntegrity) {
    throw new Error(`${spec} archive integrity mismatch`);
  }
  return spec;
}

export function classifyReviewedPluginCoreInstallTarget(target: string): string {
  const normalized = target.startsWith("npm:") ? target.slice(4) : target;
  if (REVIEWED_PLUGINS[normalized]) return normalized;
  const archiveTarget = target.startsWith("npm-pack:") ? target.slice("npm-pack:".length) : target;
  return archiveTarget.endsWith(".tgz") && existsSync(archiveTarget)
    ? classifyArchive(archiveTarget)
    : "";
}

export function materializeReviewedPluginCoreInstallTarget(
  target: string,
  workingDirectory: string,
): string {
  const normalized = target.startsWith("npm:") ? target.slice(4) : target;
  const reviewed = REVIEWED_PLUGINS[normalized];
  if (reviewed) {
    const packed = packReviewedNpmArchive({
      expectedIntegrity: reviewed.archiveIntegrity,
      label: `historical OpenClaw plugin ${normalized}`,
      packageSpec: normalized,
      tarballUrl: reviewed.archiveTarball,
      tempDirectory: workingDirectory,
    });
    return `npm-pack:${packed.archivePath}`;
  }
  const localSpec = classifyReviewedPluginCoreInstallTarget(target);
  return localSpec && !target.startsWith("npm-pack:") ? `npm-pack:${path.resolve(target)}` : target;
}

export function materializeReviewedPluginSecurityRevision(options: {
  axiosReplacementRoot: string;
  replacementRoot: string;
  target: string;
  workingDirectory: string;
}): string {
  const expectedSpec = classifyReviewedPluginCoreInstallTarget(options.target);
  if (!expectedSpec) return options.target;

  const materializedTarget = materializeReviewedPluginCoreInstallTarget(
    options.target,
    options.workingDirectory,
  );
  if (!materializedTarget.startsWith("npm-pack:")) {
    throw new Error(`${expectedSpec} did not materialize as a reviewed npm archive`);
  }
  const sourceArchive = path.resolve(materializedTarget.slice("npm-pack:".length));
  if (classifyArchive(sourceArchive) !== expectedSpec) {
    throw new Error(`${expectedSpec} materialized archive identity changed`);
  }

  const packageRoot = mkdtempSync(
    path.join(path.resolve(options.workingDirectory), "nemoclaw-remediated-plugin-"),
  );
  runTar(["-xzf", sourceArchive, "--strip-components=1", "-C", packageRoot]);
  patchReviewedOpenClawPluginAxiosRoot(packageRoot, options.axiosReplacementRoot);
  if (patchReviewedOpenClawPluginRoot(packageRoot, options.replacementRoot) !== expectedSpec) {
    throw new Error(`${expectedSpec} remediated package identity changed`);
  }
  const pack = spawnSync(
    "npm",
    [
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      path.resolve(options.workingDirectory),
      packageRoot,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        NPM_CONFIG_CACHE: path.join(path.resolve(options.workingDirectory), "npm-cache"),
      },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  try {
    if (pack.error) throw pack.error;
    if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr}`);
    const report = JSON.parse(pack.stdout);
    if (!Array.isArray(report) || report.length !== 1 || typeof report[0]?.filename !== "string") {
      throw new Error("npm pack did not return one remediated plugin archive");
    }
    const remediatedArchive = path.join(path.resolve(options.workingDirectory), report[0].filename);
    const observedIntegrity = `sha512-${createHash("sha512")
      .update(readFileSync(remediatedArchive))
      .digest("base64")}`;
    if (report[0].integrity !== observedIntegrity) {
      throw new Error(`${expectedSpec} npm pack integrity report changed`);
    }
    verifyRemediatedArchiveContents(packageRoot, remediatedArchive, expectedSpec);
    const remediatedSpec = JSON.parse(runTar(["-xOzf", remediatedArchive, "package/package.json"]));
    if (packageSpec(remediatedSpec) !== expectedSpec) {
      throw new Error(`${expectedSpec} remediated archive identity changed`);
    }
    return `npm-pack:${remediatedArchive}`;
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
  }
}

function isMainModule(): boolean {
  return process.argv[1]
    ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
    : false;
}

if (isMainModule()) {
  const args = process.argv.slice(2);
  const value = (name: string): string => {
    const index = args.indexOf(name);
    const result = index >= 0 ? args[index + 1] : undefined;
    if (!result) throw new Error(`Missing ${name}`);
    return result;
  };
  try {
    if (args.includes("--patch-plugin-root")) {
      patchReviewedOpenClawPluginRoot(value("--patch-plugin-root"), value("--replacement-root"));
    } else if (args.includes("--verify-plugin-tree")) {
      verifyReviewedOpenClawPluginTree(value("--plugin-root"), value("--expected-package-spec"));
    } else if (args.includes("--classify-install-target")) {
      process.stdout.write(
        classifyReviewedPluginCoreInstallTarget(value("--classify-install-target")),
      );
    } else if (args.includes("--materialize-remediated-install-target")) {
      process.stdout.write(
        materializeReviewedPluginSecurityRevision({
          axiosReplacementRoot: value("--axios-replacement-root"),
          replacementRoot: value("--replacement-root"),
          target: value("--materialize-remediated-install-target"),
          workingDirectory: value("--working-directory"),
        }),
      );
    } else if (args.includes("--materialize-install-target")) {
      process.stdout.write(
        materializeReviewedPluginCoreInstallTarget(
          value("--materialize-install-target"),
          value("--working-directory"),
        ),
      );
    } else {
      patchInstalledOpenClawPluginCore({
        expectedPackageSpec: args.includes("--expected-package-spec")
          ? value("--expected-package-spec")
          : undefined,
        replacementRoot: value("--replacement-root"),
        stateDirectory: value("--state-directory"),
      });
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
