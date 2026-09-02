#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  cpSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { packReviewedNpmArchive } from "./reviewed-npm-archive.mts";

type JsonObject = Record<string, any>;

type Remediation = Readonly<{
  expectedPatchedMetadataIntegrity?: string;
  expectedPatchedTreeIntegrity?: string;
  kind: "axios" | "core" | "current-core" | "jaeger" | "legacy-core" | "undici";
  version: "2026.3.11" | "2026.6.10" | "2026.7.1";
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
    expectedPatchedTreeIntegrity?: string;
  }>;

export type RemediatedArchive = Readonly<
  | {
      archivePath: string;
      integrity: string;
      remediated: false;
    }
  | {
      archivePath: string;
      integrity: string;
      metadataIntegrity: string;
      remediated: true;
      treeIntegrity: string;
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
const TAR_VERSION = "7.5.21";
const TAR_INTEGRITY =
  "sha512-XdhtCvlMywwxpCW8YEq3lOXBJpUPTR2OHHcwLPO3HwsJqOHa2Ok/oJ7ruGzp+JrKoRPVCzJwAdEjqLW/vNRPHA==";
const TAR_TARBALL = "https://registry.npmjs.org/tar/-/tar-7.5.21.tgz";
const FS_SAFE_VERSION = "0.3.0";
const FS_SAFE_INTEGRITY =
  "sha512-uIBE441CIt1kIURoP9qRGKZ8LkGyfD9ZzeESjwAd29ZPWtghws/5GR3Pjb67jKdcJHP1I6roNXcvnhzAU7lHlA==";
const FS_SAFE_TARBALL = "https://registry.npmjs.org/@openclaw/fs-safe/-/fs-safe-0.3.0.tgz";
const BRACE_EXPANSION_VERSION = "5.0.7";
const BRACE_EXPANSION_INTEGRITY =
  "sha512-7oFy703dxfY3/NLxC1fh2SUCQ0H9rmAY+5EpDVfXjUTTs+HEwR2nYaqLv+GWcTsumwxPfiz6CzCNkwXwBUwqCA==";
const BRACE_EXPANSION_TARBALL =
  "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.7.tgz";
const CURRENT_BRACE_EXPANSION_VERSION = "5.0.9";
const CURRENT_BRACE_EXPANSION_INTEGRITY =
  "sha512-ScQ4IuvIEF1TMlP7Zt+vjJ//9zlPb2SDcxWxM3bk8s6t6GGdJ7KO1dCcTidOPJKePW30LE/2cT7wCyPho9/Wxg==";
const CURRENT_BRACE_EXPANSION_TARBALL =
  "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.9.tgz";
const CURRENT_FAST_URI_VERSION = "3.1.5";
const CURRENT_FAST_URI_INTEGRITY =
  "sha512-gHwA1O9LDIcKunMKhObS/HimwtehO1nPUECKAu5TpKgaO19fcWEl4bliWe1jWxVFvIXztJjjQ4L8XQ1EU9f7Jw==";
const CURRENT_FAST_URI_TARBALL = "https://registry.npmjs.org/fast-uri/-/fast-uri-3.1.5.tgz";
const CURRENT_UNDICI_VERSION = "8.10.0";
const CURRENT_UNDICI_INTEGRITY =
  "sha512-HvltHd7avK13QIw/oLe4qoOLyoVSoafqJ2jYOrtMRBkbYT31eiBQ8O0ehRKZiEZCMEyLFQNIADpgCWC5fALvYQ==";
const CURRENT_UNDICI_TARBALL = "https://registry.npmjs.org/undici/-/undici-8.10.0.tgz";
const CURRENT_IP_ADDRESS_VERSION = "10.3.1";
const CURRENT_IP_ADDRESS_INTEGRITY =
  "sha512-1e9d3kb97NHJTIJDZW9rKqW2h6+dFa50Dy0fpPSMQp2ADje5gvKsXmdiK6dwY5t76TaTt5+P5N1Y/LoToIxP6g==";
const CURRENT_IP_ADDRESS_TARBALL = "https://registry.npmjs.org/ip-address/-/ip-address-10.3.1.tgz";
const CURRENT_TAR_VERSION = "7.5.21";
const CURRENT_TAR_INTEGRITY =
  "sha512-XdhtCvlMywwxpCW8YEq3lOXBJpUPTR2OHHcwLPO3HwsJqOHa2Ok/oJ7ruGzp+JrKoRPVCzJwAdEjqLW/vNRPHA==";
const CURRENT_TAR_TARBALL = "https://registry.npmjs.org/tar/-/tar-7.5.21.tgz";
const JAEGER_PROPAGATOR_VERSION = "2.9.0";
const JAEGER_PROPAGATOR_INTEGRITY =
  "sha512-4mYGty27rYvSM0jtp1ZUOqd3LfVRCYg9H5G9OFzSx5HViYToU21MFhWfco7x1HwXr7ER8yGOiCIHZUwjPksc0Q==";
const JAEGER_PROPAGATOR_TARBALL =
  "https://registry.npmjs.org/@opentelemetry/propagator-jaeger/-/propagator-jaeger-2.9.0.tgz";
const OTEL_CORE_VERSION = "2.9.0";
const OTEL_CORE_INTEGRITY =
  "sha512-m2nckMT80NnmjTYSPjJQObBJ+8dgkoajEOUbznL8AHZ3T3yHRk2P7gI1PhEBc1+lOnrYE9UWrWHqJDsmqjmNbw==";
const OTEL_CORE_TARBALL = "https://registry.npmjs.org/@opentelemetry/core/-/core-2.9.0.tgz";

const REMEDIATIONS: Readonly<Record<string, Remediation>> = Object.freeze({
  "@openclaw/diagnostics-otel@2026.6.10": {
    expectedPatchedMetadataIntegrity:
      "sha512-ByLYBs3KXz3u0mPuj9DcP/xPTJNgQaLTPxazybhyIC1VjyftEmKQuoZufPZ8z8CjwBsOPm6NbjMQB2BfX36TTg==",
    kind: "jaeger",
    version: "2026.6.10",
  },
  "@openclaw/msteams@2026.6.10": {
    expectedPatchedMetadataIntegrity:
      "sha512-eTTIpA8HzcBwXBLt6UZDoFgOUmkRgIhcZFBOwg+5Jfgt8HDwtfPnqKo6vm2DdDdPMPhu08FbEzU5Gt3RoL5fIw==",
    kind: "axios",
    version: "2026.6.10",
  },
  "@openclaw/slack@2026.6.10": {
    expectedPatchedMetadataIntegrity:
      "sha512-AXllGzI+m33jUq3w1nCVXngLA1m9kH8c9XryHSoPzuVhGP6xwWpzgKl3yyfOMoIykN0GKcka59ZZbjEwkxFudQ==",
    kind: "axios",
    version: "2026.6.10",
  },
  // #7337: remove this branch only after a reviewed diagnostics release ships a safe SDK graph.
  "@openclaw/diagnostics-otel@2026.7.1": {
    expectedPatchedTreeIntegrity:
      "sha512-2qyDTRPqNs97jo/pAWWfxAkVZyCXYqui/IjrGf4eEfYop1eGN8qBMJ/Kp/bJ/V18RNnYpMxHi5ECFelekVxcAQ==",
    kind: "jaeger",
    version: "2026.7.1",
  },
  "@openclaw/discord@2026.7.1": {
    expectedPatchedTreeIntegrity:
      "sha512-w+F8FrRl0wPd0EN2RnLyu6yfixel7BT8Iex4wLLQDvfIac8rLhuksNpFU4uZa8W9wXgh47hguq0F9NSN0BZfOQ==",
    kind: "undici",
    version: "2026.7.1",
  },
  "@openclaw/msteams@2026.7.1": {
    expectedPatchedTreeIntegrity:
      "sha512-FL4l65gEbbwtDd9Ogr69+xBNzIfE4YS8Hib36G+kcmX+T0oB1zL+/qs6b4bJc+ygTsh60H3yqpFbXoQeN05JYQ==",
    kind: "axios",
    version: "2026.7.1",
  },
  "@openclaw/slack@2026.7.1": {
    expectedPatchedTreeIntegrity:
      "sha512-4ThnsNS+yBlFSkTaQn2xosxrDu1s0vrxcqka5QqFj+8dCEaTa9JVLRgNniYV/QNhO53wc7a2R5oQFElzYspT2w==",
    kind: "axios",
    version: "2026.7.1",
  },
  "openclaw@2026.6.10": {
    expectedPatchedMetadataIntegrity:
      "sha512-XMycUUV7gCzUYbjgwrglER0AQEtfuKUz6wyo4ilm/7nSSkLocYUYVkrJuBFYPW3no8Y5FW/1+2hWCssIyjxn3g==",
    kind: "core",
    version: "2026.6.10",
  },
  // openclaw/openclaw#113584: remove after a supported OpenClaw archive
  // publishes every corrected dependency identity in its manifest and shrinkwrap.
  "openclaw@2026.7.1": {
    expectedPatchedTreeIntegrity:
      "sha512-OfBP5yJPR5gdGnQ1LPtvSvrn3WoRT7+vi3KMsNGyXgwM8wpzJ174dfnJTLRtn6zSX9Vrp84uDn6YffkaLyNOVg==",
    kind: "current-core",
    version: "2026.7.1",
  },
  "openclaw@2026.3.11": {
    kind: "legacy-core",
    expectedPatchedMetadataIntegrity:
      "sha512-Yz/7GyAgLSPtJkijdUsVzxnjhATMPLRSFFMhl2H565aW7tReHZmuPeExBq0K4EEFkvg7zM2sFm2CP3f2oNw32Q==",
    version: "2026.3.11",
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
  run("tar", ["-xzf", archivePath, "-C", destination], cwd, env);
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

// The package tree lives below the caller's freshly created 0700 remediation
// root. Pin each regular file's type and contents to the same no-follow
// descriptor, and reject special entries after a nonblocking open.
export function hashPackageTree(packageDirectory: string): string {
  const hash = createHash("sha512");
  const visit = (directory: string, relativeDirectory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const absolutePath = join(directory, name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const descriptor = openSync(
        absolutePath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const openedStats = fstatSync(descriptor);
        if (openedStats.isDirectory()) {
          hash.update(`directory\0${relativePath}\0`);
          visit(absolutePath, relativePath);
        } else if (openedStats.isFile()) {
          hash.update(`file\0${relativePath}\0${openedStats.size}\0`);
          hash.update(readFileSync(descriptor));
          hash.update("\0");
        } else {
          throw new Error(`Remediated package tree has unsupported entry ${relativePath}`);
        }
      } finally {
        closeSync(descriptor);
      }
    }
  };
  visit(packageDirectory, "");
  return `sha512-${hash.digest("base64")}`;
}

function hashMetadataEntries(entries: readonly (readonly [string, Buffer])[]): string {
  const hash = createHash("sha512");
  for (const [name, contents] of entries) {
    hash.update(`${name}\0${contents.length}\0`);
    hash.update(contents);
    hash.update("\0");
  }
  return `sha512-${hash.digest("base64")}`;
}

// The retained 2026.6.10 remediation shipped with a narrower metadata digest.
// Keep enforcing that exact historical contract for those four identities while
// 2026.7.1 continues to use the stronger complete-tree digest above.
function hashPatchedMetadata(packageDirectory: string): string {
  const packageJson = readJson(join(packageDirectory, "package.json"));
  if (packageJson.name === "openclaw" && packageJson.version === "2026.3.11") {
    const bundledTarPackageJson = readJson(
      join(packageDirectory, "node_modules", "tar", "package.json"),
    );
    return hashMetadataEntries([
      [
        "legacy-openclaw-remediation.json",
        Buffer.from(
          `${JSON.stringify(
            {
              bundledDependencies: packageJson.bundledDependencies,
              bundledTar: {
                name: bundledTarPackageJson.name,
                version: bundledTarPackageJson.version,
              },
              name: packageJson.name,
              tarDependency: packageJson.dependencies?.tar,
              version: packageJson.version,
            },
            null,
            2,
          )}\n`,
        ),
      ],
    ]);
  }

  const names = ["package.json"];
  if (existsSync(join(packageDirectory, "npm-shrinkwrap.json"))) {
    names.push("npm-shrinkwrap.json");
  }
  const bundledFsSafePackageJson = "node_modules/@openclaw/fs-safe/package.json";
  if (existsSync(join(packageDirectory, bundledFsSafePackageJson))) {
    names.push(bundledFsSafePackageJson);
  }
  const diagnosticsMetadata = [
    "node_modules/@opentelemetry/sdk-node/package.json",
    "node_modules/@opentelemetry/propagator-jaeger/package.json",
    "node_modules/@opentelemetry/propagator-jaeger/node_modules/@opentelemetry/core/package.json",
  ];
  if (diagnosticsMetadata.every((name) => existsSync(join(packageDirectory, name)))) {
    names.push(...diagnosticsMetadata);
  }
  return hashMetadataEntries(
    names.map((name) => [name, readFileSync(join(packageDirectory, name))] as const),
  );
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

function requireCurrentUndiciReplacement(packageJson: JsonObject, label: string): void {
  requirePackageIdentity(packageJson, "undici", CURRENT_UNDICI_VERSION, label);
  if (
    (packageJson.dependencies !== undefined &&
      Object.keys(packageJson.dependencies).length !== 0) ||
    packageJson.engines?.node !== ">=22.19.0"
  ) {
    throw new Error(
      `undici@${CURRENT_UNDICI_VERSION} package contract changed; review the remediation before updating it`,
    );
  }
}

function requireCurrentIpAddressReplacement(packageJson: JsonObject): void {
  requirePackageIdentity(
    packageJson,
    "ip-address",
    CURRENT_IP_ADDRESS_VERSION,
    "OpenClaw ip-address remediation package",
  );
  if (
    (packageJson.dependencies !== undefined &&
      Object.keys(packageJson.dependencies).length !== 0) ||
    packageJson.engines?.node !== ">= 12"
  ) {
    throw new Error(
      `ip-address@${CURRENT_IP_ADDRESS_VERSION} package contract changed; review the remediation before updating it`,
    );
  }
}

function requireCurrentTarReplacement(packageJson: JsonObject): void {
  requirePackageIdentity(
    packageJson,
    "tar",
    CURRENT_TAR_VERSION,
    "OpenClaw tar remediation package",
  );
  requireDependencyShape(
    packageJson,
    {
      "@isaacs/fs-minipass": "^4.0.0",
      chownr: "^3.0.0",
      minipass: "^7.1.2",
      minizlib: "^3.1.0",
      yallist: "^5.0.0",
    },
    `tar@${CURRENT_TAR_VERSION}`,
  );
  if (packageJson.engines?.node !== ">=18" || packageJson.license !== "BlueOak-1.0.0") {
    throw new Error(
      `tar@${CURRENT_TAR_VERSION} package contract changed; review the remediation before updating it`,
    );
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
  const jszip = packages["node_modules/jszip"] as JsonObject | undefined;
  const minimatch = packages["node_modules/minimatch"] as JsonObject | undefined;
  if (root.dependencies?.tar !== "7.5.16" || tar?.version !== "7.5.16") {
    throw new Error("openclaw@2026.6.10 tar shrinkwrap state changed after review");
  }
  if (root.dependencies?.jszip !== "3.10.1" || jszip?.version !== "3.10.1") {
    throw new Error("openclaw@2026.6.10 jszip shrinkwrap state changed after review");
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
  packageJson.bundledDependencies = ["@openclaw/fs-safe"];
  root.dependencies.tar = TAR_VERSION;
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

export function patchCurrentOpenClawCorePackageGraph(packageDirectory: string): void {
  const packageJsonPath = join(packageDirectory, "package.json");
  const shrinkwrapPath = join(packageDirectory, "npm-shrinkwrap.json");
  const packageJson = readJson(packageJsonPath);
  requirePackageIdentity(packageJson, "openclaw", "2026.7.1", "OpenClaw core");
  if (
    packageJson.dependencies?.minimatch !== "10.2.5" ||
    packageJson.dependencies?.["@modelcontextprotocol/sdk"] !== "1.29.0" ||
    packageJson.dependencies?.["@openclaw/fs-safe"] !== "0.4.1" ||
    packageJson.dependencies?.tar !== "7.5.19" ||
    packageJson.dependencies?.undici !== "8.5.0" ||
    packageJson.dependencies?.["brace-expansion"] !== undefined ||
    packageJson.dependencies?.["fast-uri"] !== undefined ||
    packageJson.dependencies?.["ip-address"] !== undefined
  ) {
    throw new Error("openclaw@2026.7.1 dependency boundary changed after review");
  }

  const shrinkwrap = readJson(shrinkwrapPath);
  if (shrinkwrap.lockfileVersion !== 3 || !shrinkwrap.packages?.[""]) {
    throw new Error("openclaw@2026.7.1 must ship an npm lockfileVersion 3 shrinkwrap");
  }
  const packages = shrinkwrap.packages as JsonObject;
  const root = packages[""] as JsonObject;
  requirePackageIdentity(root, "openclaw", "2026.7.1", "OpenClaw shrinkwrap root");
  const braceExpansion = packages["node_modules/brace-expansion"] as JsonObject | undefined;
  const fastUri = packages["node_modules/fast-uri"] as JsonObject | undefined;
  const minimatch = packages["node_modules/minimatch"] as JsonObject | undefined;
  const ajv = packages["node_modules/ajv"] as JsonObject | undefined;
  const undici = packages["node_modules/undici"] as JsonObject | undefined;
  const ipAddress = packages["node_modules/ip-address"] as JsonObject | undefined;
  const expressRateLimit = packages["node_modules/express-rate-limit"] as JsonObject | undefined;
  const fsSafe = packages["node_modules/@openclaw/fs-safe"] as JsonObject | undefined;
  const tar = packages["node_modules/tar"] as JsonObject | undefined;
  if (
    braceExpansion?.version !== "5.0.7" ||
    braceExpansion.resolved !==
      "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.7.tgz" ||
    braceExpansion.integrity !==
      "sha512-7oFy703dxfY3/NLxC1fh2SUCQ0H9rmAY+5EpDVfXjUTTs+HEwR2nYaqLv+GWcTsumwxPfiz6CzCNkwXwBUwqCA==" ||
    braceExpansion.dependencies?.["balanced-match"] !== "^4.0.2" ||
    minimatch?.dependencies?.["brace-expansion"] !== "^5.0.5"
  ) {
    throw new Error("openclaw@2026.7.1 brace-expansion layout changed after review");
  }
  if (
    fastUri?.version !== "3.1.2" ||
    fastUri.resolved !== "https://registry.npmjs.org/fast-uri/-/fast-uri-3.1.2.tgz" ||
    fastUri.integrity !==
      "sha512-rVjf7ArG3LTk+FS6Yw81V1DLuZl1bRbNrev6Tmd/9RaroeeRRJhAt7jg/6YFxbvAQXUCavSoZhPPj6oOx+5KjQ==" ||
    ajv?.version !== "8.20.0" ||
    ajv.dependencies?.["fast-uri"] !== "^3.0.1"
  ) {
    throw new Error("openclaw@2026.7.1 fast-uri layout changed after review");
  }
  if (
    root.dependencies?.undici !== "8.5.0" ||
    undici?.version !== "8.5.0" ||
    undici.resolved !== "https://registry.npmjs.org/undici/-/undici-8.5.0.tgz" ||
    undici.integrity !==
      "sha512-xamtWoB1EshgjpmlXd7GGm2VfdDtw1+rD8uhry8pSNW3If6S8E0m2T2+orSKeZXEn/aPJMviCpDBA65WJt8zhg==" ||
    undici.engines?.node !== ">=22.19.0"
  ) {
    throw new Error("openclaw@2026.7.1 undici layout changed after review");
  }
  if (
    ipAddress?.version !== "10.2.0" ||
    ipAddress.resolved !== "https://registry.npmjs.org/ip-address/-/ip-address-10.2.0.tgz" ||
    ipAddress.integrity !==
      "sha512-/+S6j4E9AHvW9SWMSEY9Xfy66O5PWvVEJ08O0y5JGyEKQpojb0K0GKpz/v5HJ/G0vi3D2sjGK78119oXZeE0qA==" ||
    ipAddress.engines?.node !== ">= 12" ||
    expressRateLimit?.version !== "8.5.2" ||
    expressRateLimit.dependencies?.["ip-address"] !== "^10.2.0"
  ) {
    throw new Error("openclaw@2026.7.1 ip-address layout changed after review");
  }
  if (
    root.dependencies?.tar !== "7.5.19" ||
    tar?.version !== "7.5.19" ||
    tar.resolved !== "https://registry.npmjs.org/tar/-/tar-7.5.19.tgz" ||
    tar.integrity !==
      "sha512-4LeEWl96twnS2Q7Bz4MGqgazLqO+hJN63GZxXoIqh1T3VweYD997gbU1ItNsQafqqXTXd5WFyFdReLtwvRBNiw==" ||
    tar.dependencies?.["@isaacs/fs-minipass"] !== "^4.0.0" ||
    tar.dependencies?.chownr !== "^3.0.0" ||
    tar.dependencies?.minipass !== "^7.1.2" ||
    tar.dependencies?.minizlib !== "^3.1.0" ||
    tar.dependencies?.yallist !== "^5.0.0" ||
    Object.keys(tar.dependencies).length !== 5 ||
    tar.engines?.node !== ">=18" ||
    tar.license !== "BlueOak-1.0.0"
  ) {
    throw new Error("openclaw@2026.7.1 tar layout changed after review");
  }
  if (
    fsSafe?.version !== "0.4.1" ||
    fsSafe.resolved !== "https://registry.npmjs.org/@openclaw/fs-safe/-/fs-safe-0.4.1.tgz" ||
    fsSafe.integrity !==
      "sha512-hQi+BxO10KdRFlYUot1syC+hTaUnGeQNdqX5kwkKJig8CFq1tKsYJLPm+zkiiGsSKOprPAquQl/txejEhpKPgg==" ||
    fsSafe.license !== "MIT" ||
    fsSafe.engines?.node !== ">=22" ||
    fsSafe.optionalDependencies?.jszip !== "^3.10.1" ||
    fsSafe.optionalDependencies?.tar !== "7.5.19" ||
    Object.keys(fsSafe.optionalDependencies).length !== 2 ||
    packages["node_modules/@openclaw/fs-safe/node_modules/tar"] !== undefined
  ) {
    throw new Error("openclaw@2026.7.1 @openclaw/fs-safe tar layout changed after review");
  }

  packageJson.dependencies.tar = CURRENT_TAR_VERSION;
  packageJson.dependencies.undici = CURRENT_UNDICI_VERSION;
  root.dependencies.tar = CURRENT_TAR_VERSION;
  root.dependencies.undici = CURRENT_UNDICI_VERSION;
  braceExpansion.version = CURRENT_BRACE_EXPANSION_VERSION;
  braceExpansion.resolved = CURRENT_BRACE_EXPANSION_TARBALL;
  braceExpansion.integrity = CURRENT_BRACE_EXPANSION_INTEGRITY;
  fastUri.version = CURRENT_FAST_URI_VERSION;
  fastUri.resolved = CURRENT_FAST_URI_TARBALL;
  fastUri.integrity = CURRENT_FAST_URI_INTEGRITY;
  undici.version = CURRENT_UNDICI_VERSION;
  undici.resolved = CURRENT_UNDICI_TARBALL;
  undici.integrity = CURRENT_UNDICI_INTEGRITY;
  ipAddress.version = CURRENT_IP_ADDRESS_VERSION;
  ipAddress.resolved = CURRENT_IP_ADDRESS_TARBALL;
  ipAddress.integrity = CURRENT_IP_ADDRESS_INTEGRITY;
  fsSafe.optionalDependencies.tar = CURRENT_TAR_VERSION;
  tar.version = CURRENT_TAR_VERSION;
  tar.resolved = CURRENT_TAR_TARBALL;
  tar.integrity = CURRENT_TAR_INTEGRITY;
  writeJson(packageJsonPath, packageJson);
  writeJson(shrinkwrapPath, shrinkwrap);
}

export function patchOpenClawDiscordPackageGraph(packageDirectory: string): void {
  const packageJsonPath = join(packageDirectory, "package.json");
  const shrinkwrapPath = join(packageDirectory, "npm-shrinkwrap.json");
  const bundledUndiciPackageJsonPath = join(
    packageDirectory,
    "node_modules",
    "undici",
    "package.json",
  );
  const packageJson = readJson(packageJsonPath);
  requirePackageIdentity(packageJson, "@openclaw/discord", "2026.7.1", "OpenClaw Discord plugin");
  if (
    packageJson.dependencies?.undici !== "8.5.0" ||
    !Array.isArray(packageJson.bundledDependencies) ||
    !packageJson.bundledDependencies.includes("undici")
  ) {
    throw new Error("@openclaw/discord@2026.7.1 undici dependency changed after review");
  }
  const bundledUndiciPackageJson = readJson(bundledUndiciPackageJsonPath);
  requirePackageIdentity(
    bundledUndiciPackageJson,
    "undici",
    "8.5.0",
    "OpenClaw Discord bundled undici package",
  );
  if (
    (bundledUndiciPackageJson.dependencies !== undefined &&
      Object.keys(bundledUndiciPackageJson.dependencies).length !== 0) ||
    bundledUndiciPackageJson.engines?.node !== ">=22.19.0"
  ) {
    throw new Error("@openclaw/discord@2026.7.1 bundled undici layout changed after review");
  }

  const shrinkwrap = readJson(shrinkwrapPath);
  if (shrinkwrap.lockfileVersion !== 3 || !shrinkwrap.packages?.[""]) {
    throw new Error("@openclaw/discord@2026.7.1 must ship an npm lockfileVersion 3 shrinkwrap");
  }
  const packages = shrinkwrap.packages as JsonObject;
  const root = packages[""] as JsonObject;
  const undici = packages["node_modules/undici"] as JsonObject | undefined;
  requirePackageIdentity(root, "@openclaw/discord", "2026.7.1", "OpenClaw Discord shrinkwrap root");
  if (
    root.dependencies?.undici !== "8.5.0" ||
    undici?.version !== "8.5.0" ||
    undici.resolved !== "https://registry.npmjs.org/undici/-/undici-8.5.0.tgz" ||
    undici.integrity !==
      "sha512-xamtWoB1EshgjpmlXd7GGm2VfdDtw1+rD8uhry8pSNW3If6S8E0m2T2+orSKeZXEn/aPJMviCpDBA65WJt8zhg==" ||
    undici.engines?.node !== ">=22.19.0"
  ) {
    throw new Error("@openclaw/discord@2026.7.1 undici layout changed after review");
  }

  packageJson.dependencies.undici = CURRENT_UNDICI_VERSION;
  root.dependencies.undici = CURRENT_UNDICI_VERSION;
  undici.version = CURRENT_UNDICI_VERSION;
  undici.resolved = CURRENT_UNDICI_TARBALL;
  undici.integrity = CURRENT_UNDICI_INTEGRITY;
  writeJson(packageJsonPath, packageJson);
  writeJson(shrinkwrapPath, shrinkwrap);
}

export function patchLegacyOpenClawCorePackageGraph(packageDirectory: string): void {
  const packageJsonPath = join(packageDirectory, "package.json");
  const bundledTarPackageJsonPath = join(packageDirectory, "node_modules", "tar", "package.json");
  const packageJson = readJson(packageJsonPath);
  requirePackageIdentity(packageJson, "openclaw", "2026.3.11", "Legacy OpenClaw core");
  if (packageJson.dependencies?.tar !== "7.5.11") {
    throw new Error("openclaw@2026.3.11 must declare reviewed tar@7.5.11 before remediation");
  }
  if (packageJson.bundledDependencies !== undefined) {
    throw new Error("openclaw@2026.3.11 unexpectedly declares bundled dependencies");
  }
  if (existsSync(join(packageDirectory, "npm-shrinkwrap.json"))) {
    throw new Error("openclaw@2026.3.11 unexpectedly ships an npm shrinkwrap");
  }
  if (!existsSync(bundledTarPackageJsonPath)) {
    throw new Error("openclaw@2026.3.11 remediation requires the reviewed bundled tar package");
  }
  requirePackageIdentity(
    readJson(bundledTarPackageJsonPath),
    "tar",
    TAR_VERSION,
    "Legacy OpenClaw bundled tar remediation",
  );

  packageJson.dependencies.tar = TAR_VERSION;
  packageJson.bundledDependencies = ["tar"];
  writeJson(packageJsonPath, packageJson);
}

export function patchOpenClawDiagnosticsPackageGraph(packageDirectory: string): void {
  const packageSpec = "@openclaw/diagnostics-otel@2026.6.10";
  const packageJsonPath = join(packageDirectory, "package.json");
  const shrinkwrapPath = join(packageDirectory, "npm-shrinkwrap.json");
  const sdkPackageJsonPath = join(
    packageDirectory,
    "node_modules",
    "@opentelemetry",
    "sdk-node",
    "package.json",
  );
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
    throw new Error(`${packageSpec} SDK bundle changed; review the remediation`);
  }

  const shrinkwrap = readJson(shrinkwrapPath);
  if (shrinkwrap.lockfileVersion !== 3 || !shrinkwrap.packages?.[""]) {
    throw new Error(`${packageSpec} must ship an npm lockfileVersion 3 shrinkwrap`);
  }
  const packages = shrinkwrap.packages as JsonObject;
  const sdk = packages["node_modules/@opentelemetry/sdk-node"] as JsonObject | undefined;
  const jaeger = packages["node_modules/@opentelemetry/propagator-jaeger"] as
    | JsonObject
    | undefined;
  const nestedCoreKey =
    "node_modules/@opentelemetry/propagator-jaeger/node_modules/@opentelemetry/core";
  if (
    sdk?.version !== "0.219.0" ||
    sdk.dependencies?.["@opentelemetry/propagator-jaeger"] !== "2.8.0" ||
    jaeger?.version !== "2.8.0" ||
    jaeger.dependencies?.["@opentelemetry/core"] !== "2.8.0" ||
    packages[nestedCoreKey] !== undefined
  ) {
    throw new Error(`${packageSpec} Jaeger graph changed; review the remediation`);
  }

  const sdkPackageJson = readJson(sdkPackageJsonPath);
  requirePackageIdentity(
    sdkPackageJson,
    "@opentelemetry/sdk-node",
    "0.219.0",
    "bundled OpenTelemetry SDK",
  );
  if (sdkPackageJson.dependencies?.["@opentelemetry/propagator-jaeger"] !== "2.8.0") {
    throw new Error(
      "@opentelemetry/sdk-node@0.219.0 Jaeger dependency changed; review the remediation",
    );
  }

  sdk.dependencies["@opentelemetry/propagator-jaeger"] = JAEGER_PROPAGATOR_VERSION;
  sdkPackageJson.dependencies["@opentelemetry/propagator-jaeger"] = JAEGER_PROPAGATOR_VERSION;
  packages["node_modules/@opentelemetry/propagator-jaeger"] = {
    version: JAEGER_PROPAGATOR_VERSION,
    resolved: JAEGER_PROPAGATOR_TARBALL,
    integrity: JAEGER_PROPAGATOR_INTEGRITY,
    license: "Apache-2.0",
    dependencies: { "@opentelemetry/core": OTEL_CORE_VERSION },
    engines: { node: "^18.19.0 || >=20.6.0" },
    peerDependencies: { "@opentelemetry/api": ">=1.0.0 <1.10.0" },
  };
  packages[nestedCoreKey] = {
    version: OTEL_CORE_VERSION,
    resolved: OTEL_CORE_TARBALL,
    integrity: OTEL_CORE_INTEGRITY,
    license: "Apache-2.0",
    dependencies: { "@opentelemetry/semantic-conventions": "^1.29.0" },
    engines: { node: "^18.19.0 || >=20.6.0" },
    peerDependencies: { "@opentelemetry/api": ">=1.0.0 <1.10.0" },
  };

  writeJson(sdkPackageJsonPath, sdkPackageJson);
  writeJson(packageJsonPath, packageJson);
  writeJson(shrinkwrapPath, shrinkwrap);
}

export function patchOpenClawDiagnosticsOtelPackageGraph(packageDirectory: string): void {
  const packageSpec = "@openclaw/diagnostics-otel@2026.7.1";
  const packageJsonPath = join(packageDirectory, "package.json");
  const shrinkwrapPath = join(packageDirectory, "npm-shrinkwrap.json");
  const packageJson = readJson(packageJsonPath);
  requirePackageIdentity(packageJson, "@openclaw/diagnostics-otel", "2026.7.1", "OpenClaw plugin");

  const shrinkwrap = readJson(shrinkwrapPath);
  if (shrinkwrap.lockfileVersion !== 3 || !shrinkwrap.packages?.[""]) {
    throw new Error(`${packageSpec} must ship an npm lockfileVersion 3 shrinkwrap`);
  }
  const sdkKey = "node_modules/@opentelemetry/sdk-node";
  const sdk = shrinkwrap.packages[sdkKey] as JsonObject | undefined;
  if (
    sdk?.version !== "0.219.0" ||
    sdk.dependencies?.["@opentelemetry/propagator-jaeger"] !== "2.8.0"
  ) {
    throw new Error(
      `${packageSpec} must resolve ${sdkKey} with Jaeger propagator 2.8.0 before remediation`,
    );
  }
  sdk.dependencies["@opentelemetry/propagator-jaeger"] = JAEGER_PROPAGATOR_VERSION;

  const sdkPackageJsonPath = join(packageDirectory, sdkKey, "package.json");
  const sdkPackageJson = readJson(sdkPackageJsonPath);
  requirePackageIdentity(sdkPackageJson, "@opentelemetry/sdk-node", "0.219.0", "Bundled SDK");
  if (sdkPackageJson.dependencies?.["@opentelemetry/propagator-jaeger"] !== "2.8.0") {
    throw new Error(`${packageSpec} bundled SDK Jaeger dependency changed before remediation`);
  }
  sdkPackageJson.dependencies["@opentelemetry/propagator-jaeger"] = JAEGER_PROPAGATOR_VERSION;

  const jaegerKey = "node_modules/@opentelemetry/propagator-jaeger";
  const jaeger = shrinkwrap.packages[jaegerKey] as JsonObject | undefined;
  if (jaeger?.version !== "2.8.0" || jaeger.dependencies?.["@opentelemetry/core"] !== "2.8.0") {
    throw new Error(`${packageSpec} must resolve ${jaegerKey} to 2.8.0 before remediation`);
  }
  shrinkwrap.packages[jaegerKey] = {
    version: JAEGER_PROPAGATOR_VERSION,
    resolved: JAEGER_PROPAGATOR_TARBALL,
    integrity: JAEGER_PROPAGATOR_INTEGRITY,
    license: "Apache-2.0",
    dependencies: { "@opentelemetry/core": OTEL_CORE_VERSION },
    engines: { node: "^18.19.0 || >=20.6.0" },
    peerDependencies: { "@opentelemetry/api": ">=1.0.0 <1.10.0" },
  };

  const coreKey = `${jaegerKey}/node_modules/@opentelemetry/core`;
  if (shrinkwrap.packages[coreKey]) {
    throw new Error(`${packageSpec} already has a nested Jaeger core dependency`);
  }
  shrinkwrap.packages[coreKey] = {
    version: OTEL_CORE_VERSION,
    resolved: OTEL_CORE_TARBALL,
    integrity: OTEL_CORE_INTEGRITY,
    license: "Apache-2.0",
    dependencies: { "@opentelemetry/semantic-conventions": "^1.29.0" },
    engines: { node: "^18.19.0 || >=20.6.0" },
    peerDependencies: { "@opentelemetry/api": ">=1.0.0 <1.10.0" },
  };

  writeJson(sdkPackageJsonPath, sdkPackageJson);
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
  const localArchiveDirectory = env.NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR;
  if (localArchiveDirectory) {
    const archiveRoot = resolve(localArchiveDirectory);
    const archiveName = basename(new URL(tarballUrl).pathname);
    const archivePath = resolve(archiveRoot, archiveName);
    if (!archivePath.startsWith(`${archiveRoot}${sep}`)) {
      throw new Error(`OpenClaw npm remediation archive escaped its reviewed root: ${packageSpec}`);
    }
    const descriptor = openSync(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const archive = fstatSync(descriptor);
      if (!archive.isFile()) {
        throw new Error(`OpenClaw npm remediation archive is not a regular file: ${packageSpec}`);
      }
      const actualIntegrity = `sha512-${createHash("sha512").update(readFileSync(descriptor)).digest("base64")}`;
      if (actualIntegrity !== expectedIntegrity) {
        throw new Error(
          `OpenClaw npm remediation archive integrity mismatch for ${packageSpec}\nExpected: ${expectedIntegrity}\nActual:   ${actualIntegrity}`,
        );
      }
    } finally {
      closeSync(descriptor);
    }
    return { archivePath, rootDirectory: archiveRoot };
  }
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

export function buildRemediatedOpenClawPluginArchive(
  request: BuildRequest,
): Extract<RemediatedArchive, { remediated: true }> {
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
    patchFsSafePackageGraph(fsSafePackage);
    copyReplacementPackage(
      fsSafePackage,
      join(sourcePackage, "node_modules", "@openclaw", "fs-safe"),
    );
    patchOpenClawCorePackageGraph(sourcePackage);
  } else if (remediation.kind === "current-core") {
    const braceExpansionArchive = packReplacement(
      `brace-expansion@${CURRENT_BRACE_EXPANSION_VERSION}`,
      CURRENT_BRACE_EXPANSION_INTEGRITY,
      CURRENT_BRACE_EXPANSION_TARBALL,
      remediationRoot,
      env,
    );
    const fastUriArchive = packReplacement(
      `fast-uri@${CURRENT_FAST_URI_VERSION}`,
      CURRENT_FAST_URI_INTEGRITY,
      CURRENT_FAST_URI_TARBALL,
      remediationRoot,
      env,
    );
    const undiciArchive = packReplacement(
      `undici@${CURRENT_UNDICI_VERSION}`,
      CURRENT_UNDICI_INTEGRITY,
      CURRENT_UNDICI_TARBALL,
      remediationRoot,
      env,
    );
    const ipAddressArchive = packReplacement(
      `ip-address@${CURRENT_IP_ADDRESS_VERSION}`,
      CURRENT_IP_ADDRESS_INTEGRITY,
      CURRENT_IP_ADDRESS_TARBALL,
      remediationRoot,
      env,
    );
    const tarArchive = packReplacement(
      `tar@${CURRENT_TAR_VERSION}`,
      CURRENT_TAR_INTEGRITY,
      CURRENT_TAR_TARBALL,
      remediationRoot,
      env,
    );
    const braceExpansionPackage = extractArchive(
      braceExpansionArchive.archivePath,
      join(remediationRoot, "brace-expansion"),
      remediationRoot,
      env,
    );
    const fastUriPackage = extractArchive(
      fastUriArchive.archivePath,
      join(remediationRoot, "fast-uri"),
      remediationRoot,
      env,
    );
    const undiciPackage = extractArchive(
      undiciArchive.archivePath,
      join(remediationRoot, "undici"),
      remediationRoot,
      env,
    );
    const ipAddressPackage = extractArchive(
      ipAddressArchive.archivePath,
      join(remediationRoot, "ip-address"),
      remediationRoot,
      env,
    );
    const tarPackage = extractArchive(
      tarArchive.archivePath,
      join(remediationRoot, "tar"),
      remediationRoot,
      env,
    );
    const braceExpansionPackageJson = readJson(join(braceExpansionPackage, "package.json"));
    const fastUriPackageJson = readJson(join(fastUriPackage, "package.json"));
    const undiciPackageJson = readJson(join(undiciPackage, "package.json"));
    requirePackageIdentity(
      braceExpansionPackageJson,
      "brace-expansion",
      CURRENT_BRACE_EXPANSION_VERSION,
      "OpenClaw brace-expansion remediation package",
    );
    requireDependencyShape(
      braceExpansionPackageJson,
      { "balanced-match": "^4.0.2" },
      `brace-expansion@${CURRENT_BRACE_EXPANSION_VERSION}`,
    );
    requirePackageIdentity(
      fastUriPackageJson,
      "fast-uri",
      CURRENT_FAST_URI_VERSION,
      "OpenClaw fast-uri remediation package",
    );
    if (
      fastUriPackageJson.dependencies !== undefined &&
      Object.keys(fastUriPackageJson.dependencies).length !== 0
    ) {
      throw new Error(
        `fast-uri@${CURRENT_FAST_URI_VERSION} dependency graph changed; review the remediation before updating it`,
      );
    }
    requireCurrentUndiciReplacement(undiciPackageJson, "OpenClaw undici remediation package");
    requireCurrentIpAddressReplacement(readJson(join(ipAddressPackage, "package.json")));
    requireCurrentTarReplacement(readJson(join(tarPackage, "package.json")));
    patchCurrentOpenClawCorePackageGraph(sourcePackage);
  } else if (remediation.kind === "undici") {
    const undiciArchive = packReplacement(
      `undici@${CURRENT_UNDICI_VERSION}`,
      CURRENT_UNDICI_INTEGRITY,
      CURRENT_UNDICI_TARBALL,
      remediationRoot,
      env,
    );
    const undiciPackage = extractArchive(
      undiciArchive.archivePath,
      join(remediationRoot, "undici"),
      remediationRoot,
      env,
    );
    requireCurrentUndiciReplacement(
      readJson(join(undiciPackage, "package.json")),
      "OpenClaw Discord undici remediation package",
    );
    patchOpenClawDiscordPackageGraph(sourcePackage);
    copyReplacementPackage(undiciPackage, join(sourcePackage, "node_modules", "undici"));
  } else if (remediation.kind === "legacy-core") {
    const bundledTarPath = join(sourcePackage, "node_modules", "tar");
    if (existsSync(bundledTarPath)) {
      throw new Error("openclaw@2026.3.11 unexpectedly bundles tar before remediation");
    }
    const tarArchive = packReplacement(
      `tar@${TAR_VERSION}`,
      TAR_INTEGRITY,
      TAR_TARBALL,
      remediationRoot,
      env,
    );
    const tarPackage = extractArchive(
      tarArchive.archivePath,
      join(remediationRoot, "tar"),
      remediationRoot,
      env,
    );
    requirePackageIdentity(
      readJson(join(tarPackage, "package.json")),
      "tar",
      TAR_VERSION,
      "Legacy OpenClaw tar remediation package",
    );
    copyReplacementPackage(tarPackage, bundledTarPath);
    patchLegacyOpenClawCorePackageGraph(sourcePackage);
  } else if (remediation.kind === "axios") {
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
  } else {
    const jaegerArchive = packReplacement(
      `@opentelemetry/propagator-jaeger@${JAEGER_PROPAGATOR_VERSION}`,
      JAEGER_PROPAGATOR_INTEGRITY,
      JAEGER_PROPAGATOR_TARBALL,
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
      join(remediationRoot, "propagator-jaeger"),
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
      JAEGER_PROPAGATOR_VERSION,
      "Jaeger remediation package",
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
      `@opentelemetry/propagator-jaeger@${JAEGER_PROPAGATOR_VERSION}`,
    );
    requireDependencyShape(
      corePackageJson,
      { "@opentelemetry/semantic-conventions": "^1.29.0" },
      `@opentelemetry/core@${OTEL_CORE_VERSION}`,
    );

    const jaegerTarget = join(sourcePackage, "node_modules", "@opentelemetry", "propagator-jaeger");
    copyReplacementPackage(jaegerPackage, jaegerTarget);
    copyReplacementPackage(
      corePackage,
      join(jaegerTarget, "node_modules", "@opentelemetry", "core"),
    );
    if (remediation.version === "2026.6.10") {
      patchOpenClawDiagnosticsPackageGraph(sourcePackage);
    } else {
      patchOpenClawDiagnosticsOtelPackageGraph(sourcePackage);
    }
  }

  const outputDirectory = join(remediationRoot, "output");
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const packedJson = run(
    "npm",
    ["pack", ".", "--pack-destination", outputDirectory, "--ignore-scripts", "--json"],
    sourcePackage,
    env,
  );
  const packed = JSON.parse(packedJson);
  if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0]?.filename !== "string") {
    throw new Error(`npm pack returned an invalid remediation result for ${request.packageSpec}`);
  }
  const archivePath = resolve(outputDirectory, basename(packed[0].filename));
  validateArchiveMembers(archivePath, remediationRoot, env);
  const packedPackage = extractArchive(
    archivePath,
    join(remediationRoot, "packed-output"),
    remediationRoot,
    env,
  );
  const metadataIntegrity = hashPatchedMetadata(sourcePackage);
  const treeIntegrity = hashPackageTree(packedPackage);
  const integrity = `sha512-${createHash("sha512").update(readFileSync(archivePath)).digest("base64")}`;
  const expectedPatchedMetadataIntegrity =
    request.expectedPatchedMetadataIntegrity ?? remediation.expectedPatchedMetadataIntegrity;
  if (expectedPatchedMetadataIntegrity && metadataIntegrity !== expectedPatchedMetadataIntegrity) {
    throw new Error(
      `Remediated ${request.packageSpec} metadata integrity mismatch: expected ${expectedPatchedMetadataIntegrity}, got ${metadataIntegrity}`,
    );
  }
  const expectedPatchedTreeIntegrity =
    request.expectedPatchedTreeIntegrity ?? remediation.expectedPatchedTreeIntegrity;
  if (expectedPatchedTreeIntegrity && treeIntegrity !== expectedPatchedTreeIntegrity) {
    throw new Error(
      `Remediated ${request.packageSpec} tree integrity mismatch: expected ${expectedPatchedTreeIntegrity}, got ${treeIntegrity}`,
    );
  }
  return { archivePath, integrity, metadataIntegrity, remediated: true, treeIntegrity };
}

// Compatibility export for the 2026.6.10 remediation tests and callers merged
// from main. Both names use the same version-dispatched implementation.
export function buildRemediatedOpenClawArchive(
  request: BuildRequest,
): Extract<RemediatedArchive, { remediated: true }> {
  return buildRemediatedOpenClawPluginArchive(request);
}

export function remediateReviewedOpenClawPluginArchive(
  request: RemediationRequest,
): RemediatedArchive {
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
  return buildRemediatedOpenClawPluginArchive({
    ...request,
    expectedPatchedMetadataIntegrity: remediation.expectedPatchedMetadataIntegrity,
    expectedPatchedTreeIntegrity: remediation.expectedPatchedTreeIntegrity,
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
    console.log(
      JSON.stringify(
        remediateReviewedOpenClawPluginArchive({
          archivePath: value("--archive"),
          packageSpec: value("--package-spec"),
          workingDirectory: value("--working-directory"),
        }),
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
