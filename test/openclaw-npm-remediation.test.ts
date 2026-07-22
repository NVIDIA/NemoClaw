// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRemediatedOpenClawArchive,
  patchOpenClawCorePackageGraph,
  patchOpenClawOtelPluginPackageGraph,
  patchOpenClawPluginPackageGraph,
} from "../scripts/lib/openclaw-npm-remediation.mts";

const temporaryDirectories: string[] = [];
const MCP_RUNTIME_PACKAGES = [
  [
    "ajv",
    "8.20.0",
    "sha512-Thbli+OlOj+iMPYFBVBfJ3OmCAnaSyNn4M1vz9T6Gka5Jt9ba/HIR56joy65tY6kx/FCF5VXNB819Y7/GUrBGA==",
    {
      "fast-deep-equal": "^3.1.3",
      "fast-uri": "^3.0.1",
      "json-schema-traverse": "^1.0.0",
      "require-from-string": "^2.0.2",
    },
  ],
  [
    "ajv-formats",
    "3.0.1",
    "sha512-8iUql50EUR+uUcdRQ3HDqa6EVyo3docL8g5WJ3FNcWmu62IbkGUue/pEyLBW8VGKKucTPgqeks4fIU1DA4yowQ==",
    { ajv: "^8.0.0" },
  ],
  [
    "cross-spawn",
    "7.0.6",
    "sha512-uV2QOWP2nWzsy2aMp8aRibhi9dlzF5Hgh5SHaB9OiTGEyDTiJJyx0uy51QXdyWbtAHNua4XJzUKca3OzKUd3vA==",
    { "path-key": "^3.1.0", "shebang-command": "^2.0.0", which: "^2.0.1" },
  ],
  [
    "eventsource",
    "3.0.7",
    "sha512-CRT1WTyuQoD771GW56XEZFQ/ZoSfWid1alKGDYMmkt2yl8UXrVR4pspqWNEcqKvVIzg6PAltWjxcSSPrboA4iA==",
    { "eventsource-parser": "^3.0.1" },
  ],
  [
    "eventsource-parser",
    "3.1.0",
    "sha512-kJezFj9YFAMLeORyi7aCLxLbD5/qWMQnoMVlVPyHIll7lgRJCc3JVln9Vgl9nwQi0YkMnhdGTMNn7CkRRAptMg==",
    {},
  ],
  [
    "fast-deep-equal",
    "3.1.3",
    "sha512-f3qQ9oQy9j2AhBe/H9VC91wLmKBCCU/gDOnKNAYG5hswO7BLKj09Hc5HYNz9cGI++xlpDCIgDaitVs03ATR84Q==",
    {},
  ],
  [
    "fast-uri",
    "3.1.4",
    "sha512-8JnbkQ4juDyvYs4mgFGQqg4yCYtFDtUtmp2QIQq11ZZe5CFQ5wcqm1rqDgAh/QdMySuBnPzMUiJUNZG5N/AiQw==",
    {},
  ],
  [
    "isexe",
    "2.0.0",
    "sha512-RHxMLp9lnKHGHRng9QFhRCMbYAcVpn69smSGcq3f36xjgVVWThj4qqLbTLlq7Ssj8B+fIQ1EuCEGI2lKsyQeIw==",
    {},
  ],
  [
    "json-schema-traverse",
    "1.0.0",
    "sha512-NM8/P9n3XjXhIZn1lLhkFaACTOURQXjWhV4BA/RnOv8xvgqtqpAX9IO4mRQxSx1Rlo4tqzeqb0sOlruaOy3dug==",
    {},
  ],
  [
    "path-key",
    "3.1.1",
    "sha512-ojmeN0qd+y0jszEtoY48r0Peq5dwMEkIlCOu6Q5f41lfkswXuKtYrhgoTpLnyIcHm24Uhqx+5Tqm2InSwLhE6Q==",
    {},
  ],
  [
    "pkce-challenge",
    "5.0.1",
    "sha512-wQ0b/W4Fr01qtpHlqSqspcj3EhBvimsdh0KlHhH8HRZnMsEa0ea2fTULOXOS9ccQr3om+GcGRk4e+isrZWV8qQ==",
    {},
  ],
  [
    "require-from-string",
    "2.0.2",
    "sha512-Xf0nWe6RseziFMu+Ap9biiUbmplq6S9/p+7w7YXP/JBHhrUDDUhwa+vANyubuqfZWTveU//DYVGsDG7RKL/vEw==",
    {},
  ],
  [
    "shebang-command",
    "2.0.0",
    "sha512-kHxr2zZpYtdmrN1qDjrrX/Z1rR1kG8Dx+gkpK1G4eXmvXswmcE1hTWBWYUzlraYw1/yZp6YuDY77YtvbN0dmDA==",
    { "shebang-regex": "^3.0.0" },
  ],
  [
    "shebang-regex",
    "3.0.0",
    "sha512-7++dFhtcx3353uBaq8DDR4NuxBetBzC7ZQOhmTQInHEd6bSrXdiEyzCvG07Z44UYdLShWUyXt5M/yhz8ekcb1A==",
    {},
  ],
  [
    "which",
    "2.0.2",
    "sha512-BLI3Tl1TW3Pvl70l3yq3Y64i+awpwXqsGBYWkkqMtnbXgrMD+yj7rhW0kuEDxzJaYXGjEW5ogapKNMEKNMjibA==",
    { isexe: "^2.0.0" },
  ],
  [
    "zod",
    "4.4.3",
    "sha512-ytENFjIJFl2UwYglde2jchW2Hwm4GJFLDiSXWdTrJQBIN9Fcyp7n4DhxJEiWNAJMV1/BqWfW/kkg71UDcHJyTQ==",
    {},
  ],
  [
    "zod-to-json-schema",
    "3.25.2",
    "sha512-O/PgfnpT1xKSDeQYSCfRI5Gy3hPf91mKVDuYLUHZJMiDFptvP41MSnWofm8dnCm0256ZNfZIM7DSzuSMAFnjHA==",
    {},
  ],
] as const;
const MCP_CLIENT_DEPENDENCIES = {
  ajv: "^8.17.1",
  "ajv-formats": "^3.0.1",
  "cross-spawn": "^7.0.5",
  eventsource: "^3.0.2",
  "eventsource-parser": "^3.0.0",
  "pkce-challenge": "^5.0.0",
  zod: "^3.25 || ^4.0",
  "zod-to-json-schema": "^3.25.1",
};

function npmTarball(name: string, version: string): string {
  return `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;
}

function sourceRuntimeIdentity(
  name: string,
  version: string,
  integrity: string,
): { integrity: string; version: string } {
  return name === "fast-uri"
    ? {
        version: "3.1.2",
        integrity:
          "sha512-rVjf7ArG3LTk+FS6Yw81V1DLuZl1bRbNrev6Tmd/9RaroeeRRJhAt7jg/6YFxbvAQXUCavSoZhPPj6oOx+5KjQ==",
      }
    : { integrity, version };
}

function writeFixture(axiosVersion = "1.16.0"): string {
  const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-openclaw-npm-remediation-"));
  temporaryDirectories.push(directory);
  writeFileSync(
    path.join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "@openclaw/slack",
        version: "2026.6.10",
        dependencies: { "@slack/bolt": "4.7.3" },
        bundledDependencies: ["@slack/bolt"],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(directory, "npm-shrinkwrap.json"),
    `${JSON.stringify(
      {
        name: "@openclaw/slack",
        version: "2026.6.10",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: "@openclaw/slack",
            version: "2026.6.10",
            dependencies: { "@slack/bolt": "4.7.3" },
          },
          "node_modules/axios": {
            version: axiosVersion,
            resolved: `https://registry.npmjs.org/axios/-/axios-${axiosVersion}.tgz`,
            integrity: "sha512-old",
            dependencies: {
              "follow-redirects": "^1.16.0",
              "form-data": "^4.0.5",
              "proxy-from-env": "^2.1.0",
            },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return directory;
}

function writeCoreFixture(tarVersion = "7.5.16"): string {
  const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-openclaw-core-remediation-"));
  temporaryDirectories.push(directory);
  writeFileSync(
    path.join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "openclaw",
        version: "2026.6.10",
        dependencies: {
          "@modelcontextprotocol/sdk": "1.29.0",
          "@openclaw/fs-safe": "0.3.0",
          jszip: "3.10.1",
          minimatch: "10.2.5",
          tar: tarVersion,
          zod: "4.4.3",
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(directory, "npm-shrinkwrap.json"),
    `${JSON.stringify(
      {
        name: "openclaw",
        version: "2026.6.10",
        lockfileVersion: 3,
        packages: {
          "": {
            name: "openclaw",
            version: "2026.6.10",
            dependencies: {
              "@modelcontextprotocol/sdk": "1.29.0",
              "@openclaw/fs-safe": "0.3.0",
              jszip: "3.10.1",
              minimatch: "10.2.5",
              tar: tarVersion,
              zod: "4.4.3",
            },
          },
          "node_modules/@openclaw/fs-safe": {
            version: "0.3.0",
            optionalDependencies: { jszip: "^3.10.1", tar: "7.5.13" },
          },
          "node_modules/@hono/node-server": {
            version: "1.19.14",
            resolved: "https://registry.npmjs.org/@hono/node-server/-/node-server-1.19.14.tgz",
            integrity:
              "sha512-GwtvgtXxnWsucXvbQXkRgqksiH2Qed37H9xHZocE5sA3N8O8O8/8FA3uclQXxXVzc9XBZuEOMK7+r02FmSpHtw==",
          },
          "node_modules/@modelcontextprotocol/sdk": {
            version: "1.29.0",
            dependencies: {
              "@hono/node-server": "^1.19.9",
              ...MCP_CLIENT_DEPENDENCIES,
            },
            peerDependencies: { zod: "^3.25 || ^4.0" },
            peerDependenciesMeta: { zod: { optional: false } },
          },
          ...Object.fromEntries(
            MCP_RUNTIME_PACKAGES.map(([name, version, integrity, dependencies]) => {
              const source = sourceRuntimeIdentity(name, version, integrity);
              return [
                `node_modules/${name}`,
                {
                  version: source.version,
                  resolved: npmTarball(name, source.version),
                  integrity: source.integrity,
                  ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
                },
              ];
            }),
          ),
          "node_modules/brace-expansion": {
            version: "5.0.6",
            resolved: "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.6.tgz",
            integrity: "sha512-old-brace-expansion",
          },
          "node_modules/minimatch": {
            version: "10.2.5",
            dependencies: { "brace-expansion": "^5.0.5" },
          },
          "node_modules/jszip": {
            version: "3.10.1",
            resolved: "https://registry.npmjs.org/jszip/-/jszip-3.10.1.tgz",
            integrity:
              "sha512-xXDvecyTpGLrqFrvkrUSoxxfJI5AH7U8zxxtVclpsUtMCq4JQ290LY8AW5c7Ggnr/Y/oK+bQMbqK2qmtk3pN4g==",
          },
          "node_modules/tar": {
            version: tarVersion,
            resolved: `https://registry.npmjs.org/tar/-/tar-${tarVersion}.tgz`,
            integrity: "sha512-old-tar",
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return directory;
}

function writeOtelFixture(jaegerVersion = "2.8.0"): string {
  const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-openclaw-otel-remediation-"));
  temporaryDirectories.push(directory);
  writeFileSync(
    path.join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "@openclaw/diagnostics-otel",
        version: "2026.6.10",
        dependencies: { "@opentelemetry/sdk-node": "0.219.0" },
        bundledDependencies: ["@opentelemetry/sdk-node"],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(directory, "npm-shrinkwrap.json"),
    `${JSON.stringify(
      {
        name: "@openclaw/diagnostics-otel",
        version: "2026.6.10",
        lockfileVersion: 3,
        packages: {
          "": {
            name: "@openclaw/diagnostics-otel",
            version: "2026.6.10",
            dependencies: { "@opentelemetry/sdk-node": "0.219.0" },
          },
          "node_modules/@opentelemetry/propagator-jaeger": {
            version: jaegerVersion,
            resolved: `https://registry.npmjs.org/@opentelemetry/propagator-jaeger/-/propagator-jaeger-${jaegerVersion}.tgz`,
            integrity:
              jaegerVersion === "2.8.0"
                ? "sha512-Xnz9zZvvQzUw+9DrOn0MomR7BxFCkA2pcfXBQuHC28ndJpSbjLs7knzYb05kw5SyCjSsEWombkZMgGcJSk8JVg=="
                : "sha512-drift",
            dependencies: { "@opentelemetry/core": jaegerVersion },
          },
          "node_modules/@opentelemetry/sdk-node": {
            version: "0.219.0",
            dependencies: {
              "@opentelemetry/core": "2.8.0",
              "@opentelemetry/propagator-jaeger": jaegerVersion,
            },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return directory;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf-8")) as T;
}

function packFixture(packageDirectory: string, archivePath: string): void {
  const root = mkdtempSync(path.join(tmpdir(), "nemoclaw-openclaw-archive-fixture-"));
  temporaryDirectories.push(root);
  cpSync(packageDirectory, path.join(root, "package"), { recursive: true });
  const result = spawnSync("tar", ["-czf", archivePath, "-C", root, "package"], {
    encoding: "utf-8",
  });
  expect(result.status, result.stderr || "failed to pack OpenClaw test archive").toBe(0);
}

function writeCoreArchiveFixtures(): {
  archivePath: string;
  executableMemberPath: string;
  longMemberPath: string;
  npmExecutable: string;
  workingDirectory: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), "nemoclaw-openclaw-build-remediation-"));
  temporaryDirectories.push(root);
  const archivePath = path.join(root, "openclaw-2026.6.10.tgz");
  const coreFixture = writeCoreFixture();
  const longMemberPath = path.join(
    "node_modules",
    "@openclaw",
    ...Array.from({ length: 8 }, (_, index) => `dependency-with-a-long-name-${index}`),
    "fixture.txt",
  );
  const longMemberDirectory = path.join(coreFixture, path.dirname(longMemberPath));
  mkdirSync(longMemberDirectory, { recursive: true });
  chmodSync(longMemberDirectory, 0o700);
  writeFileSync(path.join(coreFixture, longMemberPath), "long archive member\n", { mode: 0o600 });
  const executableMemberPath = path.join("bin", "reviewed-tool");
  mkdirSync(path.join(coreFixture, path.dirname(executableMemberPath)), { recursive: true });
  writeFileSync(path.join(coreFixture, executableMemberPath), "#!/bin/sh\n", { mode: 0o700 });
  packFixture(coreFixture, archivePath);

  const fsSafeDirectory = path.join(root, "fs-safe-package");
  mkdirSync(fsSafeDirectory, { recursive: true });
  writeFileSync(
    path.join(fsSafeDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "@openclaw/fs-safe",
        version: "0.3.0",
        optionalDependencies: { jszip: "^3.10.1", tar: "7.5.13" },
      },
      null,
      2,
    )}\n`,
  );
  const fsSafeArchive = path.join(root, "fs-safe-0.3.0-source.tgz");
  packFixture(fsSafeDirectory, fsSafeArchive);

  const modelContextProtocolSdkDirectory = path.join(root, "modelcontextprotocol-sdk-package");
  mkdirSync(modelContextProtocolSdkDirectory, { recursive: true });
  writeFileSync(
    path.join(modelContextProtocolSdkDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "@modelcontextprotocol/sdk",
        version: "1.29.0",
        dependencies: {
          "@hono/node-server": "^1.19.9",
          ...MCP_CLIENT_DEPENDENCIES,
        },
        peerDependencies: { zod: "^3.25 || ^4.0" },
        peerDependenciesMeta: { zod: { optional: false } },
      },
      null,
      2,
    )}\n`,
  );
  const modelContextProtocolSdkArchive = path.join(root, "sdk-1.29.0-source.tgz");
  packFixture(modelContextProtocolSdkDirectory, modelContextProtocolSdkArchive);

  const honoNodeServerDirectory = path.join(root, "hono-node-server-package");
  mkdirSync(honoNodeServerDirectory, { recursive: true });
  writeFileSync(
    path.join(honoNodeServerDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "@hono/node-server",
        version: "2.0.11",
        peerDependencies: { hono: "^4" },
      },
      null,
      2,
    )}\n`,
  );
  const honoNodeServerArchive = path.join(root, "node-server-2.0.11-source.tgz");
  packFixture(honoNodeServerDirectory, honoNodeServerArchive);

  const runtimeFixtures = MCP_RUNTIME_PACKAGES.map(
    ([name, version, integrity, dependencies], index) => {
      const directory = path.join(root, `mcp-runtime-${index}`);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        path.join(directory, "package.json"),
        `${JSON.stringify(
          {
            name,
            version,
            ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
          },
          null,
          2,
        )}\n`,
      );
      const archive = path.join(root, `${name}-${version}-source.tgz`);
      packFixture(directory, archive);
      return {
        archive,
        filename: `${name}-${version}.tgz`,
        integrity,
        name,
        tarball: npmTarball(name, version),
        variable: `mcp_runtime_archive_${index}`,
        version,
      };
    },
  );

  const npmExecutable = path.join(root, "npm-fixture.sh");
  writeFileSync(
    npmExecutable,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `fs_safe_archive=${JSON.stringify(fsSafeArchive)}`,
      `modelcontextprotocol_sdk_archive=${JSON.stringify(modelContextProtocolSdkArchive)}`,
      `hono_node_server_archive=${JSON.stringify(honoNodeServerArchive)}`,
      ...runtimeFixtures.map(({ archive, variable }) => `${variable}=${JSON.stringify(archive)}`),
      'if [ "$1" = "view" ]; then',
      '  case "$2:$3" in',
      '    "@openclaw/fs-safe@0.3.0:dist.integrity") value="sha512-uIBE441CIt1kIURoP9qRGKZ8LkGyfD9ZzeESjwAd29ZPWtghws/5GR3Pjb67jKdcJHP1I6roNXcvnhzAU7lHlA==" ;;',
      '    "@openclaw/fs-safe@0.3.0:dist.tarball") value="https://registry.npmjs.org/@openclaw/fs-safe/-/fs-safe-0.3.0.tgz" ;;',
      '    "@modelcontextprotocol/sdk@1.29.0:dist.integrity") value="sha512-zo37mZA9hJWpULgkRpowewez1y6ML5GsXJPY8FI0tBBCd77HEvza4jDqRKOXgHNn867PVGCyTdzqpz0izu5ZjQ==" ;;',
      '    "@modelcontextprotocol/sdk@1.29.0:dist.tarball") value="https://registry.npmjs.org/@modelcontextprotocol/sdk/-/sdk-1.29.0.tgz" ;;',
      '    "@hono/node-server@2.0.11:dist.integrity") value="sha512-bjD221KPLoJTWUwso1J6fGKiTXEUFedG/s0visavY4zakFPkeGURMRNly+FhBHs7T8Dz4qHaZIMX9ZoJHSJtKA==" ;;',
      '    "@hono/node-server@2.0.11:dist.tarball") value="https://registry.npmjs.org/@hono/node-server/-/node-server-2.0.11.tgz" ;;',
      ...runtimeFixtures.flatMap(({ integrity, name, tarball, version }) => [
        `    "${name}@${version}:dist.integrity") value="${integrity}" ;;`,
        `    "${name}@${version}:dist.tarball") value="${tarball}" ;;`,
      ]),
      "    *) exit 1 ;;",
      "  esac",
      '  printf "%s\\n" "$value"',
      "  exit 0",
      "fi",
      'if [ "$1" = "pack" ]; then',
      '  case "$2" in',
      '    "https://registry.npmjs.org/@openclaw/fs-safe/-/fs-safe-0.3.0.tgz") archive="$fs_safe_archive"; filename="fs-safe-0.3.0.tgz"; integrity="sha512-uIBE441CIt1kIURoP9qRGKZ8LkGyfD9ZzeESjwAd29ZPWtghws/5GR3Pjb67jKdcJHP1I6roNXcvnhzAU7lHlA==" ;;',
      '    "https://registry.npmjs.org/@modelcontextprotocol/sdk/-/sdk-1.29.0.tgz") archive="$modelcontextprotocol_sdk_archive"; filename="sdk-1.29.0.tgz"; integrity="sha512-zo37mZA9hJWpULgkRpowewez1y6ML5GsXJPY8FI0tBBCd77HEvza4jDqRKOXgHNn867PVGCyTdzqpz0izu5ZjQ==" ;;',
      '    "https://registry.npmjs.org/@hono/node-server/-/node-server-2.0.11.tgz") archive="$hono_node_server_archive"; filename="node-server-2.0.11.tgz"; integrity="sha512-bjD221KPLoJTWUwso1J6fGKiTXEUFedG/s0visavY4zakFPkeGURMRNly+FhBHs7T8Dz4qHaZIMX9ZoJHSJtKA==" ;;',
      ...runtimeFixtures.map(
        ({ filename, integrity, tarball, variable }) =>
          `    "${tarball}") archive="$${variable}"; filename="${filename}"; integrity="${integrity}" ;;`,
      ),
      "    *) exit 1 ;;",
      "  esac",
      '  destination=""',
      '  while [ "$#" -gt 0 ]; do',
      '    if [ "$1" = "--pack-destination" ]; then destination="$2"; shift 2; continue; fi',
      "    shift",
      "  done",
      '  cp "$archive" "$destination/$filename"',
      '  printf \'[{"filename":"%s","integrity":"%s"}]\\n\' "$filename" "$integrity"',
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  chmodSync(npmExecutable, 0o700);
  return {
    archivePath,
    executableMemberPath,
    longMemberPath,
    npmExecutable,
    workingDirectory: path.join(root, "work"),
  };
}

function writePluginArchiveFixtures(): {
  archivePath: string;
  npmExecutable: string;
  workingDirectory: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), "nemoclaw-openclaw-plugin-remediation-"));
  temporaryDirectories.push(root);
  const archivePath = path.join(root, "slack-2026.6.10.tgz");
  packFixture(writeFixture(), archivePath);

  const replacements = [
    {
      archive: "axios-1.18.0-source.tgz",
      dependencies: {
        "follow-redirects": "^1.16.0",
        "form-data": "^4.0.5",
        "https-proxy-agent": "^5.0.1",
        "proxy-from-env": "^2.1.0",
      },
      name: "axios",
      version: "1.18.0",
    },
    {
      archive: "https-proxy-agent-5.0.1-source.tgz",
      dependencies: { "agent-base": "6", debug: "4" },
      name: "https-proxy-agent",
      version: "5.0.1",
    },
    {
      archive: "agent-base-6.0.2-source.tgz",
      dependencies: { debug: "4" },
      name: "agent-base",
      version: "6.0.2",
    },
  ] as const;
  for (const replacement of replacements) {
    const directory = path.join(root, `${replacement.name}-package`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, "package.json"),
      `${JSON.stringify(
        {
          dependencies: replacement.dependencies,
          name: replacement.name,
          version: replacement.version,
        },
        null,
        2,
      )}\n`,
    );
    packFixture(directory, path.join(root, replacement.archive));
  }

  const npmExecutable = path.join(root, "npm-fixture.sh");
  writeFileSync(
    npmExecutable,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `fixture_root=${JSON.stringify(root)}`,
      'case "$1:$2:${3:-}" in',
      '  "view:axios@1.18.0:dist.integrity") value="sha512-E32NzpYKp++W7XRe52rHiXV2ehxmh3wbdgO7MHeFM+vqxLBYHzt0ElkiImtOBxtOmyp0yoC8C6uESVV84Y2/hw==" ;;',
      '  "view:axios@1.18.0:dist.tarball") value="https://registry.npmjs.org/axios/-/axios-1.18.0.tgz" ;;',
      '  "view:https-proxy-agent@5.0.1:dist.integrity") value="sha512-dFcAjpTQFgoLMzC2VwU+C/CbS7uRL0lWmxDITmqm7C+7F0Odmj6s9l6alZc6AELXhrnggM2CeWSXHGOdX2YtwA==" ;;',
      '  "view:https-proxy-agent@5.0.1:dist.tarball") value="https://registry.npmjs.org/https-proxy-agent/-/https-proxy-agent-5.0.1.tgz" ;;',
      '  "view:agent-base@6.0.2:dist.integrity") value="sha512-RZNwNclF7+MS/8bDg70amg32dyeZGZxiDuQmZxKLAlQjr3jGyLx+4Kkk58UO7D2QdgFIQCovuSuZESne6RG6XQ==" ;;',
      '  "view:agent-base@6.0.2:dist.tarball") value="https://registry.npmjs.org/agent-base/-/agent-base-6.0.2.tgz" ;;',
      '  "pack:https://registry.npmjs.org/axios/-/axios-1.18.0.tgz:--pack-destination") archive="axios-1.18.0-source.tgz"; filename="axios-1.18.0.tgz"; integrity="sha512-E32NzpYKp++W7XRe52rHiXV2ehxmh3wbdgO7MHeFM+vqxLBYHzt0ElkiImtOBxtOmyp0yoC8C6uESVV84Y2/hw==" ;;',
      '  "pack:https://registry.npmjs.org/https-proxy-agent/-/https-proxy-agent-5.0.1.tgz:--pack-destination") archive="https-proxy-agent-5.0.1-source.tgz"; filename="https-proxy-agent-5.0.1.tgz"; integrity="sha512-dFcAjpTQFgoLMzC2VwU+C/CbS7uRL0lWmxDITmqm7C+7F0Odmj6s9l6alZc6AELXhrnggM2CeWSXHGOdX2YtwA==" ;;',
      '  "pack:https://registry.npmjs.org/agent-base/-/agent-base-6.0.2.tgz:--pack-destination") archive="agent-base-6.0.2-source.tgz"; filename="agent-base-6.0.2.tgz"; integrity="sha512-RZNwNclF7+MS/8bDg70amg32dyeZGZxiDuQmZxKLAlQjr3jGyLx+4Kkk58UO7D2QdgFIQCovuSuZESne6RG6XQ==" ;;',
      '  *) echo "unexpected npm fixture invocation: $*" >&2; exit 1 ;;',
      "esac",
      'if [ "$1" = "view" ]; then printf "%s\\n" "$value"; exit 0; fi',
      'destination=""',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "--pack-destination" ]; then destination="$2"; shift 2; continue; fi',
      "  shift",
      "done",
      'cp "$fixture_root/$archive" "$destination/$filename"',
      'printf \'[{"filename":"%s","integrity":"%s"}]\\n\' "$filename" "$integrity"',
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  chmodSync(npmExecutable, 0o700);
  return { archivePath, npmExecutable, workingDirectory: path.join(root, "work") };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("OpenClaw npm remediation", () => {
  // source-shape-contract: security -- Exact replacement metadata binds the rebuilt plugin archive to the reviewed registry identities
  it("replaces the reviewed bundled Axios graph with the patched graph", () => {
    const directory = writeFixture();

    patchOpenClawPluginPackageGraph(directory, "@openclaw/slack@2026.6.10");

    const shrinkwrap = readJson<{
      packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
    }>(path.join(directory, "npm-shrinkwrap.json"));
    const packageJson = readJson<{
      bundledDependencies?: string[];
      dependencies?: Record<string, string>;
    }>(path.join(directory, "package.json"));
    expect(packageJson.dependencies).toMatchObject({ axios: "1.18.0" });
    expect(packageJson.bundledDependencies).toContain("axios");
    expect(shrinkwrap.packages["node_modules/axios"]).toMatchObject({
      version: "1.18.0",
      resolved: "https://registry.npmjs.org/axios/-/axios-1.18.0.tgz",
      integrity:
        "sha512-E32NzpYKp++W7XRe52rHiXV2ehxmh3wbdgO7MHeFM+vqxLBYHzt0ElkiImtOBxtOmyp0yoC8C6uESVV84Y2/hw==",
      dependencies: { "https-proxy-agent": "^5.0.1" },
    });
    expect(shrinkwrap.packages["node_modules/axios/node_modules/https-proxy-agent"]).toMatchObject({
      version: "5.0.1",
      resolved: "https://registry.npmjs.org/https-proxy-agent/-/https-proxy-agent-5.0.1.tgz",
      integrity:
        "sha512-dFcAjpTQFgoLMzC2VwU+C/CbS7uRL0lWmxDITmqm7C+7F0Odmj6s9l6alZc6AELXhrnggM2CeWSXHGOdX2YtwA==",
      dependencies: { "agent-base": "6" },
    });
    expect(
      shrinkwrap.packages[
        "node_modules/axios/node_modules/https-proxy-agent/node_modules/agent-base"
      ],
    ).toMatchObject({
      version: "6.0.2",
      resolved: "https://registry.npmjs.org/agent-base/-/agent-base-6.0.2.tgz",
      integrity:
        "sha512-RZNwNclF7+MS/8bDg70amg32dyeZGZxiDuQmZxKLAlQjr3jGyLx+4Kkk58UO7D2QdgFIQCovuSuZESne6RG6XQ==",
      dependencies: { debug: "4" },
    });
  });

  it("rejects an upstream Axios graph that changed after review", () => {
    const directory = writeFixture("1.17.0");

    expect(() => patchOpenClawPluginPackageGraph(directory, "@openclaw/slack@2026.6.10")).toThrow(
      "must resolve node_modules/axios to 1.16.0 before remediation",
    );
  });

  it("replaces the reviewed diagnostics OTEL Jaeger subtree", () => {
    const directory = writeOtelFixture();

    patchOpenClawOtelPluginPackageGraph(directory);

    const shrinkwrap = readJson<{
      packages: Record<
        string,
        {
          dependencies?: Record<string, string>;
          integrity?: string;
          resolved?: string;
          version?: string;
        }
      >;
    }>(path.join(directory, "npm-shrinkwrap.json"));
    expect(
      shrinkwrap.packages["node_modules/@opentelemetry/sdk-node"]?.dependencies?.[
        "@opentelemetry/propagator-jaeger"
      ],
    ).toBe("2.9.0");
    expect(shrinkwrap.packages["node_modules/@opentelemetry/propagator-jaeger"]).toMatchObject({
      version: "2.9.0",
      resolved:
        "https://registry.npmjs.org/@opentelemetry/propagator-jaeger/-/propagator-jaeger-2.9.0.tgz",
      integrity:
        "sha512-4mYGty27rYvSM0jtp1ZUOqd3LfVRCYg9H5G9OFzSx5HViYToU21MFhWfco7x1HwXr7ER8yGOiCIHZUwjPksc0Q==",
    });
    expect(
      shrinkwrap.packages[
        "node_modules/@opentelemetry/propagator-jaeger/node_modules/@opentelemetry/core"
      ],
    ).toMatchObject({
      version: "2.9.0",
      resolved: "https://registry.npmjs.org/@opentelemetry/core/-/core-2.9.0.tgz",
      integrity:
        "sha512-m2nckMT80NnmjTYSPjJQObBJ+8dgkoajEOUbznL8AHZ3T3yHRk2P7gI1PhEBc1+lOnrYE9UWrWHqJDsmqjmNbw==",
    });
  });

  it("rejects a diagnostics OTEL Jaeger graph that changed after review", () => {
    const directory = writeOtelFixture("2.8.1");
    expect(() => patchOpenClawOtelPluginPackageGraph(directory)).toThrow(
      "Jaeger graph changed after review",
    );
  });

  // source-shape-contract: security -- Exact core shrinkwrap metadata binds remediation output to the reviewed registry identities
  it("replaces the reviewed OpenClaw core tar and brace-expansion graph", () => {
    const directory = writeCoreFixture();

    patchOpenClawCorePackageGraph(directory);

    const shrinkwrap = readJson<{
      packages: Record<
        string,
        {
          bundleDependencies?: string[];
          dependencies?: Record<string, string>;
          integrity?: string;
          optionalDependencies?: Record<string, string>;
          resolved?: string;
          version?: string;
        }
      >;
    }>(path.join(directory, "npm-shrinkwrap.json"));
    const packageJson = readJson<{
      bundledDependencies?: string[];
      dependencies?: Record<string, string>;
    }>(path.join(directory, "package.json"));
    expect(packageJson.dependencies).toMatchObject({ jszip: "3.10.1", tar: "7.5.19" });
    expect(packageJson.bundledDependencies).toEqual([
      "@hono/node-server",
      "@modelcontextprotocol/sdk",
      "@openclaw/fs-safe",
      ...MCP_RUNTIME_PACKAGES.map(([name]) => name),
    ]);
    expect(shrinkwrap.packages[""]).toMatchObject({
      bundleDependencies: [
        "@hono/node-server",
        "@modelcontextprotocol/sdk",
        "@openclaw/fs-safe",
        ...MCP_RUNTIME_PACKAGES.map(([name]) => name),
      ],
      dependencies: { tar: "7.5.19" },
    });
    expect(shrinkwrap.packages["node_modules/tar"]).toMatchObject({
      version: "7.5.19",
      resolved: "https://registry.npmjs.org/tar/-/tar-7.5.19.tgz",
      integrity:
        "sha512-4LeEWl96twnS2Q7Bz4MGqgazLqO+hJN63GZxXoIqh1T3VweYD997gbU1ItNsQafqqXTXd5WFyFdReLtwvRBNiw==",
    });
    expect(shrinkwrap.packages["node_modules/@openclaw/fs-safe"]?.optionalDependencies).toBe(
      undefined,
    );
    expect(shrinkwrap.packages["node_modules/@hono/node-server"]).toMatchObject({
      version: "2.0.11",
      resolved: "https://registry.npmjs.org/@hono/node-server/-/node-server-2.0.11.tgz",
      integrity:
        "sha512-bjD221KPLoJTWUwso1J6fGKiTXEUFedG/s0visavY4zakFPkeGURMRNly+FhBHs7T8Dz4qHaZIMX9ZoJHSJtKA==",
    });
    expect(
      shrinkwrap.packages["node_modules/@modelcontextprotocol/sdk"]?.dependencies?.[
        "@hono/node-server"
      ],
    ).toBe("2.0.11");
    for (const [name, version, integrity] of MCP_RUNTIME_PACKAGES) {
      expect(shrinkwrap.packages[`node_modules/${name}`]).toMatchObject({
        version,
        resolved: npmTarball(name, version),
        integrity,
      });
    }
    expect(shrinkwrap.packages["node_modules/brace-expansion"]).toMatchObject({
      version: "5.0.7",
      resolved: "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.7.tgz",
      integrity:
        "sha512-7oFy703dxfY3/NLxC1fh2SUCQ0H9rmAY+5EpDVfXjUTTs+HEwR2nYaqLv+GWcTsumwxPfiz6CzCNkwXwBUwqCA==",
    });
  });

  it("rejects an OpenClaw core tar graph that changed after review", () => {
    const directory = writeCoreFixture("7.5.17");

    expect(() => patchOpenClawCorePackageGraph(directory)).toThrow(
      "must declare reviewed tar@7.5.16 before remediation",
    );
  });

  // source-shape-contract: security -- Archive metadata proves the rebuilt package carries every reviewed bundled core remediation
  it("rebuilds a guarded core archive with the patched dependency graph bundled", () => {
    const fixture = writeCoreArchiveFixtures();
    const request = {
      archivePath: fixture.archivePath,
      env: { NEMOCLAW_REVIEWED_NPM_EXECUTABLE: fixture.npmExecutable },
      packageSpec: "openclaw@2026.6.10",
      workingDirectory: fixture.workingDirectory,
    };
    let metadataIntegrity = "";
    try {
      buildRemediatedOpenClawArchive({
        ...request,
        expectedPatchedMetadataIntegrity: "sha512-deliberate-mismatch",
      });
    } catch (error) {
      const message = String(error);
      expect(message).toMatch(/got sha512-\S+/u);
      metadataIntegrity = message.match(/got (sha512-\S+)/u)?.[1] ?? "";
    }
    expect(metadataIntegrity).toMatch(/^sha512-/u);

    const originalUmask = process.umask(0o022);
    let remediated: ReturnType<typeof buildRemediatedOpenClawArchive>;
    try {
      remediated = buildRemediatedOpenClawArchive({
        ...request,
        expectedPatchedMetadataIntegrity: metadataIntegrity,
      });
      expect(remediated).toMatchObject({ metadataIntegrity, remediated: true });
      process.umask(0o077);
      const rebuilt = buildRemediatedOpenClawArchive({
        ...request,
        env: { ...request.env, GZIP: "-1", TAR_OPTIONS: "--format=pax" },
        expectedPatchedMetadataIntegrity: metadataIntegrity,
      });
      expect(rebuilt.integrity).toBe(remediated.integrity);
    } finally {
      process.umask(originalUmask);
    }
    const listing = spawnSync("tar", ["-tzf", remediated.archivePath], { encoding: "utf-8" });
    expect(listing.status, listing.stderr).toBe(0);
    const archiveMembers = listing.stdout
      .trimEnd()
      .split("\n")
      .map((member) => (member.endsWith("/") ? member.slice(0, -1) : member));
    expect(archiveMembers).toEqual([...archiveMembers].sort());
    const extracted = path.join(fixture.workingDirectory, "asserted");
    mkdirSync(extracted, { recursive: true });
    const extraction = spawnSync("tar", ["-xzf", remediated.archivePath, "-C", extracted], {
      encoding: "utf-8",
    });
    expect(extraction.status, extraction.stderr).toBe(0);
    const packageJson = readJson<{
      bundledDependencies?: string[];
      dependencies?: Record<string, string>;
    }>(path.join(extracted, "package", "package.json"));
    const fsSafePackageJson = readJson<{ optionalDependencies?: Record<string, string> }>(
      path.join(extracted, "package", "node_modules", "@openclaw", "fs-safe", "package.json"),
    );
    const modelContextProtocolSdkPackageJson = readJson<{
      dependencies?: Record<string, string>;
    }>(
      path.join(
        extracted,
        "package",
        "node_modules",
        "@modelcontextprotocol",
        "sdk",
        "package.json",
      ),
    );
    const honoNodeServerPackageJson = readJson<{ name?: string; version?: string }>(
      path.join(extracted, "package", "node_modules", "@hono", "node-server", "package.json"),
    );
    expect(packageJson).toMatchObject({
      bundledDependencies: [
        "@hono/node-server",
        "@modelcontextprotocol/sdk",
        "@openclaw/fs-safe",
        ...MCP_RUNTIME_PACKAGES.map(([name]) => name),
      ],
      dependencies: { jszip: "3.10.1", tar: "7.5.19" },
    });
    expect(fsSafePackageJson.optionalDependencies).toBeUndefined();
    expect(modelContextProtocolSdkPackageJson.dependencies?.["@hono/node-server"]).toBe("2.0.11");
    expect(honoNodeServerPackageJson).toMatchObject({
      name: "@hono/node-server",
      version: "2.0.11",
    });
    for (const [name, version] of MCP_RUNTIME_PACKAGES) {
      expect(
        readJson<{ name?: string; version?: string }>(
          path.join(extracted, "package", "node_modules", name, "package.json"),
        ),
      ).toMatchObject({ name, version });
    }
    expect(readFileSync(path.join(extracted, "package", fixture.longMemberPath), "utf-8")).toBe(
      "long archive member\n",
    );
    expect(statSync(path.join(extracted, "package", fixture.longMemberPath)).mode & 0o777).toBe(
      0o644,
    );
    expect(
      statSync(path.join(extracted, "package", path.dirname(fixture.longMemberPath))).mode & 0o777,
    ).toBe(0o755);
    expect(
      statSync(path.join(extracted, "package", fixture.executableMemberPath)).mode & 0o777,
    ).toBe(0o755);
  });

  // source-shape-contract: security -- Extracted plugin contents prove the rebuilt archive carries every reviewed Axios replacement package
  it("rebuilds a guarded plugin archive with the patched Axios graph bundled", () => {
    const fixture = writePluginArchiveFixtures();
    const request = {
      archivePath: fixture.archivePath,
      env: { NEMOCLAW_REVIEWED_NPM_EXECUTABLE: fixture.npmExecutable },
      packageSpec: "@openclaw/slack@2026.6.10",
      workingDirectory: fixture.workingDirectory,
    };
    let metadataIntegrity = "";
    try {
      buildRemediatedOpenClawArchive({
        ...request,
        expectedPatchedMetadataIntegrity: "sha512-deliberate-mismatch",
      });
    } catch (error) {
      const message = String(error);
      expect(message).toMatch(/got sha512-\S+/u);
      metadataIntegrity = message.match(/got (sha512-\S+)/u)?.[1] ?? "";
    }
    expect(metadataIntegrity).toMatch(/^sha512-/u);

    const remediated = buildRemediatedOpenClawArchive({
      ...request,
      expectedPatchedMetadataIntegrity: metadataIntegrity,
    });
    const extracted = path.join(fixture.workingDirectory, "asserted-plugin");
    mkdirSync(extracted, { recursive: true });
    const extraction = spawnSync("tar", ["-xzf", remediated.archivePath, "-C", extracted], {
      encoding: "utf-8",
    });
    expect(extraction.status, extraction.stderr).toBe(0);
    const axiosPackageJson = readJson<{ name: string; version: string }>(
      path.join(extracted, "package", "node_modules", "axios", "package.json"),
    );
    const proxyPackageJson = readJson<{ name: string; version: string }>(
      path.join(
        extracted,
        "package",
        "node_modules",
        "axios",
        "node_modules",
        "https-proxy-agent",
        "package.json",
      ),
    );
    const agentBasePackageJson = readJson<{ name: string; version: string }>(
      path.join(
        extracted,
        "package",
        "node_modules",
        "axios",
        "node_modules",
        "https-proxy-agent",
        "node_modules",
        "agent-base",
        "package.json",
      ),
    );
    expect(axiosPackageJson).toEqual(expect.objectContaining({ name: "axios", version: "1.18.0" }));
    expect(proxyPackageJson).toEqual(
      expect.objectContaining({ name: "https-proxy-agent", version: "5.0.1" }),
    );
    expect(agentBasePackageJson).toEqual(
      expect.objectContaining({ name: "agent-base", version: "6.0.2" }),
    );
  });
});
