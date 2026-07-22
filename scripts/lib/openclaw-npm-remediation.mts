#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
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
  expectedPatchedMetadataIntegrity?: string;
  expectedPatchedTreeIntegrity?: string;
  kind: "axios" | "core" | "jaeger" | "legacy-core";
  version: "2026.3.11" | "2026.6.10" | "2026.7.1";
}>;

type ReviewedPackageIdentity = Readonly<{
  integrity: string;
  name: string;
  sourceIntegrity?: string;
  sourceTarball?: string;
  sourceVersion?: string;
  tarball: string;
  version: string;
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
const HONO_NODE_SERVER_VERSION = "2.0.11";
const HONO_NODE_SERVER_INTEGRITY =
  "sha512-bjD221KPLoJTWUwso1J6fGKiTXEUFedG/s0visavY4zakFPkeGURMRNly+FhBHs7T8Dz4qHaZIMX9ZoJHSJtKA==";
const HONO_NODE_SERVER_TARBALL =
  "https://registry.npmjs.org/@hono/node-server/-/node-server-2.0.11.tgz";
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
const ZOD_VERSION = "4.4.3";
const ZOD_INTEGRITY =
  "sha512-ytENFjIJFl2UwYglde2jchW2Hwm4GJFLDiSXWdTrJQBIN9Fcyp7n4DhxJEiWNAJMV1/BqWfW/kkg71UDcHJyTQ==";
const ZOD_TARBALL = "https://registry.npmjs.org/zod/-/zod-4.4.3.tgz";
const PKCE_CHALLENGE_VERSION = "5.0.1";
const PKCE_CHALLENGE_INTEGRITY =
  "sha512-wQ0b/W4Fr01qtpHlqSqspcj3EhBvimsdh0KlHhH8HRZnMsEa0ea2fTULOXOS9ccQr3om+GcGRk4e+isrZWV8qQ==";
const PKCE_CHALLENGE_TARBALL =
  "https://registry.npmjs.org/pkce-challenge/-/pkce-challenge-5.0.1.tgz";
const MODEL_CONTEXT_PROTOCOL_RUNTIME_PACKAGES: readonly ReviewedPackageIdentity[] = [
  {
    name: "ajv",
    version: "8.20.0",
    integrity:
      "sha512-Thbli+OlOj+iMPYFBVBfJ3OmCAnaSyNn4M1vz9T6Gka5Jt9ba/HIR56joy65tY6kx/FCF5VXNB819Y7/GUrBGA==",
    tarball: "https://registry.npmjs.org/ajv/-/ajv-8.20.0.tgz",
  },
  {
    name: "ajv-formats",
    version: "3.0.1",
    integrity:
      "sha512-8iUql50EUR+uUcdRQ3HDqa6EVyo3docL8g5WJ3FNcWmu62IbkGUue/pEyLBW8VGKKucTPgqeks4fIU1DA4yowQ==",
    tarball: "https://registry.npmjs.org/ajv-formats/-/ajv-formats-3.0.1.tgz",
  },
  {
    name: "cross-spawn",
    version: "7.0.6",
    integrity:
      "sha512-uV2QOWP2nWzsy2aMp8aRibhi9dlzF5Hgh5SHaB9OiTGEyDTiJJyx0uy51QXdyWbtAHNua4XJzUKca3OzKUd3vA==",
    tarball: "https://registry.npmjs.org/cross-spawn/-/cross-spawn-7.0.6.tgz",
  },
  {
    name: "eventsource",
    version: "3.0.7",
    integrity:
      "sha512-CRT1WTyuQoD771GW56XEZFQ/ZoSfWid1alKGDYMmkt2yl8UXrVR4pspqWNEcqKvVIzg6PAltWjxcSSPrboA4iA==",
    tarball: "https://registry.npmjs.org/eventsource/-/eventsource-3.0.7.tgz",
  },
  {
    name: "eventsource-parser",
    version: EVENTSOURCE_PARSER_VERSION,
    integrity: EVENTSOURCE_PARSER_INTEGRITY,
    tarball: EVENTSOURCE_PARSER_TARBALL,
  },
  {
    name: "fast-deep-equal",
    version: "3.1.3",
    integrity:
      "sha512-f3qQ9oQy9j2AhBe/H9VC91wLmKBCCU/gDOnKNAYG5hswO7BLKj09Hc5HYNz9cGI++xlpDCIgDaitVs03ATR84Q==",
    tarball: "https://registry.npmjs.org/fast-deep-equal/-/fast-deep-equal-3.1.3.tgz",
  },
  {
    name: "fast-uri",
    version: "3.1.4",
    integrity:
      "sha512-8JnbkQ4juDyvYs4mgFGQqg4yCYtFDtUtmp2QIQq11ZZe5CFQ5wcqm1rqDgAh/QdMySuBnPzMUiJUNZG5N/AiQw==",
    tarball: "https://registry.npmjs.org/fast-uri/-/fast-uri-3.1.4.tgz",
    sourceVersion: "3.1.2",
    sourceIntegrity:
      "sha512-rVjf7ArG3LTk+FS6Yw81V1DLuZl1bRbNrev6Tmd/9RaroeeRRJhAt7jg/6YFxbvAQXUCavSoZhPPj6oOx+5KjQ==",
    sourceTarball: "https://registry.npmjs.org/fast-uri/-/fast-uri-3.1.2.tgz",
  },
  {
    name: "isexe",
    version: "2.0.0",
    integrity:
      "sha512-RHxMLp9lnKHGHRng9QFhRCMbYAcVpn69smSGcq3f36xjgVVWThj4qqLbTLlq7Ssj8B+fIQ1EuCEGI2lKsyQeIw==",
    tarball: "https://registry.npmjs.org/isexe/-/isexe-2.0.0.tgz",
  },
  {
    name: "json-schema-traverse",
    version: "1.0.0",
    integrity:
      "sha512-NM8/P9n3XjXhIZn1lLhkFaACTOURQXjWhV4BA/RnOv8xvgqtqpAX9IO4mRQxSx1Rlo4tqzeqb0sOlruaOy3dug==",
    tarball: "https://registry.npmjs.org/json-schema-traverse/-/json-schema-traverse-1.0.0.tgz",
  },
  {
    name: "path-key",
    version: "3.1.1",
    integrity:
      "sha512-ojmeN0qd+y0jszEtoY48r0Peq5dwMEkIlCOu6Q5f41lfkswXuKtYrhgoTpLnyIcHm24Uhqx+5Tqm2InSwLhE6Q==",
    tarball: "https://registry.npmjs.org/path-key/-/path-key-3.1.1.tgz",
  },
  {
    name: "pkce-challenge",
    version: PKCE_CHALLENGE_VERSION,
    integrity: PKCE_CHALLENGE_INTEGRITY,
    tarball: PKCE_CHALLENGE_TARBALL,
  },
  {
    name: "require-from-string",
    version: "2.0.2",
    integrity:
      "sha512-Xf0nWe6RseziFMu+Ap9biiUbmplq6S9/p+7w7YXP/JBHhrUDDUhwa+vANyubuqfZWTveU//DYVGsDG7RKL/vEw==",
    tarball: "https://registry.npmjs.org/require-from-string/-/require-from-string-2.0.2.tgz",
  },
  {
    name: "shebang-command",
    version: "2.0.0",
    integrity:
      "sha512-kHxr2zZpYtdmrN1qDjrrX/Z1rR1kG8Dx+gkpK1G4eXmvXswmcE1hTWBWYUzlraYw1/yZp6YuDY77YtvbN0dmDA==",
    tarball: "https://registry.npmjs.org/shebang-command/-/shebang-command-2.0.0.tgz",
  },
  {
    name: "shebang-regex",
    version: "3.0.0",
    integrity:
      "sha512-7++dFhtcx3353uBaq8DDR4NuxBetBzC7ZQOhmTQInHEd6bSrXdiEyzCvG07Z44UYdLShWUyXt5M/yhz8ekcb1A==",
    tarball: "https://registry.npmjs.org/shebang-regex/-/shebang-regex-3.0.0.tgz",
  },
  {
    name: "which",
    version: "2.0.2",
    integrity:
      "sha512-BLI3Tl1TW3Pvl70l3yq3Y64i+awpwXqsGBYWkkqMtnbXgrMD+yj7rhW0kuEDxzJaYXGjEW5ogapKNMEKNMjibA==",
    tarball: "https://registry.npmjs.org/which/-/which-2.0.2.tgz",
  },
  {
    name: "zod",
    version: ZOD_VERSION,
    integrity: ZOD_INTEGRITY,
    tarball: ZOD_TARBALL,
  },
  {
    name: "zod-to-json-schema",
    version: "3.25.2",
    integrity:
      "sha512-O/PgfnpT1xKSDeQYSCfRI5Gy3hPf91mKVDuYLUHZJMiDFptvP41MSnWofm8dnCm0256ZNfZIM7DSzuSMAFnjHA==",
    tarball: "https://registry.npmjs.org/zod-to-json-schema/-/zod-to-json-schema-3.25.2.tgz",
  },
];
const MODEL_CONTEXT_PROTOCOL_CLIENT_DEPENDENCIES = Object.freeze({
  ajv: "^8.17.1",
  "ajv-formats": "^3.0.1",
  "cross-spawn": "^7.0.5",
  eventsource: "^3.0.2",
  "eventsource-parser": "^3.0.0",
  "pkce-challenge": "^5.0.0",
  zod: "^3.25 || ^4.0",
  "zod-to-json-schema": "^3.25.1",
});
const JAEGER_PROPAGATOR_VERSION = "2.9.0";
const JAEGER_PROPAGATOR_INTEGRITY =
  "sha512-4mYGty27rYvSM0jtp1ZUOqd3LfVRCYg9H5G9OFzSx5HViYToU21MFhWfco7x1HwXr7ER8yGOiCIHZUwjPksc0Q==";
const JAEGER_PROPAGATOR_TARBALL =
  "https://registry.npmjs.org/@opentelemetry/propagator-jaeger/-/propagator-jaeger-2.9.0.tgz";
const OTEL_PROPAGATOR_JAEGER_VERSION = JAEGER_PROPAGATOR_VERSION;
const OTEL_PROPAGATOR_JAEGER_INTEGRITY = JAEGER_PROPAGATOR_INTEGRITY;
const OTEL_PROPAGATOR_JAEGER_TARBALL = JAEGER_PROPAGATOR_TARBALL;
const OTEL_CORE_VERSION = "2.9.0";
const OTEL_CORE_INTEGRITY =
  "sha512-m2nckMT80NnmjTYSPjJQObBJ+8dgkoajEOUbznL8AHZ3T3yHRk2P7gI1PhEBc1+lOnrYE9UWrWHqJDsmqjmNbw==";
const OTEL_CORE_TARBALL = "https://registry.npmjs.org/@opentelemetry/core/-/core-2.9.0.tgz";
const CANONICAL_ARCHIVE_TIME = new Date(0);

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
      "sha512-WLZDX4gR+IlchildC9ZI2o4252gEXxNWFaeGprL1JYfB+w8b2YuLYwH6Or0M9RxIWC9giTFCUSyi0Rvcg05PnQ==",
    kind: "axios",
    version: "2026.6.10",
  },
  "@openclaw/diagnostics-otel@2026.7.1": {
    expectedPatchedTreeIntegrity:
      "sha512-2qyDTRPqNs97jo/pAWWfxAkVZyCXYqui/IjrGf4eEfYop1eGN8qBMJ/Kp/bJ/V18RNnYpMxHi5ECFelekVxcAQ==",
    kind: "jaeger",
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
      "sha512-QJH/wyJBl7eEnjIMmWQs8jCoUXAHFNxvYCv0y+yh2WaDFJh3ptlHlgH7N+quLWRUSHPcmjcyOlKYIYXYtiDNiA==",
    kind: "core",
    version: "2026.6.10",
  },
  "openclaw@2026.3.11": {
    kind: "legacy-core",
    expectedPatchedMetadataIntegrity:
      "sha512-1i30XSb/2NEcuTcuhXfR/x3YKaXVhWq6ttecFBSD9nrCKrzjNxSNMfK1y3qRcnblNOzRWmHtJZwZKeej02s/EQ==",
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
  for (const bundledPackageJson of [
    "node_modules/@hono/node-server/package.json",
    "node_modules/@modelcontextprotocol/sdk/package.json",
    "node_modules/@openclaw/fs-safe/package.json",
    ...MODEL_CONTEXT_PROTOCOL_RUNTIME_PACKAGES.map(
      ({ name }) => `node_modules/${name}/package.json`,
    ),
  ]) {
    if (existsSync(join(packageDirectory, bundledPackageJson))) names.push(bundledPackageJson);
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
    Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
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
    honoNodeServer?.version !== "1.19.14" ||
    honoNodeServer.resolved !==
      "https://registry.npmjs.org/@hono/node-server/-/node-server-1.19.14.tgz" ||
    honoNodeServer.integrity !==
      "sha512-GwtvgtXxnWsucXvbQXkRgqksiH2Qed37H9xHZocE5sA3N8O8O8/8FA3uclQXxXVzc9XBZuEOMK7+r02FmSpHtw=="
  ) {
    throw new Error("openclaw@2026.6.10 Hono node server layout changed after review");
  }
  for (const [name, expectedRange] of Object.entries(MODEL_CONTEXT_PROTOCOL_CLIENT_DEPENDENCIES)) {
    if (modelContextProtocolSdk.dependencies?.[name] !== expectedRange) {
      throw new Error(`openclaw@2026.6.10 MCP SDK ${name} dependency changed after review`);
    }
  }
  for (const identity of MODEL_CONTEXT_PROTOCOL_RUNTIME_PACKAGES) {
    const lockedPackage = packages[`node_modules/${identity.name}`] as JsonObject | undefined;
    if (
      lockedPackage?.version !== (identity.sourceVersion ?? identity.version) ||
      lockedPackage.resolved !== (identity.sourceTarball ?? identity.tarball) ||
      lockedPackage.integrity !== (identity.sourceIntegrity ?? identity.integrity)
    ) {
      throw new Error(
        `openclaw@2026.6.10 MCP runtime package ${identity.name} changed after review`,
      );
    }
    lockedPackage.version = identity.version;
    lockedPackage.resolved = identity.tarball;
    lockedPackage.integrity = identity.integrity;
  }
  if (packageJson.dependencies?.zod !== ZOD_VERSION || root.dependencies?.zod !== ZOD_VERSION) {
    throw new Error("openclaw@2026.6.10 Zod layout changed after review");
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
    ...MODEL_CONTEXT_PROTOCOL_RUNTIME_PACKAGES.map(({ name }) => name),
  ];
  root.dependencies.tar = TAR_VERSION;
  root.bundleDependencies = [...packageJson.bundledDependencies];
  modelContextProtocolSdk.dependencies["@hono/node-server"] = HONO_NODE_SERVER_VERSION;
  honoNodeServer.version = HONO_NODE_SERVER_VERSION;
  honoNodeServer.resolved = HONO_NODE_SERVER_TARBALL;
  honoNodeServer.integrity = HONO_NODE_SERVER_INTEGRITY;
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
      "@modelcontextprotocol/sdk@1.29.0 runtime dependency graph changed; review the remediation",
    );
  }
  for (const [name, expectedRange] of Object.entries(MODEL_CONTEXT_PROTOCOL_CLIENT_DEPENDENCIES)) {
    if (packageJson.dependencies?.[name] !== expectedRange) {
      throw new Error(
        "@modelcontextprotocol/sdk@1.29.0 runtime dependency graph changed; review the remediation",
      );
    }
  }
  if (
    packageJson.peerDependencies?.zod !== "^3.25 || ^4.0" ||
    packageJson.peerDependenciesMeta?.zod?.optional !== false
  ) {
    throw new Error(
      "@modelcontextprotocol/sdk@1.29.0 runtime dependency graph changed; review the remediation",
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
  const archiveMembers = normalizeArchiveContents(sourcePackage, basename(sourcePackage)).sort();
  const tarPath = `${archivePath}.tar`;
  const manifestPath = `${archivePath}.members`;
  const canonicalEnv: NodeJS.ProcessEnv = { ...env, LANG: "C", LC_ALL: "C", TZ: "UTC" };
  delete canonicalEnv.GZIP;
  delete canonicalEnv.TAR_OPTIONS;
  const tarVersion = run("tar", ["--version"], cwd, canonicalEnv);
  writeFileSync(manifestPath, Buffer.from(`${archiveMembers.join("\0")}\0`), { mode: 0o600 });
  try {
    if (tarVersion.includes("GNU tar")) {
      run(
        "tar",
        [
          "--format=gnu",
          "--mtime=@0",
          "--owner=0",
          "--group=0",
          "--numeric-owner",
          "-cf",
          tarPath,
          "-C",
          dirname(sourcePackage),
          "--no-recursion",
          "--null",
          "-T",
          manifestPath,
        ],
        cwd,
        canonicalEnv,
      );
    } else if (tarVersion.includes("bsdtar")) {
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
          "-cf",
          tarPath,
          "-C",
          dirname(sourcePackage),
          "--no-recursion",
          "--null",
          "-T",
          manifestPath,
        ],
        cwd,
        canonicalEnv,
      );
    } else {
      throw new Error(`unsupported tar implementation for canonical npm archive: ${tarVersion}`);
    }
  } finally {
    rmSync(manifestPath, { force: true });
  }
  run("gzip", ["-n", "-f", tarPath], cwd, canonicalEnv);
  renameSync(`${tarPath}.gz`, archivePath);
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
    const runtimePackages = MODEL_CONTEXT_PROTOCOL_RUNTIME_PACKAGES.map((identity) => {
      const archive = packReplacement(
        `${identity.name}@${identity.version}`,
        identity.integrity,
        identity.tarball,
        remediationRoot,
        env,
      );
      const packageDirectory = extractArchive(
        archive.archivePath,
        join(remediationRoot, `mcp-runtime-${identity.name}`),
        remediationRoot,
        env,
      );
      requirePackageIdentity(
        readJson(join(packageDirectory, "package.json")),
        identity.name,
        identity.version,
        `OpenClaw MCP SDK ${identity.name} runtime package`,
      );
      return { identity, packageDirectory };
    });
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
    for (const { identity, packageDirectory } of runtimePackages) {
      copyReplacementPackage(packageDirectory, join(sourcePackage, "node_modules", identity.name));
    }
    patchOpenClawCorePackageGraph(sourcePackage);
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
  let archivePath: string;
  if (remediation.version === "2026.7.1") {
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
    archivePath = resolve(outputDirectory, basename(packed[0].filename));
  } else {
    archivePath = join(outputDirectory, "openclaw-remediated.tgz");
    createCanonicalArchive(sourcePackage, archivePath, remediationRoot, env);
  }
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
