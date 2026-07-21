// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  closeSync,
  constants,
  cpSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;

type PackagePin = {
  name: string;
  version: string;
  integrity: string;
  tarball: string;
};

type HistoricalLayout = {
  shrinkwrap: boolean;
  replacements: Record<string, { observed: string; pin: string; lockObserved?: string }>;
  rootDirect: Record<string, string>;
  dependencyOverrides: Record<
    string,
    Record<string, { published: string; observed: string; target: string }>
  >;
  obsoletePackages: Record<
    string,
    {
      observed: string;
      owner: string;
      ownerField: "dependencies" | "optionalDependencies";
      ownerSpec: string;
      lockObserved?: string;
    }
  >;
};

export const CORE_SECURITY_PINS: Record<string, PackagePin> = {
  "pi-agent-core": {
    name: "@earendil-works/pi-agent-core",
    version: "0.79.0",
    integrity:
      "sha512-jQOtYjRGZ7+XC/olw9euLd2V03vkAPO8u0sSnQoLbyOQZz66dEBZrklTESk34Sf3AaeBSua28wjZR48ch1aXJQ==",
    tarball: "https://registry.npmjs.org/@earendil-works/pi-agent-core/-/pi-agent-core-0.79.0.tgz",
  },
  "pi-ai": {
    name: "@earendil-works/pi-ai",
    version: "0.79.0",
    integrity:
      "sha512-D/2aDoe9vcCbqAztALQcKkdqXGuaQcqAzLm8LfUhNaorwoIHkwnaAuDVlo+OkF5clpEwS8Z1bk2o8NiSrwEdsA==",
    tarball: "https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-0.79.0.tgz",
  },
  "pi-coding-agent": {
    name: "@earendil-works/pi-coding-agent",
    version: "0.79.0",
    integrity:
      "sha512-pZoXk65vFR3dAzzmPNWEX61aHnT6+BaVhTyFDQAs1DyumaMeWpvzRV9ZrGxqlbVLwhrq+0LnXbaqDAFkhe2+MQ==",
    tarball:
      "https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.79.0.tgz",
  },
  "pi-tui": {
    name: "@earendil-works/pi-tui",
    version: "0.79.0",
    integrity:
      "sha512-qAQWMruW7YKbk2hPcTD4INtXfvIySXifbPQ+mFY5j3J8yf2tfElkh+gGPuBvgPKPT0z9WiAkd7iySCuQq0txuQ==",
    tarball: "https://registry.npmjs.org/@earendil-works/pi-tui/-/pi-tui-0.79.0.tgz",
  },
  "body-parser": {
    name: "body-parser",
    version: "2.3.0",
    integrity:
      "sha512-2cGmJupaNgg+QUwVLAucDuWuoMZ6EX9iHDRswZ5lsNYEmwPaRknMPCLZz07yTzVq/83p4o/wzbDZbBrTvGGTIw==",
    tarball: "https://registry.npmjs.org/body-parser/-/body-parser-2.3.0.tgz",
  },
  "brace-expansion": {
    name: "brace-expansion",
    version: "5.0.7",
    integrity:
      "sha512-7oFy703dxfY3/NLxC1fh2SUCQ0H9rmAY+5EpDVfXjUTTs+HEwR2nYaqLv+GWcTsumwxPfiz6CzCNkwXwBUwqCA==",
    tarball: "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.7.tgz",
  },
  hono: {
    name: "hono",
    version: "4.12.30",
    integrity:
      "sha512-emn+JoJjrN9YTpRDS5it/UI2SO9BAE37T6I3d963RxcZ81G9A4pr2SZTEiiaiKbzx+NKRg5BZ89fCL7gCJCUog==",
    tarball: "https://registry.npmjs.org/hono/-/hono-4.12.30.tgz",
  },
  "linkify-it": {
    name: "linkify-it",
    version: "5.0.2",
    integrity:
      "sha512-ONTm2jCMAVZjgQa/Fy1kScXsuOoF5NPTsoFBdE1KVIZ2vAh/r9+Bqo+0jINCBYnavTPQZz38QzFTme79ENoN3Q==",
    tarball: "https://registry.npmjs.org/linkify-it/-/linkify-it-5.0.2.tgz",
  },
  "markdown-it": {
    name: "markdown-it",
    version: "14.3.0",
    integrity:
      "sha512-RCEsPjR+sr0x+AuYp601tKTkgFG4YEPLCzHST3cQ/fhlJkqAkz1L2/Qbp1j9qw5SBwQHFBoW8+hoN5xssOF0Tw==",
    tarball: "https://registry.npmjs.org/markdown-it/-/markdown-it-14.3.0.tgz",
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
  ws: {
    name: "ws",
    version: "8.21.1",
    integrity:
      "sha512-+0NTnW77fFN/DjQi6k/Sq/Yvk4Sgajw7urW8V+asjXnRgDs9gyGkdb7EzgfhA4goXsRIZKE28fzIXBHEzhuiWw==",
    tarball: "https://registry.npmjs.org/ws/-/ws-8.21.1.tgz",
  },
  "content-type": {
    name: "content-type",
    version: "2.0.0",
    integrity:
      "sha512-j/O/d7GcZCyNl7/hwZAb606rzqkyvaDctLmckbxLzHvFBzTJHuGEdodATcP3yIRoDrLHkIATJuvzbFlp/ki2cQ==",
    tarball: "https://registry.npmjs.org/content-type/-/content-type-2.0.0.tgz",
  },
  clipboard: {
    name: "@mariozechner/clipboard",
    version: "0.3.9",
    integrity:
      "sha512-ABnA53mdfkGZwOFUdZNv2S0CWGO/EIuPj8Vv9xmBFmSYg/qFc7ihO6q5FcQjvoE67kZpWkEc4AhD6B/os04yuA==",
    tarball: "https://registry.npmjs.org/@mariozechner/clipboard/-/clipboard-0.3.9.tgz",
  },
};

const HISTORICAL_LAYOUTS = new Map<string, HistoricalLayout>([
  [
    "2026.5.18",
    {
      shrinkwrap: false,
      replacements: {
        "@earendil-works/pi-agent-core": { observed: "0.75.1", pin: "pi-agent-core" },
        "@earendil-works/pi-ai": { observed: "0.75.1", pin: "pi-ai" },
        "@earendil-works/pi-coding-agent": { observed: "0.75.1", pin: "pi-coding-agent" },
        "@earendil-works/pi-tui": { observed: "0.75.1", pin: "pi-tui" },
        "@mariozechner/clipboard": { observed: "0.3.6", pin: "clipboard" },
        "body-parser": { observed: "2.2.2", pin: "body-parser" },
        "brace-expansion": { observed: "5.0.6", pin: "brace-expansion" },
        hono: { observed: "4.12.22", pin: "hono" },
        "linkify-it": { observed: "5.0.0", pin: "linkify-it" },
        "markdown-it": { observed: "14.1.1", pin: "markdown-it" },
        protobufjs: { observed: "7.6.1", pin: "protobufjs-7" },
        undici: { observed: "8.3.0", pin: "undici" },
        ws: { observed: "8.20.1", pin: "ws" },
      },
      rootDirect: {
        "@earendil-works/pi-agent-core": "0.75.1",
        "@earendil-works/pi-ai": "0.75.1",
        "@earendil-works/pi-coding-agent": "0.75.1",
        "@earendil-works/pi-tui": "0.75.1",
        "markdown-it": "14.1.1",
        undici: "8.3.0",
        ws: "8.20.1",
      },
      dependencyOverrides: {
        "@earendil-works/pi-ai": {
          "@aws-sdk/client-bedrock-runtime": {
            published: "3.1048.0",
            observed: "3.1053.0",
            target: "3.1053.0",
          },
          "@google/genai": { published: "1.52.0", observed: "2.3.0", target: "2.3.0" },
          "@smithy/node-http-handler": {
            published: "4.7.3",
            observed: "4.7.4",
            target: "4.7.4",
          },
          openai: { published: "6.26.0", observed: "6.38.0", target: "6.38.0" },
        },
        "@earendil-works/pi-coding-agent": {
          undici: { published: "8.3.0", observed: "8.3.0", target: "8.5.0" },
        },
      },
      obsoletePackages: {
        "@protobufjs/inquire": {
          observed: "1.1.2",
          owner: "protobufjs",
          ownerField: "dependencies",
          ownerSpec: "^1.1.2",
        },
        koffi: {
          observed: "2.16.2",
          owner: "@earendil-works/pi-tui",
          ownerField: "optionalDependencies",
          ownerSpec: "^2.9.0",
        },
      },
    },
  ],
  [
    "2026.5.22",
    {
      shrinkwrap: true,
      replacements: {
        "@earendil-works/pi-agent-core": {
          observed: "0.75.4",
          pin: "pi-agent-core",
          lockObserved: "0.75.4",
        },
        "@earendil-works/pi-ai": {
          observed: "0.75.4",
          pin: "pi-ai",
          lockObserved: "0.75.4",
        },
        "@earendil-works/pi-coding-agent": {
          observed: "0.75.4",
          pin: "pi-coding-agent",
          lockObserved: "0.75.4",
        },
        "@earendil-works/pi-tui": {
          observed: "0.75.4",
          pin: "pi-tui",
          lockObserved: "0.75.4",
        },
        "@mariozechner/clipboard": {
          observed: "0.3.6",
          pin: "clipboard",
          lockObserved: "0.3.6",
        },
        "body-parser": { observed: "2.2.2", pin: "body-parser", lockObserved: "2.2.2" },
        "brace-expansion": {
          observed: "5.0.6",
          pin: "brace-expansion",
          lockObserved: "5.0.6",
        },
        hono: { observed: "4.12.18", pin: "hono", lockObserved: "4.12.18" },
        "linkify-it": { observed: "5.0.0", pin: "linkify-it", lockObserved: "5.0.0" },
        "markdown-it": { observed: "14.1.1", pin: "markdown-it", lockObserved: "14.1.1" },
        protobufjs: { observed: "8.4.0", pin: "protobufjs-8", lockObserved: "8.4.0" },
        qs: { observed: "6.14.2", pin: "qs", lockObserved: "6.14.2" },
        undici: { observed: "8.3.0", pin: "undici", lockObserved: "8.3.0" },
        ws: { observed: "8.20.1", pin: "ws", lockObserved: "8.20.1" },
      },
      rootDirect: {
        "@earendil-works/pi-agent-core": "0.75.4",
        "@earendil-works/pi-ai": "0.75.4",
        "@earendil-works/pi-coding-agent": "0.75.4",
        "@earendil-works/pi-tui": "0.75.4",
        "markdown-it": "14.1.1",
        undici: "8.3.0",
        ws: "8.20.1",
      },
      dependencyOverrides: {
        "@earendil-works/pi-ai": {
          "@anthropic-ai/sdk": {
            published: "0.91.1",
            observed: "0.97.1",
            target: "0.97.1",
          },
          "@aws-sdk/client-bedrock-runtime": {
            published: "3.1048.0",
            observed: "3.1051.0",
            target: "3.1051.0",
          },
          "@google/genai": { published: "1.52.0", observed: "2.5.0", target: "2.5.0" },
          openai: { published: "6.26.0", observed: "6.38.0", target: "6.38.0" },
        },
        "@earendil-works/pi-coding-agent": {
          undici: { published: "8.3.0", observed: "8.3.0", target: "8.5.0" },
        },
      },
      obsoletePackages: {
        koffi: {
          observed: "2.16.2",
          owner: "@earendil-works/pi-tui",
          ownerField: "optionalDependencies",
          ownerSpec: "2.16.2",
          lockObserved: "2.16.2",
        },
      },
    },
  ],
  [
    "2026.5.27",
    {
      shrinkwrap: true,
      replacements: {
        "@earendil-works/pi-agent-core": {
          observed: "0.75.5",
          pin: "pi-agent-core",
          lockObserved: "0.75.5",
        },
        "@earendil-works/pi-ai": {
          observed: "0.75.5",
          pin: "pi-ai",
          lockObserved: "0.75.5",
        },
        "@earendil-works/pi-coding-agent": {
          observed: "0.75.5",
          pin: "pi-coding-agent",
          lockObserved: "0.75.5",
        },
        "@earendil-works/pi-tui": {
          observed: "0.75.5",
          pin: "pi-tui",
          lockObserved: "0.75.5",
        },
        "@mariozechner/clipboard": {
          observed: "0.3.6",
          pin: "clipboard",
          lockObserved: "0.3.6",
        },
        "body-parser": { observed: "2.2.2", pin: "body-parser", lockObserved: "2.2.2" },
        "brace-expansion": {
          observed: "5.0.6",
          pin: "brace-expansion",
          lockObserved: "5.0.6",
        },
        hono: { observed: "4.12.18", pin: "hono", lockObserved: "4.12.18" },
        "linkify-it": { observed: "5.0.0", pin: "linkify-it", lockObserved: "5.0.0" },
        "markdown-it": { observed: "14.1.1", pin: "markdown-it", lockObserved: "14.1.1" },
        protobufjs: { observed: "8.4.0", pin: "protobufjs-8", lockObserved: "8.4.0" },
        undici: { observed: "8.3.0", pin: "undici", lockObserved: "8.3.0" },
      },
      rootDirect: {
        "@earendil-works/pi-agent-core": "0.75.5",
        "@earendil-works/pi-ai": "0.75.5",
        "@earendil-works/pi-coding-agent": "0.75.5",
        "@earendil-works/pi-tui": "0.75.5",
        "markdown-it": "14.1.1",
        undici: "8.3.0",
      },
      dependencyOverrides: {
        "@earendil-works/pi-ai": {
          "@anthropic-ai/sdk": {
            published: "0.91.1",
            observed: "0.98.0",
            target: "0.98.0",
          },
          "@aws-sdk/client-bedrock-runtime": {
            published: "3.1048.0",
            observed: "3.1053.0",
            target: "3.1053.0",
          },
          "@google/genai": { published: "1.52.0", observed: "2.6.0", target: "2.6.0" },
          "@smithy/node-http-handler": {
            published: "4.7.3",
            observed: "4.7.4",
            target: "4.7.4",
          },
          openai: { published: "6.26.0", observed: "6.39.0", target: "6.39.0" },
        },
        "@earendil-works/pi-coding-agent": {
          undici: { published: "8.3.0", observed: "8.3.0", target: "8.5.0" },
        },
      },
      obsoletePackages: {},
    },
  ],
  [
    "2026.6.10",
    {
      shrinkwrap: true,
      replacements: {
        "body-parser": { observed: "2.3.0", pin: "body-parser", lockObserved: "2.2.2" },
        "brace-expansion": {
          observed: "5.0.7",
          pin: "brace-expansion",
          lockObserved: "5.0.6",
        },
        hono: { observed: "4.12.30", pin: "hono", lockObserved: "4.12.25" },
        protobufjs: { observed: "7.6.5", pin: "protobufjs-7", lockObserved: "7.6.3" },
        qs: { observed: "6.15.3", pin: "qs", lockObserved: "6.15.2" },
      },
      rootDirect: {},
      dependencyOverrides: {},
      obsoletePackages: {},
    },
  ],
]);

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonRecord;
}

function readJson(file: string, label: string): JsonRecord {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(descriptor).isFile()) throw new Error(`${label} must be a regular file`);
    return record(JSON.parse(readFileSync(descriptor, "utf8")), label);
  } catch (error) {
    throw new Error(`${label} is invalid: ${String(error)}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function directory(pathname: string, label: string): void {
  const metadata = lstatSync(pathname);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${pathname}`);
  }
}

function rejectUnsafeMembers(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      throw new Error(`replacement package contains an unsafe member: ${entry.name}`);
    }
    if (entry.isDirectory()) rejectUnsafeMembers(path.join(root, entry.name));
  }
}

function dependencies(manifest: JsonRecord, label: string): JsonRecord {
  return record(manifest.dependencies, `${label} dependencies`);
}

function lockPackages(lock: JsonRecord): JsonRecord {
  if (lock.lockfileVersion !== 3) throw new Error("OpenClaw shrinkwrap must use lockfileVersion 3");
  return record(lock.packages, "OpenClaw shrinkwrap packages");
}

function replacementDirectory(replacementRoot: string, pinKey: string): string {
  return path.join(replacementRoot, pinKey);
}

function installedPackageDirectory(
  openClawRoot: string,
  packageName: string,
  label: string,
): string {
  const nodeModulesPath = path.join(openClawRoot, "node_modules");
  directory(nodeModulesPath, "OpenClaw node_modules root");
  const resolvedOpenClawRoot = realpathSync(openClawRoot);
  const nodeModulesRoot = realpathSync(nodeModulesPath);
  if (!nodeModulesRoot.startsWith(`${resolvedOpenClawRoot}${path.sep}`)) {
    throw new Error("OpenClaw node_modules root must remain inside the OpenClaw root");
  }
  const packageRoot = path.join(openClawRoot, "node_modules", packageName);
  directory(packageRoot, label);
  const resolved = realpathSync(packageRoot);
  if (!resolved.startsWith(`${nodeModulesRoot}${path.sep}`)) {
    throw new Error(`${label} must remain inside the OpenClaw node_modules tree`);
  }
  return packageRoot;
}

function validateReplacement(replacementRoot: string, pinKey: string): JsonRecord {
  const pin = CORE_SECURITY_PINS[pinKey];
  if (!pin) throw new Error(`unknown reviewed package pin: ${pinKey}`);
  const root = replacementDirectory(replacementRoot, pinKey);
  directory(root, `replacement ${pinKey} root`);
  rejectUnsafeMembers(root);
  const manifest = readJson(path.join(root, "package.json"), `replacement ${pinKey} manifest`);
  if (manifest.name !== pin.name || manifest.version !== pin.version) {
    throw new Error(`replacement ${pinKey} must be ${pin.name}@${pin.version}`);
  }
  return manifest;
}

function replaceDirectory(source: string, destination: string, marker: string): void {
  const staged = `${destination}.nemoclaw-${marker}`;
  rmSync(staged, { recursive: true, force: true });
  cpSync(source, staged, { recursive: true, dereference: false });
  rmSync(destination, { recursive: true, force: true });
  renameSync(staged, destination);
}

function syncLockPackage(lockEntry: JsonRecord, pin: PackagePin, manifest: JsonRecord): void {
  lockEntry.version = pin.version;
  lockEntry.resolved = pin.tarball;
  lockEntry.integrity = pin.integrity;
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "peerDependenciesMeta",
  ] as const) {
    delete lockEntry[field];
    if (manifest[field] !== undefined) {
      lockEntry[field] = structuredClone(
        record(manifest[field], `${pin.name} replacement ${field}`),
      );
    }
  }
}

function reviewedLayout(expectedOpenClawVersion: string): HistoricalLayout {
  const layout = HISTORICAL_LAYOUTS.get(expectedOpenClawVersion);
  if (!layout) throw new Error(`OpenClaw ${expectedOpenClawVersion} is not a reviewed target`);
  return layout;
}

export function patchOpenClawCoreDependencies(options: {
  openClawRoot: string;
  replacementRoot: string;
  expectedOpenClawVersion: string;
}): void {
  const openClawRoot = path.resolve(options.openClawRoot);
  const replacementRoot = path.resolve(options.replacementRoot);
  directory(openClawRoot, "OpenClaw root");
  directory(replacementRoot, "replacement package root");
  const layout = reviewedLayout(options.expectedOpenClawVersion);
  const manifestPath = path.join(openClawRoot, "package.json");
  const manifest = readJson(manifestPath, "OpenClaw package manifest");
  if (manifest.version !== options.expectedOpenClawVersion) {
    throw new Error("historical OpenClaw version does not match the reviewed target");
  }
  const rootDependencies = dependencies(manifest, "OpenClaw package manifest");

  const replacementManifests = new Map<string, JsonRecord>();
  for (const replacement of Object.values(layout.replacements)) {
    if (!replacementManifests.has(replacement.pin)) {
      replacementManifests.set(
        replacement.pin,
        validateReplacement(replacementRoot, replacement.pin),
      );
    }
  }
  const contentTypeManifest = validateReplacement(replacementRoot, "content-type");

  for (const [packageName, replacement] of Object.entries(layout.replacements)) {
    const installedRoot = installedPackageDirectory(
      openClawRoot,
      packageName,
      `installed ${packageName} root`,
    );
    const installed = readJson(
      path.join(installedRoot, "package.json"),
      `installed ${packageName} manifest`,
    );
    if (installed.name !== packageName || installed.version !== replacement.observed) {
      throw new Error(
        `installed ${packageName} state does not match the review: expected ${replacement.observed}, found ${String(installed.version)}`,
      );
    }
  }
  for (const [packageName, observed] of Object.entries(layout.rootDirect)) {
    if (rootDependencies[packageName] !== observed) {
      throw new Error(`OpenClaw direct ${packageName} dependency does not match the review`);
    }
  }
  for (const [ownerName, overrides] of Object.entries(layout.dependencyOverrides)) {
    const replacement = layout.replacements[ownerName];
    if (!replacement) throw new Error(`dependency override owner ${ownerName} has no replacement`);
    const replacementManifest = replacementManifests.get(replacement.pin) as JsonRecord;
    const replacementDependencies = dependencies(
      replacementManifest,
      `replacement ${ownerName} manifest`,
    );
    for (const [dependencyName, override] of Object.entries(overrides)) {
      if (replacementDependencies[dependencyName] !== override.published) {
        throw new Error(
          `replacement ${ownerName} ${dependencyName} dependency does not match the review`,
        );
      }
      const installedDependencyRoot = installedPackageDirectory(
        openClawRoot,
        dependencyName,
        `installed ${dependencyName} root`,
      );
      const installedDependency = readJson(
        path.join(installedDependencyRoot, "package.json"),
        `installed ${dependencyName} manifest`,
      );
      if (
        installedDependency.name !== dependencyName ||
        installedDependency.version !== override.observed
      ) {
        throw new Error(
          `installed ${dependencyName} compatibility state does not match the review`,
        );
      }
    }
  }
  for (const [packageName, obsolete] of Object.entries(layout.obsoletePackages)) {
    const ownerRoot = installedPackageDirectory(
      openClawRoot,
      obsolete.owner,
      `obsolete ${packageName} owner root`,
    );
    const ownerManifest = readJson(
      path.join(ownerRoot, "package.json"),
      `obsolete ${packageName} owner manifest`,
    );
    const ownerDependencies = record(
      ownerManifest[obsolete.ownerField],
      `obsolete ${packageName} owner ${obsolete.ownerField}`,
    );
    if (ownerDependencies[packageName] !== obsolete.ownerSpec) {
      throw new Error(`obsolete ${packageName} ownership does not match the review`);
    }
    const obsoleteRoot = installedPackageDirectory(
      openClawRoot,
      packageName,
      `obsolete ${packageName} root`,
    );
    const installed = readJson(
      path.join(obsoleteRoot, "package.json"),
      `obsolete ${packageName} manifest`,
    );
    if (installed.name !== packageName || installed.version !== obsolete.observed) {
      throw new Error(`obsolete ${packageName} state does not match the review`);
    }
  }

  const shrinkwrapPath = path.join(openClawRoot, "npm-shrinkwrap.json");
  let shrinkwrap: JsonRecord | undefined;
  let packages: JsonRecord | undefined;
  if (layout.shrinkwrap) {
    shrinkwrap = readJson(shrinkwrapPath, "OpenClaw shrinkwrap");
    packages = lockPackages(shrinkwrap);
    const lockRootDependencies = dependencies(
      record(packages[""], "OpenClaw shrinkwrap root package"),
      "OpenClaw shrinkwrap root package",
    );
    for (const [packageName, observed] of Object.entries(layout.rootDirect)) {
      if (lockRootDependencies[packageName] !== observed) {
        throw new Error(`OpenClaw shrinkwrap direct ${packageName} dependency does not match`);
      }
    }
    for (const [packageName, replacement] of Object.entries(layout.replacements)) {
      const lockEntry = record(
        packages[`node_modules/${packageName}`],
        `OpenClaw shrinkwrap ${packageName} package`,
      );
      if (lockEntry.version !== replacement.lockObserved) {
        throw new Error(`OpenClaw shrinkwrap ${packageName} state does not match the review`);
      }
    }
    for (const [packageName, obsolete] of Object.entries(layout.obsoletePackages)) {
      const lockEntry = record(
        packages[`node_modules/${packageName}`],
        `OpenClaw shrinkwrap obsolete ${packageName} package`,
      );
      if (lockEntry.version !== obsolete.lockObserved) {
        throw new Error(`OpenClaw shrinkwrap obsolete ${packageName} state does not match`);
      }
    }
    if (packages["node_modules/body-parser/node_modules/content-type"] !== undefined) {
      throw new Error("OpenClaw shrinkwrap unexpectedly contains nested body-parser content-type");
    }
  } else if (existsSync(shrinkwrapPath)) {
    throw new Error("OpenClaw shrinkwrap presence does not match the review");
  }

  for (const [packageName, replacement] of Object.entries(layout.replacements)) {
    const pin = CORE_SECURITY_PINS[replacement.pin];
    const source = replacementDirectory(replacementRoot, replacement.pin);
    const destination = installedPackageDirectory(
      openClawRoot,
      packageName,
      `installed ${packageName} replacement root`,
    );
    replaceDirectory(source, destination, `security-${pin.version}`);
  }
  for (const [ownerName, overrides] of Object.entries(layout.dependencyOverrides)) {
    const ownerPath = path.join(
      installedPackageDirectory(openClawRoot, ownerName, `patched ${ownerName} root`),
      "package.json",
    );
    const ownerManifest = readJson(ownerPath, `patched ${ownerName} manifest`);
    const ownerDependencies = dependencies(ownerManifest, `patched ${ownerName} manifest`);
    for (const [dependencyName, override] of Object.entries(overrides)) {
      ownerDependencies[dependencyName] = override.target;
    }
    writeFileSync(ownerPath, `${JSON.stringify(ownerManifest, null, 2)}\n`);
  }
  for (const packageName of Object.keys(layout.obsoletePackages)) {
    const obsoleteRoot = installedPackageDirectory(
      openClawRoot,
      packageName,
      `obsolete ${packageName} removal root`,
    );
    rmSync(obsoleteRoot, {
      recursive: true,
      force: false,
    });
  }

  const bodyParserRoot = installedPackageDirectory(
    openClawRoot,
    "body-parser",
    "patched body-parser root",
  );
  replaceDirectory(
    replacementDirectory(replacementRoot, "content-type"),
    path.join(bodyParserRoot, "node_modules", "content-type"),
    "security-2.0.0",
  );

  for (const [packageName, observed] of Object.entries(layout.rootDirect)) {
    const replacement = layout.replacements[packageName];
    if (!replacement || replacement.observed !== observed) {
      throw new Error(`reviewed root dependency ${packageName} has no replacement`);
    }
    rootDependencies[packageName] = CORE_SECURITY_PINS[replacement.pin].version;
  }
  if (shrinkwrap && packages) {
    const lockRootDependencies = dependencies(
      record(packages[""], "OpenClaw shrinkwrap root package"),
      "OpenClaw shrinkwrap root package",
    );
    for (const packageName of Object.keys(layout.rootDirect)) {
      lockRootDependencies[packageName] =
        CORE_SECURITY_PINS[layout.replacements[packageName].pin].version;
    }
    for (const [packageName, replacement] of Object.entries(layout.replacements)) {
      const installedRoot = installedPackageDirectory(
        openClawRoot,
        packageName,
        `patched ${packageName} root`,
      );
      const installedManifest = readJson(
        path.join(installedRoot, "package.json"),
        `patched ${packageName} manifest`,
      );
      syncLockPackage(
        record(
          packages[`node_modules/${packageName}`],
          `OpenClaw shrinkwrap ${packageName} package`,
        ),
        CORE_SECURITY_PINS[replacement.pin],
        installedManifest,
      );
    }
    for (const packageName of Object.keys(layout.obsoletePackages)) {
      delete packages[`node_modules/${packageName}`];
    }
    const contentTypePin = CORE_SECURITY_PINS["content-type"];
    packages["node_modules/body-parser/node_modules/content-type"] = {
      version: contentTypePin.version,
      resolved: contentTypePin.tarball,
      integrity: contentTypePin.integrity,
    };
    writeFileSync(shrinkwrapPath, `${JSON.stringify(shrinkwrap, null, 2)}\n`);
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  if (
    contentTypeManifest.name !== "content-type" ||
    contentTypeManifest.version !== CORE_SECURITY_PINS["content-type"].version
  ) {
    throw new Error("nested body-parser content-type replacement is inconsistent");
  }
}

export function verifyOpenClawCoreDependencies(options: {
  openClawRoot: string;
  expectedOpenClawVersion: string;
}): void {
  const openClawRoot = path.resolve(options.openClawRoot);
  const layout = reviewedLayout(options.expectedOpenClawVersion);
  const manifest = readJson(path.join(openClawRoot, "package.json"), "OpenClaw package manifest");
  if (manifest.version !== options.expectedOpenClawVersion) {
    throw new Error("patched OpenClaw version is inconsistent");
  }
  const rootDependencies = dependencies(manifest, "OpenClaw package manifest");
  for (const [packageName, replacement] of Object.entries(layout.replacements)) {
    const pin = CORE_SECURITY_PINS[replacement.pin];
    const installedRoot = installedPackageDirectory(
      openClawRoot,
      packageName,
      `patched ${packageName} root`,
    );
    const installed = readJson(
      path.join(installedRoot, "package.json"),
      `patched ${packageName} manifest`,
    );
    if (installed.name !== packageName || installed.version !== pin.version) {
      throw new Error(`patched ${packageName} package is inconsistent`);
    }
  }
  const bodyParserRoot = installedPackageDirectory(
    openClawRoot,
    "body-parser",
    "patched body-parser root",
  );
  const nestedContentType = readJson(
    path.join(bodyParserRoot, "node_modules", "content-type", "package.json"),
    "patched body-parser content-type manifest",
  );
  if (nestedContentType.version !== CORE_SECURITY_PINS["content-type"].version) {
    throw new Error("patched body-parser content-type package is inconsistent");
  }
  for (const packageName of Object.keys(layout.rootDirect)) {
    if (
      rootDependencies[packageName] !==
      CORE_SECURITY_PINS[layout.replacements[packageName].pin].version
    ) {
      throw new Error(`patched OpenClaw direct ${packageName} dependency is inconsistent`);
    }
  }
  for (const [ownerName, overrides] of Object.entries(layout.dependencyOverrides)) {
    const ownerRoot = installedPackageDirectory(
      openClawRoot,
      ownerName,
      `patched ${ownerName} root`,
    );
    const ownerManifest = readJson(
      path.join(ownerRoot, "package.json"),
      `patched ${ownerName} manifest`,
    );
    const ownerDependencies = dependencies(ownerManifest, `patched ${ownerName} manifest`);
    for (const [dependencyName, override] of Object.entries(overrides)) {
      if (ownerDependencies[dependencyName] !== override.target) {
        throw new Error(`patched ${ownerName} ${dependencyName} dependency is inconsistent`);
      }
      const dependencyRoot = installedPackageDirectory(
        openClawRoot,
        dependencyName,
        `patched ${dependencyName} root`,
      );
      const installedDependency = readJson(
        path.join(dependencyRoot, "package.json"),
        `patched ${dependencyName} manifest`,
      );
      if (installedDependency.version !== override.target) {
        throw new Error(`patched ${dependencyName} compatibility package is inconsistent`);
      }
    }
  }
  for (const packageName of Object.keys(layout.obsoletePackages)) {
    if (existsSync(path.join(openClawRoot, "node_modules", packageName))) {
      throw new Error(`obsolete ${packageName} package remains installed`);
    }
  }

  const shrinkwrapPath = path.join(openClawRoot, "npm-shrinkwrap.json");
  if (layout.shrinkwrap) {
    const packages = lockPackages(readJson(shrinkwrapPath, "OpenClaw shrinkwrap"));
    for (const [packageName, replacement] of Object.entries(layout.replacements)) {
      const pin = CORE_SECURITY_PINS[replacement.pin];
      const lockEntry = record(
        packages[`node_modules/${packageName}`],
        `patched OpenClaw shrinkwrap ${packageName} package`,
      );
      if (
        lockEntry.version !== pin.version ||
        lockEntry.resolved !== pin.tarball ||
        lockEntry.integrity !== pin.integrity
      ) {
        throw new Error(`patched OpenClaw shrinkwrap ${packageName} package is inconsistent`);
      }
    }
    const nestedLock = record(
      packages["node_modules/body-parser/node_modules/content-type"],
      "patched OpenClaw shrinkwrap body-parser content-type package",
    );
    if (nestedLock.version !== CORE_SECURITY_PINS["content-type"].version) {
      throw new Error("patched body-parser content-type shrinkwrap entry is inconsistent");
    }
    for (const packageName of Object.keys(layout.obsoletePackages)) {
      if (packages[`node_modules/${packageName}`] !== undefined) {
        throw new Error(`obsolete ${packageName} shrinkwrap entry remains`);
      }
    }
  } else if (existsSync(shrinkwrapPath)) {
    throw new Error("patched OpenClaw unexpectedly contains a shrinkwrap");
  }
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`missing ${name}`);
  return value;
}

function main(): void {
  const openClawRoot = argument("--openclaw-root");
  const expectedOpenClawVersion = argument("--expected-openclaw-version");
  if (process.argv.includes("--verify")) {
    verifyOpenClawCoreDependencies({ openClawRoot, expectedOpenClawVersion });
    return;
  }
  patchOpenClawCoreDependencies({
    openClawRoot,
    replacementRoot: argument("--replacement-root"),
    expectedOpenClawVersion,
  });
  verifyOpenClawCoreDependencies({ openClawRoot, expectedOpenClawVersion });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
