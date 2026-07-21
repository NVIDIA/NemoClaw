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
              "eventsource-parser": "^3.0.0",
            },
          },
          "node_modules/eventsource-parser": {
            version: "3.1.0",
            resolved:
              "https://registry.npmjs.org/eventsource-parser/-/eventsource-parser-3.1.0.tgz",
            integrity:
              "sha512-kJezFj9YFAMLeORyi7aCLxLbD5/qWMQnoMVlVPyHIll7lgRJCc3JVln9Vgl9nwQi0YkMnhdGTMNn7CkRRAptMg==",
          },
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
  mkdirSync(path.join(coreFixture, path.dirname(longMemberPath)), { recursive: true });
  writeFileSync(path.join(coreFixture, longMemberPath), "long archive member\n");
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
          "eventsource-parser": "^3.0.0",
        },
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
        version: "2.0.5",
        peerDependencies: { hono: "^4" },
      },
      null,
      2,
    )}\n`,
  );
  const honoNodeServerArchive = path.join(root, "node-server-2.0.5-source.tgz");
  packFixture(honoNodeServerDirectory, honoNodeServerArchive);

  const eventsourceParserDirectory = path.join(root, "eventsource-parser-package");
  mkdirSync(eventsourceParserDirectory, { recursive: true });
  writeFileSync(
    path.join(eventsourceParserDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "eventsource-parser",
        version: "3.1.0",
        engines: { node: ">=18.0.0" },
      },
      null,
      2,
    )}\n`,
  );
  const eventsourceParserArchive = path.join(root, "eventsource-parser-3.1.0-source.tgz");
  packFixture(eventsourceParserDirectory, eventsourceParserArchive);

  const npmExecutable = path.join(root, "npm-fixture.sh");
  writeFileSync(
    npmExecutable,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `fs_safe_archive=${JSON.stringify(fsSafeArchive)}`,
      `modelcontextprotocol_sdk_archive=${JSON.stringify(modelContextProtocolSdkArchive)}`,
      `hono_node_server_archive=${JSON.stringify(honoNodeServerArchive)}`,
      `eventsource_parser_archive=${JSON.stringify(eventsourceParserArchive)}`,
      'if [ "$1" = "view" ]; then',
      '  case "$2:$3" in',
      '    "@openclaw/fs-safe@0.3.0:dist.integrity") value="sha512-uIBE441CIt1kIURoP9qRGKZ8LkGyfD9ZzeESjwAd29ZPWtghws/5GR3Pjb67jKdcJHP1I6roNXcvnhzAU7lHlA==" ;;',
      '    "@openclaw/fs-safe@0.3.0:dist.tarball") value="https://registry.npmjs.org/@openclaw/fs-safe/-/fs-safe-0.3.0.tgz" ;;',
      '    "@modelcontextprotocol/sdk@1.29.0:dist.integrity") value="sha512-zo37mZA9hJWpULgkRpowewez1y6ML5GsXJPY8FI0tBBCd77HEvza4jDqRKOXgHNn867PVGCyTdzqpz0izu5ZjQ==" ;;',
      '    "@modelcontextprotocol/sdk@1.29.0:dist.tarball") value="https://registry.npmjs.org/@modelcontextprotocol/sdk/-/sdk-1.29.0.tgz" ;;',
      '    "@hono/node-server@2.0.5:dist.integrity") value="sha512-yQFvDmyDo3y6rEOJZDUYPJ49DIKTPpIk4kGvm40xx4Ejne0Pu9a1+exxPN+C1UppWK/WGZX9F++/Xs231tE86g==" ;;',
      '    "@hono/node-server@2.0.5:dist.tarball") value="https://registry.npmjs.org/@hono/node-server/-/node-server-2.0.5.tgz" ;;',
      '    "eventsource-parser@3.1.0:dist.integrity") value="sha512-kJezFj9YFAMLeORyi7aCLxLbD5/qWMQnoMVlVPyHIll7lgRJCc3JVln9Vgl9nwQi0YkMnhdGTMNn7CkRRAptMg==" ;;',
      '    "eventsource-parser@3.1.0:dist.tarball") value="https://registry.npmjs.org/eventsource-parser/-/eventsource-parser-3.1.0.tgz" ;;',
      "    *) exit 1 ;;",
      "  esac",
      '  printf "%s\\n" "$value"',
      "  exit 0",
      "fi",
      'if [ "$1" = "pack" ]; then',
      '  case "$2" in',
      '    "https://registry.npmjs.org/@openclaw/fs-safe/-/fs-safe-0.3.0.tgz") archive="$fs_safe_archive"; filename="fs-safe-0.3.0.tgz"; integrity="sha512-uIBE441CIt1kIURoP9qRGKZ8LkGyfD9ZzeESjwAd29ZPWtghws/5GR3Pjb67jKdcJHP1I6roNXcvnhzAU7lHlA==" ;;',
      '    "https://registry.npmjs.org/@modelcontextprotocol/sdk/-/sdk-1.29.0.tgz") archive="$modelcontextprotocol_sdk_archive"; filename="sdk-1.29.0.tgz"; integrity="sha512-zo37mZA9hJWpULgkRpowewez1y6ML5GsXJPY8FI0tBBCd77HEvza4jDqRKOXgHNn867PVGCyTdzqpz0izu5ZjQ==" ;;',
      '    "https://registry.npmjs.org/@hono/node-server/-/node-server-2.0.5.tgz") archive="$hono_node_server_archive"; filename="node-server-2.0.5.tgz"; integrity="sha512-yQFvDmyDo3y6rEOJZDUYPJ49DIKTPpIk4kGvm40xx4Ejne0Pu9a1+exxPN+C1UppWK/WGZX9F++/Xs231tE86g==" ;;',
      '    "https://registry.npmjs.org/eventsource-parser/-/eventsource-parser-3.1.0.tgz") archive="$eventsource_parser_archive"; filename="eventsource-parser-3.1.0.tgz"; integrity="sha512-kJezFj9YFAMLeORyi7aCLxLbD5/qWMQnoMVlVPyHIll7lgRJCc3JVln9Vgl9nwQi0YkMnhdGTMNn7CkRRAptMg==" ;;',
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
  return { archivePath, longMemberPath, npmExecutable, workingDirectory: path.join(root, "work") };
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
      "eventsource-parser",
    ]);
    expect(shrinkwrap.packages[""]).toMatchObject({
      bundleDependencies: [
        "@hono/node-server",
        "@modelcontextprotocol/sdk",
        "@openclaw/fs-safe",
        "eventsource-parser",
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
      version: "2.0.5",
      resolved: "https://registry.npmjs.org/@hono/node-server/-/node-server-2.0.5.tgz",
      integrity:
        "sha512-yQFvDmyDo3y6rEOJZDUYPJ49DIKTPpIk4kGvm40xx4Ejne0Pu9a1+exxPN+C1UppWK/WGZX9F++/Xs231tE86g==",
    });
    expect(
      shrinkwrap.packages["node_modules/@modelcontextprotocol/sdk"]?.dependencies?.[
        "@hono/node-server"
      ],
    ).toBe("2.0.5");
    expect(shrinkwrap.packages["node_modules/eventsource-parser"]).toMatchObject({
      version: "3.1.0",
      resolved: "https://registry.npmjs.org/eventsource-parser/-/eventsource-parser-3.1.0.tgz",
      integrity:
        "sha512-kJezFj9YFAMLeORyi7aCLxLbD5/qWMQnoMVlVPyHIll7lgRJCc3JVln9Vgl9nwQi0YkMnhdGTMNn7CkRRAptMg==",
    });
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
    const eventsourceParserPackageJson = readJson<{ name?: string; version?: string }>(
      path.join(extracted, "package", "node_modules", "eventsource-parser", "package.json"),
    );
    expect(packageJson).toMatchObject({
      bundledDependencies: [
        "@hono/node-server",
        "@modelcontextprotocol/sdk",
        "@openclaw/fs-safe",
        "eventsource-parser",
      ],
      dependencies: { jszip: "3.10.1", tar: "7.5.19" },
    });
    expect(fsSafePackageJson.optionalDependencies).toBeUndefined();
    expect(modelContextProtocolSdkPackageJson.dependencies?.["@hono/node-server"]).toBe("2.0.5");
    expect(honoNodeServerPackageJson).toMatchObject({
      name: "@hono/node-server",
      version: "2.0.5",
    });
    expect(eventsourceParserPackageJson).toMatchObject({
      name: "eventsource-parser",
      version: "3.1.0",
    });
    expect(readFileSync(path.join(extracted, "package", fixture.longMemberPath), "utf-8")).toBe(
      "long archive member\n",
    );
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
