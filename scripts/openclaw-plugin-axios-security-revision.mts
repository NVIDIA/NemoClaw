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
  openSync,
  readdirSync,
  readFileSync,
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

type JsonObject = Record<string, any>;

const AXIOS_VERSION = "1.18.0";
const AXIOS_INTEGRITY =
  "sha512-E32NzpYKp++W7XRe52rHiXV2ehxmh3wbdgO7MHeFM+vqxLBYHzt0ElkiImtOBxtOmyp0yoC8C6uESVV84Y2/hw==";
const AXIOS_TARBALL = "https://registry.npmjs.org/axios/-/axios-1.18.0.tgz";
const HTTPS_PROXY_AGENT_VERSION = "5.0.1";
const HTTPS_PROXY_AGENT_INTEGRITY =
  "sha512-dFcAjpTQFgoLMzC2VwU+C/CbS7uRL0lWmxDITmqm7C+7F0Odmj6s9l6alZc6AELXhrnggM2CeWSXHGOdX2YtwA==";
const HTTPS_PROXY_AGENT_TARBALL =
  "https://registry.npmjs.org/https-proxy-agent/-/https-proxy-agent-5.0.1.tgz";
const AGENT_BASE_VERSION = "6.0.2";
const AGENT_BASE_INTEGRITY =
  "sha512-RZNwNclF7+MS/8bDg70amg32dyeZGZxiDuQmZxKLAlQjr3jGyLx+4Kkk58UO7D2QdgFIQCovuSuZESne6RG6XQ==";
const AGENT_BASE_TARBALL = "https://registry.npmjs.org/agent-base/-/agent-base-6.0.2.tgz";

export const REVIEWED_PLUGIN_SPECS = new Set([
  "@openclaw/slack@2026.5.22",
  "@openclaw/msteams@2026.5.22",
  "@openclaw/slack@2026.5.27",
  "@openclaw/msteams@2026.5.27",
  "@openclaw/slack@2026.6.10",
  "@openclaw/msteams@2026.6.10",
]);

const REVIEWED_PLUGIN_ARCHIVES: Readonly<
  Record<string, Readonly<{ integrity: string; tarball: string }>>
> = Object.freeze({
  "@openclaw/slack@2026.5.22": {
    integrity:
      "sha512-KEy2Ct9ydjV1gFE7GWaOexnYsRWnOTtBqhYuKSE/sTnbu3guyz67L7yJxIXD8t9qh8m+ChdPpNZ1Lz+1iMpPjg==",
    tarball: "https://registry.npmjs.org/@openclaw/slack/-/slack-2026.5.22.tgz",
  },
  "@openclaw/msteams@2026.5.22": {
    integrity:
      "sha512-yiO8SXS77RSgKV8cG66TZS7m9ZneabN9toYN+EqmqJUf3NlADNVzLVEZTwFKDovg6eP7E8ihj2b0bJjOrb+ovA==",
    tarball: "https://registry.npmjs.org/@openclaw/msteams/-/msteams-2026.5.22.tgz",
  },
  "@openclaw/slack@2026.5.27": {
    integrity:
      "sha512-A4SGrW52uLEVDEFqxXyLQGY+q0yc2I6IQ992HdumVGu3Cw1yc6g2P4D612paMORjOKe+TSk7/5KMUGqRbtCzpA==",
    tarball: "https://registry.npmjs.org/@openclaw/slack/-/slack-2026.5.27.tgz",
  },
  "@openclaw/msteams@2026.5.27": {
    integrity:
      "sha512-zKMIt/7Y0JmuYOFIgG1uzXw24Y+jWoRntS7v7WnOArbT7jp5v3ld1/bfuzd195viHd5ViJZ7SftR6VUG/HvVzQ==",
    tarball: "https://registry.npmjs.org/@openclaw/msteams/-/msteams-2026.5.27.tgz",
  },
  "@openclaw/slack@2026.6.10": {
    integrity:
      "sha512-OOsMLjPcbWhQRM5XDwfdrACjJmKqavFtpuIlhHAXWrLrd/p7SyIVE9AoKS0yxOx6bqGDIMJ9+knzdViHMLgBdA==",
    tarball: "https://registry.npmjs.org/@openclaw/slack/-/slack-2026.6.10.tgz",
  },
  "@openclaw/msteams@2026.6.10": {
    integrity:
      "sha512-GjHnCPvjbnI0C7mEFcdT2uKDH4/WwOe2dZBfQiWxBtkE76m6TNG0J9dJjD4mc8/pk8rXSO0cWw+KV9jzWtF9VA==",
    tarball: "https://registry.npmjs.org/@openclaw/msteams/-/msteams-2026.6.10.tgz",
  },
});

export const REVIEWED_REPLACEMENTS = Object.freeze({
  axios: {
    version: AXIOS_VERSION,
    integrity: AXIOS_INTEGRITY,
    tarball: AXIOS_TARBALL,
  },
  httpsProxyAgent: {
    version: HTTPS_PROXY_AGENT_VERSION,
    integrity: HTTPS_PROXY_AGENT_INTEGRITY,
    tarball: HTTPS_PROXY_AGENT_TARBALL,
  },
  agentBase: {
    version: AGENT_BASE_VERSION,
    integrity: AGENT_BASE_INTEGRITY,
    tarball: AGENT_BASE_TARBALL,
  },
});

function readJson(file: string): JsonObject {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) throw new Error(`${file} must be a regular file`);
    const parsed = JSON.parse(readFileSync(descriptor, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${file} must contain a JSON object`);
    }
    return parsed as JsonObject;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function jsonContents(value: JsonObject): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function stageJsonReplacement(options: {
  label: string;
  livePath: string;
  value: JsonObject;
}): StagedReplacement {
  const replacement = stageFileReplacement({
    contents: jsonContents(options.value),
    label: options.label,
    livePath: options.livePath,
  });
  try {
    if (JSON.stringify(readJson(replacement.stagedPath)) !== JSON.stringify(options.value)) {
      throw new Error(`staged ${options.label} does not match the prepared metadata`);
    }
    return replacement;
  } catch (error) {
    discardStagedReplacements([replacement]);
    throw error;
  }
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

function requireIdentity(
  manifest: JsonObject,
  expectedName: string,
  expectedVersion: string,
  label: string,
): void {
  if (manifest.name !== expectedName || manifest.version !== expectedVersion) {
    throw new Error(
      `${label} must be ${expectedName}@${expectedVersion}; found ${packageSpec(manifest)}`,
    );
  }
}

function validateReplacementTree(replacementRoot: string): void {
  rejectUnsafeTree(replacementRoot, "reviewed Axios replacement");
  const axios = readJson(path.join(replacementRoot, "package.json"));
  const httpsProxyAgentRoot = path.join(replacementRoot, "node_modules", "https-proxy-agent");
  const agentBaseRoot = path.join(httpsProxyAgentRoot, "node_modules", "agent-base");
  const httpsProxyAgent = readJson(path.join(httpsProxyAgentRoot, "package.json"));
  const agentBase = readJson(path.join(agentBaseRoot, "package.json"));
  requireIdentity(axios, "axios", AXIOS_VERSION, "reviewed Axios replacement");
  requireIdentity(
    httpsProxyAgent,
    "https-proxy-agent",
    HTTPS_PROXY_AGENT_VERSION,
    "reviewed proxy replacement",
  );
  requireIdentity(agentBase, "agent-base", AGENT_BASE_VERSION, "reviewed agent replacement");
  const axiosDependencies = axios.dependencies ?? {};
  if (
    axiosDependencies["https-proxy-agent"] !== "^5.0.1" ||
    httpsProxyAgent.dependencies?.["agent-base"] !== "6" ||
    agentBase.dependencies?.debug !== "4"
  ) {
    throw new Error("reviewed Axios replacement dependency graph changed");
  }
}

export type OpenClawPluginName = "msteams" | "nemoclaw" | "slack";

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

export function openClawPluginCandidatePaths(
  stateDirectory: string,
  pluginName: OpenClawPluginName,
): string[] {
  const openClawRoot = path.resolve(stateDirectory);
  requireRealDirectory(openClawRoot, "OpenClaw state directory");
  const candidates = [
    path.join(openClawRoot, "extensions", pluginName),
    path.join(openClawRoot, "npm", "node_modules", "@openclaw", pluginName),
  ];
  const projectsRoot = path.join(openClawRoot, "npm", "projects");
  if (existsSync(projectsRoot)) {
    requireDescendantPath(openClawRoot, projectsRoot);
    requireRealDirectory(projectsRoot, "OpenClaw npm projects root");
    for (const project of readdirSync(projectsRoot, { withFileTypes: true })) {
      if (!project.isDirectory() || project.isSymbolicLink()) {
        throw new Error(`OpenClaw npm projects root contains an unsafe entry: ${project.name}`);
      }
      candidates.push(
        path.join(projectsRoot, project.name, "node_modules", "@openclaw", pluginName),
      );
    }
  }
  for (const candidate of candidates) requireDescendantPath(openClawRoot, candidate);
  return candidates;
}

export function installedPluginCandidates(stateDirectory: string): string[] {
  return (["slack", "msteams"] as const)
    .flatMap((pluginName) => openClawPluginCandidatePaths(stateDirectory, pluginName))
    .filter((candidate) => existsSync(path.join(candidate, "package.json")));
}

function preparePluginMetadata(
  pluginRoot: string,
  manifest: JsonObject,
): { manifest: JsonObject; shrinkwrap: JsonObject } {
  if (manifest.dependencies?.axios !== undefined && manifest.dependencies.axios !== AXIOS_VERSION) {
    throw new Error(`${packageSpec(manifest)} declares an unexpected Axios dependency`);
  }
  if (!Array.isArray(manifest.bundledDependencies)) {
    throw new Error(`${packageSpec(manifest)} has no bundledDependencies array`);
  }
  if (!manifest.bundledDependencies.includes("axios")) {
    manifest.bundledDependencies.push("axios");
  }
  manifest.dependencies = { ...manifest.dependencies, axios: AXIOS_VERSION };

  const shrinkwrapPath = path.join(pluginRoot, "npm-shrinkwrap.json");
  const shrinkwrap = readJson(shrinkwrapPath);
  if (shrinkwrap.lockfileVersion !== 3 || !shrinkwrap.packages?.[""]) {
    throw new Error(`${packageSpec(manifest)} must ship an npm lockfileVersion 3 shrinkwrap`);
  }
  const root = shrinkwrap.packages[""] as JsonObject;
  if (root.dependencies?.axios !== undefined && root.dependencies.axios !== AXIOS_VERSION) {
    throw new Error(`${packageSpec(manifest)} shrinkwrap root has an unexpected Axios dependency`);
  }
  root.dependencies = { ...root.dependencies, axios: AXIOS_VERSION };
  root.bundleDependencies = [...manifest.bundledDependencies];

  const axiosKey = "node_modules/axios";
  const observedAxios = shrinkwrap.packages[axiosKey] as JsonObject | undefined;
  if (observedAxios?.version !== "1.16.0" && observedAxios?.version !== AXIOS_VERSION) {
    throw new Error(`${packageSpec(manifest)} has an unexpected shrinkwrap Axios version`);
  }
  shrinkwrap.packages[axiosKey] = {
    version: AXIOS_VERSION,
    resolved: AXIOS_TARBALL,
    integrity: AXIOS_INTEGRITY,
    license: "MIT",
    dependencies: {
      "follow-redirects": "^1.16.0",
      "form-data": "^4.0.5",
      "https-proxy-agent": "^5.0.1",
      "proxy-from-env": "^2.1.0",
    },
  };
  shrinkwrap.packages["node_modules/axios/node_modules/https-proxy-agent"] = {
    version: HTTPS_PROXY_AGENT_VERSION,
    resolved: HTTPS_PROXY_AGENT_TARBALL,
    integrity: HTTPS_PROXY_AGENT_INTEGRITY,
    license: "MIT",
    dependencies: { "agent-base": "6", debug: "4" },
    engines: { node: ">= 6" },
  };
  shrinkwrap.packages["node_modules/axios/node_modules/https-proxy-agent/node_modules/agent-base"] =
    {
      version: AGENT_BASE_VERSION,
      resolved: AGENT_BASE_TARBALL,
      integrity: AGENT_BASE_INTEGRITY,
      license: "MIT",
      dependencies: { debug: "4" },
      engines: { node: ">= 6.0.0" },
    };
  return { manifest, shrinkwrap };
}

function verifyPatchedPlugin(pluginRoot: string, expectedSpec: string): void {
  const manifest = readJson(path.join(pluginRoot, "package.json"));
  const shrinkwrap = readJson(path.join(pluginRoot, "npm-shrinkwrap.json"));
  const axios = readJson(path.join(pluginRoot, "node_modules", "axios", "package.json"));
  if (
    packageSpec(manifest) !== expectedSpec ||
    manifest.dependencies?.axios !== AXIOS_VERSION ||
    !Array.isArray(manifest.bundledDependencies) ||
    !manifest.bundledDependencies.includes("axios") ||
    shrinkwrap.packages?.["node_modules/axios"]?.version !== AXIOS_VERSION ||
    shrinkwrap.packages?.[
      "node_modules/axios/node_modules/https-proxy-agent/node_modules/agent-base"
    ]?.version !== AGENT_BASE_VERSION ||
    axios.name !== "axios" ||
    axios.version !== AXIOS_VERSION
  ) {
    throw new Error(`${expectedSpec} did not retain the reviewed Axios remediation`);
  }
}

type PluginPatch = {
  manifest: JsonObject;
  pluginRoot: string;
  shrinkwrap: JsonObject;
  spec: string;
};

function preparePluginPatch(pluginRoot: string): PluginPatch | null {
  requireRealDirectory(pluginRoot, "installed OpenClaw plugin");
  const manifest = readJson(path.join(pluginRoot, "package.json"));
  const spec = packageSpec(manifest);
  if (!REVIEWED_PLUGIN_SPECS.has(spec)) return null;
  const axiosRoot = path.join(pluginRoot, "node_modules", "axios");
  requireRealDirectory(axiosRoot, `${spec} installed Axios`);
  const installedAxios = readJson(path.join(axiosRoot, "package.json"));
  if (installedAxios.name !== "axios") throw new Error(`${spec} Axios identity changed`);
  if (installedAxios.version !== "1.16.0" && installedAxios.version !== AXIOS_VERSION) {
    throw new Error(`${spec} has unexpected installed Axios ${String(installedAxios.version)}`);
  }
  return { ...preparePluginMetadata(pluginRoot, manifest), pluginRoot, spec };
}

export function patchInstalledOpenClawPlugins(options: {
  homeDirectory?: string;
  replacementRoot: string;
  expectedPackageSpec?: string;
  stateDirectory?: string;
  transactionHook?: StagedReplacementTransactionHook;
}): string[] {
  const replacementRoot = path.resolve(options.replacementRoot);
  validateReplacementTree(replacementRoot);
  if (options.stateDirectory && options.homeDirectory) {
    const derivedStateDirectory = path.resolve(options.homeDirectory, ".openclaw");
    if (path.resolve(options.stateDirectory) !== derivedStateDirectory) {
      throw new Error("--state-directory and --home identify different OpenClaw state directories");
    }
  }
  const stateDirectory = options.stateDirectory
    ? path.resolve(options.stateDirectory)
    : options.homeDirectory
      ? path.resolve(options.homeDirectory, ".openclaw")
      : undefined;
  if (!stateDirectory) throw new Error("OpenClaw state directory is required");

  const patches = installedPluginCandidates(stateDirectory)
    .map((candidate) => preparePluginPatch(candidate))
    .filter((patch): patch is PluginPatch => patch !== null);
  const patched = patches.map((patch) => patch.spec);
  if (options.expectedPackageSpec && !patched.includes(options.expectedPackageSpec)) {
    throw new Error(
      `OpenClaw reported success but ${options.expectedPackageSpec} was not found in a reviewed install layout`,
    );
  }
  if (patches.length === 0) return [];

  const replacements: StagedReplacement[] = [];
  let commitStarted = false;
  try {
    for (const patch of patches) {
      const axiosReplacement = stageDirectoryReplacement({
        label: `${patch.spec} Axios package tree`,
        livePath: path.join(patch.pluginRoot, "node_modules", "axios"),
        sourcePath: replacementRoot,
      });
      replacements.push(axiosReplacement);
      validateReplacementTree(axiosReplacement.stagedPath);
      replacements.push(
        stageJsonReplacement({
          label: `${patch.spec} package metadata`,
          livePath: path.join(patch.pluginRoot, "package.json"),
          value: patch.manifest,
        }),
        stageJsonReplacement({
          label: `${patch.spec} shrinkwrap metadata`,
          livePath: path.join(patch.pluginRoot, "npm-shrinkwrap.json"),
          value: patch.shrinkwrap,
        }),
      );
    }
    commitStarted = true;
    commitStagedReplacementTransaction({
      injectFailure: options.transactionHook,
      replacements,
      verify: () => {
        for (const patch of patches) verifyPatchedPlugin(patch.pluginRoot, patch.spec);
      },
    });
  } catch (error) {
    if (!commitStarted) discardStagedReplacements(replacements);
    throw error;
  }
  return patched;
}

function runTar(args: string[]): string {
  const result = spawnSync("tar", args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
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
  const reviewed = REVIEWED_PLUGIN_ARCHIVES[spec];
  if (!reviewed) return "";
  const observedIntegrity = `sha512-${createHash("sha512")
    .update(readFileSync(resolved))
    .digest("base64")}`;
  if (observedIntegrity !== reviewed.integrity) {
    throw new Error(
      `${spec} archive integrity mismatch: expected ${reviewed.integrity}, got ${observedIntegrity}`,
    );
  }
  return spec;
}

export function classifyReviewedInstallTarget(target: string): string {
  const normalized = target.startsWith("npm:") ? target.slice(4) : target;
  if (REVIEWED_PLUGIN_SPECS.has(normalized)) return normalized;
  const archiveTarget = target.startsWith("npm-pack:") ? target.slice("npm-pack:".length) : target;
  if (archiveTarget.endsWith(".tgz") && existsSync(archiveTarget)) {
    return classifyArchive(archiveTarget);
  }
  return "";
}

export function materializeReviewedInstallTarget(target: string, workingDirectory: string): string {
  const normalized = target.startsWith("npm:") ? target.slice(4) : target;
  const reviewed = REVIEWED_PLUGIN_ARCHIVES[normalized];
  if (reviewed) {
    const packed = packReviewedNpmArchive({
      expectedIntegrity: reviewed.integrity,
      label: `historical OpenClaw plugin ${normalized}`,
      packageSpec: normalized,
      tarballUrl: reviewed.tarball,
      tempDirectory: workingDirectory,
    });
    return `npm-pack:${packed.archivePath}`;
  }
  const localSpec = classifyReviewedInstallTarget(target);
  if (localSpec && !target.startsWith("npm-pack:")) {
    return `npm-pack:${path.resolve(target)}`;
  }
  return target;
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
    if (args.includes("--classify-install-target")) {
      process.stdout.write(classifyReviewedInstallTarget(value("--classify-install-target")));
    } else if (args.includes("--materialize-install-target")) {
      process.stdout.write(
        materializeReviewedInstallTarget(
          value("--materialize-install-target"),
          value("--working-directory"),
        ),
      );
    } else {
      const expectedPackageSpec = args.includes("--expected-package-spec")
        ? value("--expected-package-spec")
        : undefined;
      patchInstalledOpenClawPlugins({
        homeDirectory: args.includes("--home") ? value("--home") : undefined,
        replacementRoot: value("--replacement-root"),
        expectedPackageSpec,
        stateDirectory: args.includes("--state-directory") ? value("--state-directory") : undefined,
      });
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
