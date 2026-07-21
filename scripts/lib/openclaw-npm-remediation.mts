#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { packReviewedNpmArchive } from "./reviewed-npm-archive.mts";

type JsonObject = Record<string, any>;

type Remediation = Readonly<{
  kind: "axios-plugin" | "core" | "otel-plugin";
  expectedPatchedMetadataIntegrity: string;
}>;

type RemediationRequest = Readonly<{
  archivePath: string;
  env?: NodeJS.ProcessEnv;
  packageSpec: string;
  workingDirectory: string;
}>;

type BuildRequest = RemediationRequest &
  Readonly<{
    expectedPatchedMetadataIntegrity?: string;
  }>;

export type RemediatedArchive = Readonly<{
  archivePath: string;
  integrity: string;
}> &
  Readonly<
    | { remediated: false }
    | {
        metadataIntegrity: string;
        remediated: true;
      }
  >;

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
const TAR_VERSION = "7.5.19";
const TAR_INTEGRITY =
  "sha512-4LeEWl96twnS2Q7Bz4MGqgazLqO+hJN63GZxXoIqh1T3VweYD997gbU1ItNsQafqqXTXd5WFyFdReLtwvRBNiw==";
const TAR_TARBALL = "https://registry.npmjs.org/tar/-/tar-7.5.19.tgz";
const FS_SAFE_VERSION = "0.3.0";
const FS_SAFE_INTEGRITY =
  "sha512-uIBE441CIt1kIURoP9qRGKZ8LkGyfD9ZzeESjwAd29ZPWtghws/5GR3Pjb67jKdcJHP1I6roNXcvnhzAU7lHlA==";
const FS_SAFE_TARBALL = "https://registry.npmjs.org/@openclaw/fs-safe/-/fs-safe-0.3.0.tgz";
const BRACE_EXPANSION_VERSION = "5.0.7";
const BRACE_EXPANSION_INTEGRITY =
  "sha512-7oFy703dxfY3/NLxC1fh2SUCQ0H9rmAY+5EpDVfXjUTTs+HEwR2nYaqLv+GWcTsumwxPfiz6CzCNkwXwBUwqCA==";
const BRACE_EXPANSION_TARBALL =
  "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.7.tgz";
const HONO_NODE_SERVER_VERSION = "2.0.5";
const HONO_NODE_SERVER_INTEGRITY =
  "sha512-yQFvDmyDo3y6rEOJZDUYPJ49DIKTPpIk4kGvm40xx4Ejne0Pu9a1+exxPN+C1UppWK/WGZX9F++/Xs231tE86g==";
const HONO_NODE_SERVER_TARBALL =
  "https://registry.npmjs.org/@hono/node-server/-/node-server-2.0.5.tgz";
const MODEL_CONTEXT_PROTOCOL_SDK_VERSION = "1.29.0";
const MODEL_CONTEXT_PROTOCOL_SDK_INTEGRITY =
  "sha512-zo37mZA9hJWpULgkRpowewez1y6ML5GsXJPY8FI0tBBCd77HEvza4jDqRKOXgHNn867PVGCyTdzqpz0izu5ZjQ==";
const MODEL_CONTEXT_PROTOCOL_SDK_TARBALL =
  "https://registry.npmjs.org/@modelcontextprotocol/sdk/-/sdk-1.29.0.tgz";
const EVENTSOURCE_PARSER_VERSION = "3.1.0";
const EVENTSOURCE_PARSER_INTEGRITY =
  "sha512-kJezFj9YFAMLeORyi7aCLxLbD5/qWMQnoMVlVPyHIll7lgRJCc3JVln9Vgl9nwQi0YkMnhdGTMNn7CkRRAptMg==";
const EVENTSOURCE_PARSER_TARBALL =
  "https://registry.npmjs.org/eventsource-parser/-/eventsource-parser-3.1.0.tgz";
const OTEL_PROPAGATOR_JAEGER_VERSION = "2.9.0";
const OTEL_PROPAGATOR_JAEGER_INTEGRITY =
  "sha512-4mYGty27rYvSM0jtp1ZUOqd3LfVRCYg9H5G9OFzSx5HViYToU21MFhWfco7x1HwXr7ER8yGOiCIHZUwjPksc0Q==";
const OTEL_PROPAGATOR_JAEGER_TARBALL =
  "https://registry.npmjs.org/@opentelemetry/propagator-jaeger/-/propagator-jaeger-2.9.0.tgz";
const OTEL_CORE_VERSION = "2.9.0";
const OTEL_CORE_INTEGRITY =
  "sha512-m2nckMT80NnmjTYSPjJQObBJ+8dgkoajEOUbznL8AHZ3T3yHRk2P7gI1PhEBc1+lOnrYE9UWrWHqJDsmqjmNbw==";
const OTEL_CORE_TARBALL = "https://registry.npmjs.org/@opentelemetry/core/-/core-2.9.0.tgz";
const CANONICAL_ARCHIVE_TIME = new Date(0);

const REMEDIATIONS: Readonly<Record<string, Remediation>> = Object.freeze({
  "@openclaw/msteams@2026.6.10": {
    kind: "axios-plugin",
    expectedPatchedMetadataIntegrity:
      "sha512-eTTIpA8HzcBwXBLt6UZDoFgOUmkRgIhcZFBOwg+5Jfgt8HDwtfPnqKo6vm2DdDdPMPhu08FbEzU5Gt3RoL5fIw==",
  },
  "@openclaw/slack@2026.6.10": {
    kind: "axios-plugin",
    expectedPatchedMetadataIntegrity:
      "sha512-AXllGzI+m33jUq3w1nCVXngLA1m9kH8c9XryHSoPzuVhGP6xwWpzgKl3yyfOMoIykN0GKcka59ZZbjEwkxFudQ==",
  },
  "@openclaw/diagnostics-otel@2026.6.10": {
    kind: "otel-plugin",
    expectedPatchedMetadataIntegrity:
      "sha512-QmgyGI7AQJrNGoWAYolunc18wUr6Q4iOK4n9YXCOo3Cxh+e2GONtOAbeu+OFpQW8PsF6x/iGInDQmeKD+jnOug==",
  },
  "openclaw@2026.6.10": {
    kind: "core",
    expectedPatchedMetadataIntegrity:
      "sha512-p9kAvBe2g+2m0me+Ns5e9mSLw9md2uYJuDxhEAErVTE8JmCnDuPhS+3/A2NDVYzCWIyNB89Fezv1y2neBtuGEQ==",
  },
});

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf-8",
    env,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function validateArchiveMembers(archivePath: string, cwd: string, env: NodeJS.ProcessEnv): void {
  const names = run("tar", ["-tzf", archivePath], cwd, env)
    .split("\n")
    .filter((entry) => entry.length > 0);
  const verbose = run("tar", ["-tvzf", archivePath], cwd, env)
    .split("\n")
    .filter((entry) => entry.length > 0);
  if (names.length === 0 || verbose.length !== names.length) {
    throw new Error(`npm archive ${archivePath} has an invalid member listing`);
  }
  const seen = new Set<string>();
  for (let index = 0; index < names.length; index += 1) {
    const member = names[index] as string;
    const type = (verbose[index] as string)[0];
    const normalized = member.endsWith("/") ? member.slice(0, -1) : member;
    if (
      (type !== "-" && type !== "d") ||
      (normalized !== "package" && !normalized.startsWith("package/")) ||
      normalized.includes("\\") ||
      normalized.split("/").some((part) => part === "" || part === "." || part === "..") ||
      seen.has(normalized)
    ) {
      throw new Error(`npm archive ${archivePath} has an unsafe member: ${member}`);
    }
    seen.add(normalized);
  }
  if (!seen.has("package/package.json")) {
    throw new Error(`npm archive ${archivePath} has no package/package.json`);
  }
}

function extractArchive(
  archivePath: string,
  destination: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): string {
  validateArchiveMembers(archivePath, cwd, env);
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  run(
    "tar",
    ["-xzf", archivePath, "--no-same-owner", "--no-same-permissions", "-C", destination],
    cwd,
    env,
  );
  const packageDirectory = join(destination, "package");
  if (!existsSync(join(packageDirectory, "package.json"))) {
    throw new Error(`npm archive ${archivePath} did not extract a package directory`);
  }
  return packageDirectory;
}

function readJson(path: string): JsonObject {
  const parsed = JSON.parse(readFileSync(path, "utf-8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return parsed as JsonObject;
}

function writeJson(path: string, value: JsonObject): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function hashPatchedMetadata(packageDirectory: string): string {
  const hash = createHash("sha512");
  const names = ["package.json", "npm-shrinkwrap.json"];
  for (const bundledPackageJson of [
    "node_modules/@hono/node-server/package.json",
    "node_modules/@modelcontextprotocol/sdk/package.json",
    "node_modules/@openclaw/fs-safe/package.json",
    "node_modules/eventsource-parser/package.json",
    "node_modules/@opentelemetry/propagator-jaeger/node_modules/@opentelemetry/core/package.json",
    "node_modules/@opentelemetry/propagator-jaeger/package.json",
    "node_modules/@opentelemetry/sdk-node/package.json",
  ]) {
    if (existsSync(join(packageDirectory, bundledPackageJson))) names.push(bundledPackageJson);
  }
  for (const name of names) {
    const contents = readFileSync(join(packageDirectory, name));
    hash.update(`${name}\0${contents.length}\0`);
    hash.update(contents);
    hash.update("\0");
  }
  return `sha512-${hash.digest("base64")}`;
}

function sortedObject(value: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function requirePackageIdentity(
  packageJson: JsonObject,
  expectedName: string,
  expectedVersion: string,
  label: string,
): void {
  if (packageJson.name !== expectedName || packageJson.version !== expectedVersion) {
    throw new Error(
      `${label} must be ${expectedName}@${expectedVersion}; found ${String(packageJson.name)}@${String(packageJson.version)}`,
    );
  }
}

function requireDependencyShape(
  packageJson: JsonObject,
  expected: JsonObject,
  label: string,
): void {
  if (
    !packageJson.dependencies ||
    JSON.stringify(sortedObject(packageJson.dependencies)) !==
      JSON.stringify(sortedObject(expected))
  ) {
    throw new Error(`${label} dependency graph changed; review the remediation before updating it`);
  }
}

export function patchOpenClawPluginPackageGraph(
  packageDirectory: string,
  packageSpec: string,
): void {
  const packageJsonPath = join(packageDirectory, "package.json");
  const shrinkwrapPath = join(packageDirectory, "npm-shrinkwrap.json");
  const packageJson = readJson(packageJsonPath);
  const versionAt = packageSpec.lastIndexOf("@");
  const expectedName = packageSpec.slice(0, versionAt);
  const expectedVersion = packageSpec.slice(versionAt + 1);
  requirePackageIdentity(packageJson, expectedName, expectedVersion, "OpenClaw plugin");
  if (packageJson.dependencies?.axios !== undefined) {
    throw new Error(`${packageSpec} already declares axios; review the remediation boundary`);
  }
  if (!Array.isArray(packageJson.bundledDependencies)) {
    throw new Error(`${packageSpec} has no bundledDependencies array`);
  }
  if (packageJson.bundledDependencies.includes("axios")) {
    throw new Error(`${packageSpec} already bundles axios; review the remediation boundary`);
  }
  packageJson.dependencies = sortedObject({ ...packageJson.dependencies, axios: AXIOS_VERSION });
  packageJson.bundledDependencies = [...packageJson.bundledDependencies, "axios"];

  const shrinkwrap = readJson(shrinkwrapPath);
  if (shrinkwrap.lockfileVersion !== 3 || !shrinkwrap.packages?.[""]) {
    throw new Error(`${packageSpec} must ship an npm lockfileVersion 3 shrinkwrap`);
  }
  const root = shrinkwrap.packages[""] as JsonObject;
  if (root.dependencies?.axios !== undefined) {
    throw new Error(`${packageSpec} shrinkwrap already declares axios at the root`);
  }
  root.dependencies = sortedObject({ ...root.dependencies, axios: AXIOS_VERSION });
  root.bundleDependencies = [...packageJson.bundledDependencies];

  const axiosKey = "node_modules/axios";
  const axios = shrinkwrap.packages[axiosKey] as JsonObject | undefined;
  if (axios?.version !== "1.16.0") {
    throw new Error(`${packageSpec} must resolve ${axiosKey} to 1.16.0 before remediation`);
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

  const httpsProxyAgentKey = "node_modules/axios/node_modules/https-proxy-agent";
  const agentBaseKey = `${httpsProxyAgentKey}/node_modules/agent-base`;
  if (shrinkwrap.packages[httpsProxyAgentKey] || shrinkwrap.packages[agentBaseKey]) {
    throw new Error(`${packageSpec} already has the nested Axios proxy dependency remediation`);
  }
  shrinkwrap.packages[httpsProxyAgentKey] = {
    version: HTTPS_PROXY_AGENT_VERSION,
    resolved: HTTPS_PROXY_AGENT_TARBALL,
    integrity: HTTPS_PROXY_AGENT_INTEGRITY,
    license: "MIT",
    dependencies: { "agent-base": "6", debug: "4" },
    engines: { node: ">= 6" },
  };
  shrinkwrap.packages[agentBaseKey] = {
    version: AGENT_BASE_VERSION,
    resolved: AGENT_BASE_TARBALL,
    integrity: AGENT_BASE_INTEGRITY,
    license: "MIT",
    dependencies: { debug: "4" },
    engines: { node: ">= 6.0.0" },
  };

  writeJson(packageJsonPath, packageJson);
  writeJson(shrinkwrapPath, shrinkwrap);
}

export function patchOpenClawOtelPluginPackageGraph(packageDirectory: string): void {
  const packageJsonPath = join(packageDirectory, "package.json");
  const shrinkwrapPath = join(packageDirectory, "npm-shrinkwrap.json");
  const packageJson = readJson(packageJsonPath);
  requirePackageIdentity(
    packageJson,
    "@openclaw/diagnostics-otel",
    "2026.6.10",
    "OpenClaw diagnostics OTEL plugin",
  );
  if (
    packageJson.dependencies?.["@opentelemetry/sdk-node"] !== "0.219.0" ||
    !Array.isArray(packageJson.bundledDependencies) ||
    !packageJson.bundledDependencies.includes("@opentelemetry/sdk-node")
  ) {
    throw new Error("OpenClaw diagnostics OTEL package graph changed after review");
  }

  const shrinkwrap = readJson(shrinkwrapPath);
  if (shrinkwrap.lockfileVersion !== 3 || !shrinkwrap.packages?.[""]) {
    throw new Error("OpenClaw diagnostics OTEL must ship an npm lockfileVersion 3 shrinkwrap");
  }
  const sdkNode = shrinkwrap.packages["node_modules/@opentelemetry/sdk-node"] as
    | JsonObject
    | undefined;
  const jaeger = shrinkwrap.packages["node_modules/@opentelemetry/propagator-jaeger"] as
    | JsonObject
    | undefined;
  const nestedCoreKey =
    "node_modules/@opentelemetry/propagator-jaeger/node_modules/@opentelemetry/core";
  if (
    sdkNode?.version !== "0.219.0" ||
    sdkNode.dependencies?.["@opentelemetry/propagator-jaeger"] !== "2.8.0" ||
    jaeger?.version !== "2.8.0" ||
    jaeger.resolved !==
      "https://registry.npmjs.org/@opentelemetry/propagator-jaeger/-/propagator-jaeger-2.8.0.tgz" ||
    jaeger.integrity !==
      "sha512-Xnz9zZvvQzUw+9DrOn0MomR7BxFCkA2pcfXBQuHC28ndJpSbjLs7knzYb05kw5SyCjSsEWombkZMgGcJSk8JVg==" ||
    jaeger.dependencies?.["@opentelemetry/core"] !== "2.8.0" ||
    shrinkwrap.packages[nestedCoreKey] !== undefined
  ) {
    throw new Error("OpenClaw diagnostics OTEL Jaeger graph changed after review");
  }
  sdkNode.dependencies["@opentelemetry/propagator-jaeger"] = OTEL_PROPAGATOR_JAEGER_VERSION;
  shrinkwrap.packages["node_modules/@opentelemetry/propagator-jaeger"] = {
    version: OTEL_PROPAGATOR_JAEGER_VERSION,
    resolved: OTEL_PROPAGATOR_JAEGER_TARBALL,
    integrity: OTEL_PROPAGATOR_JAEGER_INTEGRITY,
    license: "Apache-2.0",
    dependencies: { "@opentelemetry/core": OTEL_CORE_VERSION },
    engines: { node: "^18.19.0 || >=20.6.0" },
    peerDependencies: { "@opentelemetry/api": ">=1.0.0 <1.10.0" },
  };
  shrinkwrap.packages[nestedCoreKey] = {
    version: OTEL_CORE_VERSION,
    resolved: OTEL_CORE_TARBALL,
    integrity: OTEL_CORE_INTEGRITY,
    license: "Apache-2.0",
    dependencies: { "@opentelemetry/semantic-conventions": "^1.29.0" },
    engines: { node: "^18.19.0 || >=20.6.0" },
    peerDependencies: { "@opentelemetry/api": ">=1.0.0 <1.10.0" },
  };
  writeJson(shrinkwrapPath, shrinkwrap);
}

export function patchOpenClawCorePackageGraph(packageDirectory: string): void {
  const packageJsonPath = join(packageDirectory, "package.json");
  const shrinkwrapPath = join(packageDirectory, "npm-shrinkwrap.json");
  const packageJson = readJson(packageJsonPath);
  requirePackageIdentity(packageJson, "openclaw", "2026.6.10", "OpenClaw core");
  if (packageJson.dependencies?.tar !== "7.5.16") {
    throw new Error("openclaw@2026.6.10 must declare reviewed tar@7.5.16 before remediation");
  }
  if (packageJson.dependencies?.jszip !== "3.10.1") {
    throw new Error("openclaw@2026.6.10 must declare reviewed jszip@3.10.1 before remediation");
  }
  if (packageJson.dependencies?.["brace-expansion"] !== undefined) {
    throw new Error("openclaw@2026.6.10 unexpectedly declares brace-expansion directly");
  }
  if (packageJson.bundledDependencies !== undefined) {
    throw new Error("openclaw@2026.6.10 unexpectedly declares bundled dependencies");
  }

  const shrinkwrap = readJson(shrinkwrapPath);
  if (shrinkwrap.lockfileVersion !== 3 || !shrinkwrap.packages?.[""]) {
    throw new Error("openclaw@2026.6.10 must ship an npm lockfileVersion 3 shrinkwrap");
  }
  const packages = shrinkwrap.packages as JsonObject;
  const root = packages[""] as JsonObject;
  requirePackageIdentity(root, "openclaw", "2026.6.10", "OpenClaw shrinkwrap root");
  const tar = packages["node_modules/tar"] as JsonObject | undefined;
  const braceExpansion = packages["node_modules/brace-expansion"] as JsonObject | undefined;
  const fsSafe = packages["node_modules/@openclaw/fs-safe"] as JsonObject | undefined;
  const honoNodeServer = packages["node_modules/@hono/node-server"] as JsonObject | undefined;
  const jszip = packages["node_modules/jszip"] as JsonObject | undefined;
  const minimatch = packages["node_modules/minimatch"] as JsonObject | undefined;
  const modelContextProtocolSdk = packages["node_modules/@modelcontextprotocol/sdk"] as
    | JsonObject
    | undefined;
  const eventsourceParser = packages["node_modules/eventsource-parser"] as JsonObject | undefined;
  if (root.dependencies?.tar !== "7.5.16" || tar?.version !== "7.5.16") {
    throw new Error("openclaw@2026.6.10 tar shrinkwrap state changed after review");
  }
  if (root.dependencies?.jszip !== "3.10.1" || jszip?.version !== "3.10.1") {
    throw new Error("openclaw@2026.6.10 jszip shrinkwrap state changed after review");
  }
  if (
    packageJson.dependencies?.["@modelcontextprotocol/sdk"] !== "1.29.0" ||
    root.dependencies?.["@modelcontextprotocol/sdk"] !== "1.29.0" ||
    modelContextProtocolSdk?.version !== "1.29.0" ||
    modelContextProtocolSdk.dependencies?.["@hono/node-server"] !== "^1.19.9" ||
    modelContextProtocolSdk.dependencies?.["eventsource-parser"] !== "^3.0.0" ||
    eventsourceParser?.version !== EVENTSOURCE_PARSER_VERSION ||
    eventsourceParser.resolved !== EVENTSOURCE_PARSER_TARBALL ||
    eventsourceParser.integrity !== EVENTSOURCE_PARSER_INTEGRITY ||
    honoNodeServer?.version !== "1.19.14" ||
    honoNodeServer.resolved !==
      "https://registry.npmjs.org/@hono/node-server/-/node-server-1.19.14.tgz" ||
    honoNodeServer.integrity !==
      "sha512-GwtvgtXxnWsucXvbQXkRgqksiH2Qed37H9xHZocE5sA3N8O8O8/8FA3uclQXxXVzc9XBZuEOMK7+r02FmSpHtw=="
  ) {
    throw new Error("openclaw@2026.6.10 Hono node server layout changed after review");
  }
  if (
    fsSafe?.optionalDependencies?.jszip !== "^3.10.1" ||
    fsSafe?.optionalDependencies?.tar !== "7.5.13" ||
    Object.keys(fsSafe.optionalDependencies).length !== 2 ||
    packages["node_modules/@openclaw/fs-safe/node_modules/tar"] !== undefined
  ) {
    throw new Error(
      "openclaw@2026.6.10 @openclaw/fs-safe optional dependency layout changed after review",
    );
  }
  if (
    braceExpansion?.version !== "5.0.6" ||
    minimatch?.dependencies?.["brace-expansion"] !== "^5.0.5"
  ) {
    throw new Error("openclaw@2026.6.10 brace-expansion layout changed after review");
  }

  packageJson.dependencies.tar = TAR_VERSION;
  packageJson.bundledDependencies = [
    "@hono/node-server",
    "@modelcontextprotocol/sdk",
    "@openclaw/fs-safe",
    "eventsource-parser",
  ];
  root.dependencies.tar = TAR_VERSION;
  root.bundleDependencies = [...packageJson.bundledDependencies];
  modelContextProtocolSdk.dependencies["@hono/node-server"] = HONO_NODE_SERVER_VERSION;
  honoNodeServer.version = HONO_NODE_SERVER_VERSION;
  honoNodeServer.resolved = HONO_NODE_SERVER_TARBALL;
  honoNodeServer.integrity = HONO_NODE_SERVER_INTEGRITY;
  eventsourceParser.version = EVENTSOURCE_PARSER_VERSION;
  eventsourceParser.resolved = EVENTSOURCE_PARSER_TARBALL;
  eventsourceParser.integrity = EVENTSOURCE_PARSER_INTEGRITY;
  tar.version = TAR_VERSION;
  tar.resolved = TAR_TARBALL;
  tar.integrity = TAR_INTEGRITY;
  delete fsSafe.optionalDependencies;
  braceExpansion.version = BRACE_EXPANSION_VERSION;
  braceExpansion.resolved = BRACE_EXPANSION_TARBALL;
  braceExpansion.integrity = BRACE_EXPANSION_INTEGRITY;

  writeJson(packageJsonPath, packageJson);
  writeJson(shrinkwrapPath, shrinkwrap);
}

function patchFsSafePackageGraph(packageDirectory: string): void {
  const packageJsonPath = join(packageDirectory, "package.json");
  const packageJson = readJson(packageJsonPath);
  requirePackageIdentity(
    packageJson,
    "@openclaw/fs-safe",
    FS_SAFE_VERSION,
    "OpenClaw fs-safe remediation package",
  );
  if (
    !packageJson.optionalDependencies ||
    packageJson.optionalDependencies.jszip !== "^3.10.1" ||
    packageJson.optionalDependencies.tar !== "7.5.13" ||
    Object.keys(packageJson.optionalDependencies).length !== 2
  ) {
    throw new Error(
      "@openclaw/fs-safe@0.3.0 optional dependency graph changed; review the remediation",
    );
  }
  delete packageJson.optionalDependencies;
  writeJson(packageJsonPath, packageJson);
}

function patchModelContextProtocolPackageGraph(packageDirectory: string): void {
  const packageJsonPath = join(packageDirectory, "package.json");
  const packageJson = readJson(packageJsonPath);
  requirePackageIdentity(
    packageJson,
    "@modelcontextprotocol/sdk",
    MODEL_CONTEXT_PROTOCOL_SDK_VERSION,
    "OpenClaw MCP SDK remediation package",
  );
  if (packageJson.dependencies?.["@hono/node-server"] !== "^1.19.9") {
    throw new Error(
      "@modelcontextprotocol/sdk@1.29.0 Hono node server dependency changed; review the remediation",
    );
  }
  packageJson.dependencies["@hono/node-server"] = HONO_NODE_SERVER_VERSION;
  writeJson(packageJsonPath, packageJson);
}

function patchOtelSdkNodePackageGraph(packageDirectory: string): void {
  const packageJsonPath = join(packageDirectory, "package.json");
  const packageJson = readJson(packageJsonPath);
  requirePackageIdentity(
    packageJson,
    "@opentelemetry/sdk-node",
    "0.219.0",
    "OpenClaw diagnostics OTEL SDK package",
  );
  if (packageJson.dependencies?.["@opentelemetry/propagator-jaeger"] !== "2.8.0") {
    throw new Error("@opentelemetry/sdk-node@0.219.0 Jaeger dependency changed after review");
  }
  packageJson.dependencies["@opentelemetry/propagator-jaeger"] = OTEL_PROPAGATOR_JAEGER_VERSION;
  writeJson(packageJsonPath, packageJson);
}

function copyReplacementPackage(source: string, destination: string): void {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(resolve(destination, ".."), { recursive: true, mode: 0o755 });
  cpSync(source, destination, { recursive: true, force: true });
}

function packReplacement(
  packageSpec: string,
  expectedIntegrity: string,
  tarballUrl: string,
  workingDirectory: string,
  env: NodeJS.ProcessEnv,
) {
  return packReviewedNpmArchive({
    env,
    expectedIntegrity,
    label: `OpenClaw npm remediation dependency ${packageSpec}`,
    npmExecutable: env.NEMOCLAW_REVIEWED_NPM_EXECUTABLE,
    packageSpec,
    tarballUrl,
    tempDirectory: workingDirectory,
  });
}

function normalizeArchiveContents(directory: string, member: string): string[] {
  const members = [member];
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  for (const entry of entries) {
    const target = join(directory, entry.name);
    const childMember = `${member}/${entry.name}`;
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      members.push(...normalizeArchiveContents(target, childMember));
    } else if (!entry.isFile()) {
      throw new Error(`remediated npm archive contains an unsafe member: ${target}`);
    } else {
      members.push(childMember);
      chmodSync(target, statSync(target).mode & 0o111 ? 0o755 : 0o644);
    }
    utimesSync(target, CANONICAL_ARCHIVE_TIME, CANONICAL_ARCHIVE_TIME);
  }
  chmodSync(directory, 0o755);
  utimesSync(directory, CANONICAL_ARCHIVE_TIME, CANONICAL_ARCHIVE_TIME);
  return members;
}

function createCanonicalArchive(
  sourcePackage: string,
  archivePath: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): void {
  const archiveMembers = normalizeArchiveContents(sourcePackage, basename(sourcePackage));
  const tarPath = `${archivePath}.tar`;
  const canonicalEnv: NodeJS.ProcessEnv = { ...env, LANG: "C", LC_ALL: "C", TZ: "UTC" };
  delete canonicalEnv.GZIP;
  delete canonicalEnv.TAR_OPTIONS;
  const tarVersion = run("tar", ["--version"], cwd, canonicalEnv);
  const common = ["-cf", tarPath, "-C", dirname(sourcePackage), "package"];
  if (tarVersion.includes("GNU tar")) {
    run(
      "tar",
      [
        "--sort=name",
        "--format=gnu",
        "--mtime=@0",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        ...common,
      ],
      cwd,
      canonicalEnv,
    );
  } else if (tarVersion.includes("bsdtar")) {
    const manifestPath = `${archivePath}.members`;
    writeFileSync(manifestPath, Buffer.from(`${archiveMembers.join("\0")}\0`), { mode: 0o600 });
    try {
      run(
        "tar",
        [
          "--format",
          "paxr",
          "--no-acls",
          "--no-fflags",
          "--no-xattrs",
          "--uid",
          "0",
          "--gid",
          "0",
          "--uname",
          "root",
          "--gname",
          "root",
          "--no-recursion",
          "--null",
          "-T",
          manifestPath,
          "-cf",
          tarPath,
          "-C",
          dirname(sourcePackage),
        ],
        cwd,
        canonicalEnv,
      );
    } finally {
      rmSync(manifestPath, { force: true });
    }
  } else {
    throw new Error(`unsupported tar implementation for canonical npm archive: ${tarVersion}`);
  }
  run("gzip", ["-n", "-f", tarPath], cwd, canonicalEnv);
  renameSync(`${tarPath}.gz`, archivePath);
}

export function buildRemediatedOpenClawArchive(request: BuildRequest): RemediatedArchive {
  const remediation = REMEDIATIONS[request.packageSpec];
  if (!remediation) {
    throw new Error(`No OpenClaw npm remediation is defined for ${request.packageSpec}`);
  }
  const env = {
    ...process.env,
    ...request.env,
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    npm_config_ignore_scripts: "true",
  };
  const workingDirectory = resolve(request.workingDirectory);
  mkdirSync(workingDirectory, { recursive: true, mode: 0o700 });
  const remediationRoot = mkdtempSync(join(workingDirectory, "openclaw-npm-remediation-"));
  const sourcePackage = extractArchive(
    resolve(request.archivePath),
    join(remediationRoot, "source"),
    remediationRoot,
    env,
  );
  if (remediation.kind === "core") {
    const fsSafeArchive = packReplacement(
      `@openclaw/fs-safe@${FS_SAFE_VERSION}`,
      FS_SAFE_INTEGRITY,
      FS_SAFE_TARBALL,
      remediationRoot,
      env,
    );
    const fsSafePackage = extractArchive(
      fsSafeArchive.archivePath,
      join(remediationRoot, "fs-safe"),
      remediationRoot,
      env,
    );
    const modelContextProtocolSdkArchive = packReplacement(
      `@modelcontextprotocol/sdk@${MODEL_CONTEXT_PROTOCOL_SDK_VERSION}`,
      MODEL_CONTEXT_PROTOCOL_SDK_INTEGRITY,
      MODEL_CONTEXT_PROTOCOL_SDK_TARBALL,
      remediationRoot,
      env,
    );
    const honoNodeServerArchive = packReplacement(
      `@hono/node-server@${HONO_NODE_SERVER_VERSION}`,
      HONO_NODE_SERVER_INTEGRITY,
      HONO_NODE_SERVER_TARBALL,
      remediationRoot,
      env,
    );
    const eventsourceParserArchive = packReplacement(
      `eventsource-parser@${EVENTSOURCE_PARSER_VERSION}`,
      EVENTSOURCE_PARSER_INTEGRITY,
      EVENTSOURCE_PARSER_TARBALL,
      remediationRoot,
      env,
    );
    const modelContextProtocolSdkPackage = extractArchive(
      modelContextProtocolSdkArchive.archivePath,
      join(remediationRoot, "modelcontextprotocol-sdk"),
      remediationRoot,
      env,
    );
    const honoNodeServerPackage = extractArchive(
      honoNodeServerArchive.archivePath,
      join(remediationRoot, "hono-node-server"),
      remediationRoot,
      env,
    );
    const eventsourceParserPackage = extractArchive(
      eventsourceParserArchive.archivePath,
      join(remediationRoot, "eventsource-parser"),
      remediationRoot,
      env,
    );
    requirePackageIdentity(
      readJson(join(eventsourceParserPackage, "package.json")),
      "eventsource-parser",
      EVENTSOURCE_PARSER_VERSION,
      "OpenClaw MCP SDK eventsource parser remediation package",
    );
    patchFsSafePackageGraph(fsSafePackage);
    patchModelContextProtocolPackageGraph(modelContextProtocolSdkPackage);
    copyReplacementPackage(
      fsSafePackage,
      join(sourcePackage, "node_modules", "@openclaw", "fs-safe"),
    );
    copyReplacementPackage(
      modelContextProtocolSdkPackage,
      join(sourcePackage, "node_modules", "@modelcontextprotocol", "sdk"),
    );
    copyReplacementPackage(
      honoNodeServerPackage,
      join(sourcePackage, "node_modules", "@hono", "node-server"),
    );
    copyReplacementPackage(
      eventsourceParserPackage,
      join(sourcePackage, "node_modules", "eventsource-parser"),
    );
    patchOpenClawCorePackageGraph(sourcePackage);
  } else if (remediation.kind === "otel-plugin") {
    const jaegerArchive = packReplacement(
      `@opentelemetry/propagator-jaeger@${OTEL_PROPAGATOR_JAEGER_VERSION}`,
      OTEL_PROPAGATOR_JAEGER_INTEGRITY,
      OTEL_PROPAGATOR_JAEGER_TARBALL,
      remediationRoot,
      env,
    );
    const coreArchive = packReplacement(
      `@opentelemetry/core@${OTEL_CORE_VERSION}`,
      OTEL_CORE_INTEGRITY,
      OTEL_CORE_TARBALL,
      remediationRoot,
      env,
    );
    const jaegerPackage = extractArchive(
      jaegerArchive.archivePath,
      join(remediationRoot, "otel-propagator-jaeger"),
      remediationRoot,
      env,
    );
    const corePackage = extractArchive(
      coreArchive.archivePath,
      join(remediationRoot, "otel-core"),
      remediationRoot,
      env,
    );
    const jaegerPackageJson = readJson(join(jaegerPackage, "package.json"));
    const corePackageJson = readJson(join(corePackage, "package.json"));
    requirePackageIdentity(
      jaegerPackageJson,
      "@opentelemetry/propagator-jaeger",
      OTEL_PROPAGATOR_JAEGER_VERSION,
      "OpenTelemetry Jaeger remediation package",
    );
    requirePackageIdentity(
      corePackageJson,
      "@opentelemetry/core",
      OTEL_CORE_VERSION,
      "OpenTelemetry core remediation package",
    );
    requireDependencyShape(
      jaegerPackageJson,
      { "@opentelemetry/core": OTEL_CORE_VERSION },
      "@opentelemetry/propagator-jaeger@2.9.0",
    );
    requireDependencyShape(
      corePackageJson,
      { "@opentelemetry/semantic-conventions": "^1.29.0" },
      "@opentelemetry/core@2.9.0",
    );
    patchOtelSdkNodePackageGraph(join(sourcePackage, "node_modules", "@opentelemetry", "sdk-node"));
    copyReplacementPackage(
      jaegerPackage,
      join(sourcePackage, "node_modules", "@opentelemetry", "propagator-jaeger"),
    );
    copyReplacementPackage(
      corePackage,
      join(
        sourcePackage,
        "node_modules",
        "@opentelemetry",
        "propagator-jaeger",
        "node_modules",
        "@opentelemetry",
        "core",
      ),
    );
    patchOpenClawOtelPluginPackageGraph(sourcePackage);
  } else {
    const axiosArchive = packReplacement(
      `axios@${AXIOS_VERSION}`,
      AXIOS_INTEGRITY,
      AXIOS_TARBALL,
      remediationRoot,
      env,
    );
    const httpsProxyAgentArchive = packReplacement(
      `https-proxy-agent@${HTTPS_PROXY_AGENT_VERSION}`,
      HTTPS_PROXY_AGENT_INTEGRITY,
      HTTPS_PROXY_AGENT_TARBALL,
      remediationRoot,
      env,
    );
    const agentBaseArchive = packReplacement(
      `agent-base@${AGENT_BASE_VERSION}`,
      AGENT_BASE_INTEGRITY,
      AGENT_BASE_TARBALL,
      remediationRoot,
      env,
    );
    const axiosPackage = extractArchive(
      axiosArchive.archivePath,
      join(remediationRoot, "axios"),
      remediationRoot,
      env,
    );
    const httpsProxyAgentPackage = extractArchive(
      httpsProxyAgentArchive.archivePath,
      join(remediationRoot, "https-proxy-agent"),
      remediationRoot,
      env,
    );
    const agentBasePackage = extractArchive(
      agentBaseArchive.archivePath,
      join(remediationRoot, "agent-base"),
      remediationRoot,
      env,
    );
    const axiosPackageJson = readJson(join(axiosPackage, "package.json"));
    const httpsProxyAgentPackageJson = readJson(join(httpsProxyAgentPackage, "package.json"));
    const agentBasePackageJson = readJson(join(agentBasePackage, "package.json"));
    requirePackageIdentity(axiosPackageJson, "axios", AXIOS_VERSION, "Axios remediation package");
    requirePackageIdentity(
      httpsProxyAgentPackageJson,
      "https-proxy-agent",
      HTTPS_PROXY_AGENT_VERSION,
      "Axios proxy remediation package",
    );
    requirePackageIdentity(
      agentBasePackageJson,
      "agent-base",
      AGENT_BASE_VERSION,
      "Axios agent-base remediation package",
    );
    requireDependencyShape(
      axiosPackageJson,
      {
        "follow-redirects": "^1.16.0",
        "form-data": "^4.0.5",
        "https-proxy-agent": "^5.0.1",
        "proxy-from-env": "^2.1.0",
      },
      "axios@1.18.0",
    );
    requireDependencyShape(
      httpsProxyAgentPackageJson,
      { "agent-base": "6", debug: "4" },
      "https-proxy-agent@5.0.1",
    );
    requireDependencyShape(agentBasePackageJson, { debug: "4" }, "agent-base@6.0.2");

    const axiosTarget = join(sourcePackage, "node_modules", "axios");
    copyReplacementPackage(axiosPackage, axiosTarget);
    copyReplacementPackage(
      httpsProxyAgentPackage,
      join(axiosTarget, "node_modules", "https-proxy-agent"),
    );
    copyReplacementPackage(
      agentBasePackage,
      join(axiosTarget, "node_modules", "https-proxy-agent", "node_modules", "agent-base"),
    );
    patchOpenClawPluginPackageGraph(sourcePackage, request.packageSpec);
  }

  const outputDirectory = join(remediationRoot, "output");
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const archivePath = join(outputDirectory, "openclaw-remediated.tgz");
  createCanonicalArchive(sourcePackage, archivePath, remediationRoot, env);
  validateArchiveMembers(archivePath, remediationRoot, env);
  const metadataIntegrity = hashPatchedMetadata(sourcePackage);
  const integrity = `sha512-${createHash("sha512").update(readFileSync(archivePath)).digest("base64")}`;
  const expectedPatchedMetadataIntegrity =
    request.expectedPatchedMetadataIntegrity ?? remediation.expectedPatchedMetadataIntegrity;
  if (metadataIntegrity !== expectedPatchedMetadataIntegrity) {
    throw new Error(
      `Remediated ${request.packageSpec} metadata integrity mismatch: expected ${expectedPatchedMetadataIntegrity}, got ${metadataIntegrity}`,
    );
  }
  return { archivePath, integrity, metadataIntegrity, remediated: true };
}

export function remediateReviewedOpenClawArchive(request: RemediationRequest): RemediatedArchive {
  const remediation = REMEDIATIONS[request.packageSpec];
  if (!remediation) {
    return {
      archivePath: resolve(request.archivePath),
      integrity: `sha512-${createHash("sha512")
        .update(readFileSync(resolve(request.archivePath)))
        .digest("base64")}`,
      remediated: false,
    };
  }
  return buildRemediatedOpenClawArchive({
    ...request,
    expectedPatchedMetadataIntegrity: remediation.expectedPatchedMetadataIntegrity,
  });
}

function isMainModule(): boolean {
  return process.argv[1] ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href : false;
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
    const remediated = remediateReviewedOpenClawArchive({
      archivePath: value("--archive"),
      packageSpec: value("--package-spec"),
      workingDirectory: value("--working-directory"),
    });
    console.log(remediated.archivePath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
