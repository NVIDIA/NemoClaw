#!/usr/bin/env -S node --experimental-strip-types

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { packReviewedNpmArchive } from "./lib/reviewed-npm-archive.mts";

type JsonObject = Record<string, any>;
type Pin = Readonly<{ integrity: string; name: string; tarball: string; version: string }>;
type PluginReview = Readonly<{
  archiveIntegrity: string;
  archiveTarball: string;
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
): PluginReview {
  return { archiveIntegrity, archiveTarball, replacements };
}

const REVIEWED_PLUGINS: Readonly<Record<string, PluginReview>> = Object.freeze({
  "@openclaw/slack@2026.5.22": pluginReview(
    "sha512-KEy2Ct9ydjV1gFE7GWaOexnYsRWnOTtBqhYuKSE/sTnbu3guyz67L7yJxIXD8t9qh8m+ChdPpNZ1Lz+1iMpPjg==",
    "https://registry.npmjs.org/@openclaw/slack/-/slack-2026.5.22.tgz",
    SLACK_REPLACEMENTS,
  ),
  "@openclaw/msteams@2026.5.22": pluginReview(
    "sha512-yiO8SXS77RSgKV8cG66TZS7m9ZneabN9toYN+EqmqJUf3NlADNVzLVEZTwFKDovg6eP7E8ihj2b0bJjOrb+ovA==",
    "https://registry.npmjs.org/@openclaw/msteams/-/msteams-2026.5.22.tgz",
    HTTP_REPLACEMENTS,
  ),
  "@openclaw/slack@2026.5.27": pluginReview(
    "sha512-A4SGrW52uLEVDEFqxXyLQGY+q0yc2I6IQ992HdumVGu3Cw1yc6g2P4D612paMORjOKe+TSk7/5KMUGqRbtCzpA==",
    "https://registry.npmjs.org/@openclaw/slack/-/slack-2026.5.27.tgz",
    SLACK_REPLACEMENTS,
  ),
  "@openclaw/msteams@2026.5.27": pluginReview(
    "sha512-zKMIt/7Y0JmuYOFIgG1uzXw24Y+jWoRntS7v7WnOArbT7jp5v3ld1/bfuzd195viHd5ViJZ7SftR6VUG/HvVzQ==",
    "https://registry.npmjs.org/@openclaw/msteams/-/msteams-2026.5.27.tgz",
    HTTP_REPLACEMENTS,
  ),
  "@openclaw/slack@2026.6.10": pluginReview(
    "sha512-OOsMLjPcbWhQRM5XDwfdrACjJmKqavFtpuIlhHAXWrLrd/p7SyIVE9AoKS0yxOx6bqGDIMJ9+knzdViHMLgBdA==",
    "https://registry.npmjs.org/@openclaw/slack/-/slack-2026.6.10.tgz",
    SLACK_REPLACEMENTS,
  ),
  "@openclaw/msteams@2026.6.10": pluginReview(
    "sha512-GjHnCPvjbnI0C7mEFcdT2uKDH4/WwOe2dZBfQiWxBtkE76m6TNG0J9dJjD4mc8/pk8rXSO0cWw+KV9jzWtF9VA==",
    "https://registry.npmjs.org/@openclaw/msteams/-/msteams-2026.6.10.tgz",
    HTTP_REPLACEMENTS,
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

function readJson(file: string): JsonObject {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error(`${file} must be a regular file`);
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} must contain a JSON object`);
  }
  return parsed as JsonObject;
}

function writeJson(file: string, value: JsonObject): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function requireRealDirectory(directory: string, label: string): void {
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${directory}`);
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
  for (const field of ["dependencies", "engines", "bin"] as const) {
    if (manifest[field] !== undefined) entry[field] = manifest[field];
  }
  return entry;
}

export function patchReviewedOpenClawPluginRoot(
  pluginRoot: string,
  replacementRoot: string,
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
    return { installedRoot, pin, replacement };
  });

  for (const { installedRoot, pin, replacement } of planned) {
    const staged = `${installedRoot}.nemoclaw-security-revision`;
    rmSync(staged, { recursive: true, force: true });
    cpSync(replacement, staged, { recursive: true, dereference: false });
    rmSync(installedRoot, { recursive: true, force: true });
    renameSync(staged, installedRoot);

    manifest.dependencies = { ...manifest.dependencies, [pin.name]: pin.version };
    root.dependencies = { ...root.dependencies, [pin.name]: pin.version };
    bundled.add(pin.name);
    shrinkwrap.packages[`node_modules/${pin.name}`] = lockEntry(
      pin,
      readJson(path.join(replacement, "package.json")),
    );
  }
  manifest.bundledDependencies = [...bundled].sort();
  root.bundleDependencies = [...bundled].sort();
  writeJson(manifestPath, manifest);
  writeJson(shrinkwrapPath, shrinkwrap);

  for (const { pin } of planned) {
    const installed = readJson(path.join(pluginRoot, "node_modules", pin.name, "package.json"));
    if (
      installed.version !== pin.version ||
      shrinkwrap.packages[`node_modules/${pin.name}`]?.version !== pin.version
    ) {
      throw new Error(`${spec} did not retain the reviewed ${pin.name} remediation`);
    }
  }
  return spec;
}

function installedPluginCandidates(stateDirectory: string): string[] {
  const openClawRoot = path.resolve(stateDirectory);
  const names = ["slack", "msteams", "diagnostics-otel", "whatsapp", "discord"];
  const candidates = names.flatMap((name) => [
    path.join(openClawRoot, "extensions", name),
    path.join(openClawRoot, "npm", "node_modules", "@openclaw", name),
  ]);
  const projectsRoot = path.join(openClawRoot, "npm", "projects");
  if (existsSync(projectsRoot)) {
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

function classifyArchive(archivePath: string): string {
  const resolved = path.resolve(archivePath);
  const members = runTar(["-tzf", resolved]).split("\n").filter(Boolean);
  if (
    !members.includes("package/package.json") ||
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
    } else if (args.includes("--classify-install-target")) {
      process.stdout.write(
        classifyReviewedPluginCoreInstallTarget(value("--classify-install-target")),
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
