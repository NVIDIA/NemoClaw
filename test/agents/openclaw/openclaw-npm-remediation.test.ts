// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRemediatedOpenClawArchive,
  hashPackageTree,
  patchCurrentOpenClawCorePackageGraph,
  patchLegacyOpenClawCorePackageGraph,
  patchOpenClawDiagnosticsOtelPackageGraph,
  patchOpenClawDiscordPackageGraph,
  patchOpenClawPluginPackageGraph,
} from "../../../scripts/lib/openclaw-npm-remediation.mts";

const temporaryDirectories: string[] = [];

function writeFixture(axiosVersion = "1.16.0"): string {
  const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-openclaw-npm-remediation-"));
  temporaryDirectories.push(directory);
  writeFileSync(
    path.join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "@openclaw/slack",
        version: "2026.7.1",
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
        version: "2026.7.1",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: "@openclaw/slack",
            version: "2026.7.1",
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

function writeDiagnosticsFixture(jaegerVersion = "2.8.0"): string {
  const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-openclaw-otel-remediation-"));
  temporaryDirectories.push(directory);
  const sdkDirectory = path.join(directory, "node_modules", "@opentelemetry", "sdk-node");
  mkdirSync(sdkDirectory, { recursive: true });
  writeFileSync(
    path.join(directory, "package.json"),
    `${JSON.stringify({ name: "@openclaw/diagnostics-otel", version: "2026.7.1" }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(sdkDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "@opentelemetry/sdk-node",
        version: "0.219.0",
        dependencies: { "@opentelemetry/propagator-jaeger": jaegerVersion },
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
        version: "2026.7.1",
        lockfileVersion: 3,
        packages: {
          "": { name: "@openclaw/diagnostics-otel", version: "2026.7.1" },
          "node_modules/@opentelemetry/sdk-node": {
            version: "0.219.0",
            dependencies: { "@opentelemetry/propagator-jaeger": jaegerVersion },
          },
          "node_modules/@opentelemetry/propagator-jaeger": {
            version: jaegerVersion,
            dependencies: { "@opentelemetry/core": jaegerVersion },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return directory;
}

function writeLegacyCoreFixture(tarVersion = "7.5.11"): string {
  const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-legacy-openclaw-core-remediation-"));
  temporaryDirectories.push(directory);
  writeFileSync(
    path.join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "openclaw",
        version: "2026.3.11",
        dependencies: { commander: "14.0.3", tar: tarVersion },
      },
      null,
      2,
    )}\n`,
  );
  return directory;
}

function writeCurrentCoreFixture(
  braceExpansionVersion = "5.0.7",
  fastUriVersion = "3.1.2",
  undiciVersion = "8.5.0",
  ipAddressVersion = "10.2.0",
): string {
  const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-current-openclaw-core-remediation-"));
  temporaryDirectories.push(directory);
  writeFileSync(
    path.join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "openclaw",
        version: "2026.7.1",
        dependencies: {
          "@modelcontextprotocol/sdk": "1.29.0",
          "@openclaw/fs-safe": "0.4.1",
          minimatch: "10.2.5",
          tar: "7.5.19",
          undici: undiciVersion,
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
        version: "2026.7.1",
        lockfileVersion: 3,
        packages: {
          "": {
            name: "openclaw",
            version: "2026.7.1",
            dependencies: {
              "@modelcontextprotocol/sdk": "1.29.0",
              "@openclaw/fs-safe": "0.4.1",
              minimatch: "10.2.5",
              tar: "7.5.19",
              undici: undiciVersion,
            },
          },
          "node_modules/@openclaw/fs-safe": {
            version: "0.4.1",
            resolved: "https://registry.npmjs.org/@openclaw/fs-safe/-/fs-safe-0.4.1.tgz",
            integrity:
              "sha512-hQi+BxO10KdRFlYUot1syC+hTaUnGeQNdqX5kwkKJig8CFq1tKsYJLPm+zkiiGsSKOprPAquQl/txejEhpKPgg==",
            license: "MIT",
            engines: { node: ">=22" },
            optionalDependencies: { jszip: "^3.10.1", tar: "7.5.19" },
          },
          "node_modules/ajv": {
            version: "8.20.0",
            dependencies: { "fast-uri": "^3.0.1" },
          },
          "node_modules/brace-expansion": {
            version: braceExpansionVersion,
            resolved: `https://registry.npmjs.org/brace-expansion/-/brace-expansion-${braceExpansionVersion}.tgz`,
            integrity:
              "sha512-7oFy703dxfY3/NLxC1fh2SUCQ0H9rmAY+5EpDVfXjUTTs+HEwR2nYaqLv+GWcTsumwxPfiz6CzCNkwXwBUwqCA==",
            dependencies: { "balanced-match": "^4.0.2" },
          },
          "node_modules/fast-uri": {
            version: fastUriVersion,
            resolved: `https://registry.npmjs.org/fast-uri/-/fast-uri-${fastUriVersion}.tgz`,
            integrity:
              "sha512-rVjf7ArG3LTk+FS6Yw81V1DLuZl1bRbNrev6Tmd/9RaroeeRRJhAt7jg/6YFxbvAQXUCavSoZhPPj6oOx+5KjQ==",
          },
          "node_modules/minimatch": {
            version: "10.2.5",
            dependencies: { "brace-expansion": "^5.0.5" },
          },
          "node_modules/tar": {
            version: "7.5.19",
            resolved: "https://registry.npmjs.org/tar/-/tar-7.5.19.tgz",
            integrity:
              "sha512-4LeEWl96twnS2Q7Bz4MGqgazLqO+hJN63GZxXoIqh1T3VweYD997gbU1ItNsQafqqXTXd5WFyFdReLtwvRBNiw==",
            license: "BlueOak-1.0.0",
            dependencies: {
              "@isaacs/fs-minipass": "^4.0.0",
              chownr: "^3.0.0",
              minipass: "^7.1.2",
              minizlib: "^3.1.0",
              yallist: "^5.0.0",
            },
            engines: { node: ">=18" },
          },
          "node_modules/express-rate-limit": {
            version: "8.5.2",
            dependencies: { "ip-address": "^10.2.0" },
          },
          "node_modules/ip-address": {
            version: ipAddressVersion,
            resolved: `https://registry.npmjs.org/ip-address/-/ip-address-${ipAddressVersion}.tgz`,
            integrity:
              "sha512-/+S6j4E9AHvW9SWMSEY9Xfy66O5PWvVEJ08O0y5JGyEKQpojb0K0GKpz/v5HJ/G0vi3D2sjGK78119oXZeE0qA==",
            engines: { node: ">= 12" },
          },
          "node_modules/undici": {
            version: undiciVersion,
            resolved: `https://registry.npmjs.org/undici/-/undici-${undiciVersion}.tgz`,
            integrity:
              "sha512-xamtWoB1EshgjpmlXd7GGm2VfdDtw1+rD8uhry8pSNW3If6S8E0m2T2+orSKeZXEn/aPJMviCpDBA65WJt8zhg==",
            engines: { node: ">=22.19.0" },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return directory;
}

function writeDiscordFixture(undiciVersion = "8.5.0"): string {
  const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-openclaw-discord-remediation-"));
  temporaryDirectories.push(directory);
  const dependencies = { undici: undiciVersion, ws: "8.21.0" };
  const bundledUndiciDirectory = path.join(directory, "node_modules", "undici");
  mkdirSync(bundledUndiciDirectory, { recursive: true });
  writeFileSync(
    path.join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "@openclaw/discord",
        version: "2026.7.1",
        dependencies,
        bundledDependencies: ["undici"],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(bundledUndiciDirectory, "package.json"),
    `${JSON.stringify(
      { name: "undici", version: undiciVersion, engines: { node: ">=22.19.0" } },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(directory, "npm-shrinkwrap.json"),
    `${JSON.stringify(
      {
        name: "@openclaw/discord",
        version: "2026.7.1",
        lockfileVersion: 3,
        packages: {
          "": { name: "@openclaw/discord", version: "2026.7.1", dependencies },
          "node_modules/undici": {
            version: undiciVersion,
            resolved: `https://registry.npmjs.org/undici/-/undici-${undiciVersion}.tgz`,
            integrity:
              "sha512-xamtWoB1EshgjpmlXd7GGm2VfdDtw1+rD8uhry8pSNW3If6S8E0m2T2+orSKeZXEn/aPJMviCpDBA65WJt8zhg==",
            engines: { node: ">=22.19.0" },
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

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
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

function readPackageField<T>(directory: string, field: string): T {
  const result = spawnSync("npm", ["pkg", "get", field, "--json"], {
    cwd: directory,
    encoding: "utf-8",
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as T;
}

function writeLegacyCoreArchiveFixtures(): {
  archivePath: string;
  npmExecutable: string;
  workingDirectory: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), "nemoclaw-legacy-openclaw-build-remediation-"));
  temporaryDirectories.push(root);
  const archivePath = path.join(root, "openclaw-2026.3.11.tgz");
  packFixture(writeLegacyCoreFixture(), archivePath);

  const tarDirectory = path.join(root, "tar-package");
  mkdirSync(tarDirectory, { recursive: true });
  writeFileSync(
    path.join(tarDirectory, "package.json"),
    `${JSON.stringify({ name: "tar", version: "7.5.21" }, null, 2)}\n`,
  );
  const tarArchive = path.join(root, "tar-7.5.21-source.tgz");
  packFixture(tarDirectory, tarArchive);

  const npmExecutable = path.join(root, "npm-fixture.sh");
  writeFileSync(
    npmExecutable,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `tar_archive=${JSON.stringify(tarArchive)}`,
      'case "$1:$2:${3:-}" in',
      '  "view:tar@7.5.21:dist.integrity") value="sha512-XdhtCvlMywwxpCW8YEq3lOXBJpUPTR2OHHcwLPO3HwsJqOHa2Ok/oJ7ruGzp+JrKoRPVCzJwAdEjqLW/vNRPHA==" ;;',
      '  "view:tar@7.5.21:dist.tarball") value="https://registry.npmjs.org/tar/-/tar-7.5.21.tgz" ;;',
      '  "pack:https://registry.npmjs.org/tar/-/tar-7.5.21.tgz:--pack-destination") ;;',
      '  *) echo "unexpected npm fixture invocation: $*" >&2; exit 1 ;;',
      "esac",
      'if [ "$1" = "view" ]; then printf "%s\\n" "$value"; exit 0; fi',
      'destination=""',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "--pack-destination" ]; then destination="$2"; shift 2; continue; fi',
      "  shift",
      "done",
      'cp "$tar_archive" "$destination/tar-7.5.21.tgz"',
      'printf \'[{"filename":"tar-7.5.21.tgz","integrity":"sha512-XdhtCvlMywwxpCW8YEq3lOXBJpUPTR2OHHcwLPO3HwsJqOHa2Ok/oJ7ruGzp+JrKoRPVCzJwAdEjqLW/vNRPHA=="}]\\n\'',
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
  it("hashes package entries through opened file descriptors", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-openclaw-tree-integrity-"));
    temporaryDirectories.push(directory);
    mkdirSync(path.join(directory, "nested"));
    writeFileSync(path.join(directory, "package.json"), '{"name":"fixture"}\n');
    writeFileSync(path.join(directory, "nested", "content.txt"), "reviewed content\n");

    const first = hashPackageTree(directory);
    const second = hashPackageTree(directory);

    expect(first).toMatch(/^sha512-/);
    expect(second).toBe(first);
  });

  it("rejects symbolic links in a remediated package tree", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-openclaw-tree-symlink-"));
    temporaryDirectories.push(directory);
    const outside = path.join(directory, "..", `${path.basename(directory)}-outside`);
    writeFileSync(outside, "must not be hashed\n");
    temporaryDirectories.push(outside);
    symlinkSync(outside, path.join(directory, "linked-content"));

    expect(() => hashPackageTree(directory)).toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "rejects FIFOs without blocking in a remediated package tree",
    () => {
      const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-openclaw-tree-fifo-"));
      temporaryDirectories.push(directory);
      const fifo = path.join(directory, "blocked-reader");
      const created = spawnSync("mkfifo", [fifo], { encoding: "utf8", timeout: 5000 });
      expect(created.status, created.stderr).toBe(0);

      const startedAt = Date.now();
      expect(() => hashPackageTree(directory)).toThrow(/unsupported entry/);
      expect(Date.now() - startedAt).toBeLessThan(1000);
    },
  );

  it("replaces the reviewed bundled Axios graph with the patched graph", () => {
    const directory = writeFixture();

    patchOpenClawPluginPackageGraph(directory, "@openclaw/slack@2026.7.1");

    expect(readPackageField<string>(directory, "dependencies.axios")).toBe("1.18.0");
    expect(readPackageField<string[]>(directory, "bundledDependencies")).toEqual([
      "@slack/bolt",
      "axios",
    ]);

    const shrinkwrap = readJson<{
      packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
    }>(path.join(directory, "npm-shrinkwrap.json"));
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

    expect(() => patchOpenClawPluginPackageGraph(directory, "@openclaw/slack@2026.7.1")).toThrow(
      "must resolve node_modules/axios to 1.16.0 before remediation",
    );
  });

  it("replaces the reviewed Jaeger propagator with its aligned patched core", () => {
    const directory = writeDiagnosticsFixture();

    patchOpenClawDiagnosticsOtelPackageGraph(directory);

    expect(
      readPackageField<string>(
        path.join(directory, "node_modules", "@opentelemetry", "sdk-node"),
        "dependencies.@opentelemetry/propagator-jaeger",
      ),
    ).toBe("2.9.0");
    const shrinkwrap = readJson<{
      packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
    }>(path.join(directory, "npm-shrinkwrap.json"));
    expect(shrinkwrap.packages["node_modules/@opentelemetry/propagator-jaeger"]).toMatchObject({
      version: "2.9.0",
      dependencies: { "@opentelemetry/core": "2.9.0" },
    });
    expect(
      shrinkwrap.packages[
        "node_modules/@opentelemetry/propagator-jaeger/node_modules/@opentelemetry/core"
      ],
    ).toMatchObject({
      version: "2.9.0",
      dependencies: { "@opentelemetry/semantic-conventions": "^1.29.0" },
    });
  });

  it("rejects a diagnostics Jaeger graph that changed after review", () => {
    const directory = writeDiagnosticsFixture("2.8.1");

    expect(() => patchOpenClawDiagnosticsOtelPackageGraph(directory)).toThrow(
      "with Jaeger propagator 2.8.0 before remediation",
    );
  });

  it("rejects a legacy rebuild fixture tar graph that changed after review", () => {
    const directory = writeLegacyCoreFixture("7.5.12");

    expect(() => patchLegacyOpenClawCorePackageGraph(directory)).toThrow(
      "must declare reviewed tar@7.5.11 before remediation",
    );
  });

  it("replaces the reviewed OpenClaw 2026.7.1 dependency resolutions", () => {
    const directory = writeCurrentCoreFixture();

    patchCurrentOpenClawCorePackageGraph(directory);

    const shrinkwrap = readJson<{
      packages: Record<
        string,
        {
          dependencies?: Record<string, string>;
          integrity?: string;
          optionalDependencies?: Record<string, string>;
          resolved?: string;
          version?: string;
        }
      >;
    }>(path.join(directory, "npm-shrinkwrap.json"));
    expect(shrinkwrap.packages["node_modules/brace-expansion"]).toMatchObject({
      version: "5.0.9",
      resolved: "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.9.tgz",
      integrity:
        "sha512-ScQ4IuvIEF1TMlP7Zt+vjJ//9zlPb2SDcxWxM3bk8s6t6GGdJ7KO1dCcTidOPJKePW30LE/2cT7wCyPho9/Wxg==",
    });
    expect(shrinkwrap.packages["node_modules/fast-uri"]).toMatchObject({
      version: "3.1.5",
      resolved: "https://registry.npmjs.org/fast-uri/-/fast-uri-3.1.5.tgz",
      integrity:
        "sha512-gHwA1O9LDIcKunMKhObS/HimwtehO1nPUECKAu5TpKgaO19fcWEl4bliWe1jWxVFvIXztJjjQ4L8XQ1EU9f7Jw==",
    });
    expect(shrinkwrap.packages["node_modules/undici"]).toMatchObject({
      version: "8.10.0",
      resolved: "https://registry.npmjs.org/undici/-/undici-8.10.0.tgz",
      integrity:
        "sha512-HvltHd7avK13QIw/oLe4qoOLyoVSoafqJ2jYOrtMRBkbYT31eiBQ8O0ehRKZiEZCMEyLFQNIADpgCWC5fALvYQ==",
    });
    expect(shrinkwrap.packages["node_modules/ip-address"]).toMatchObject({
      version: "10.3.1",
      resolved: "https://registry.npmjs.org/ip-address/-/ip-address-10.3.1.tgz",
      integrity:
        "sha512-1e9d3kb97NHJTIJDZW9rKqW2h6+dFa50Dy0fpPSMQp2ADje5gvKsXmdiK6dwY5t76TaTt5+P5N1Y/LoToIxP6g==",
    });
    expect(shrinkwrap.packages["node_modules/tar"]).toMatchObject({
      version: "7.5.21",
      resolved: "https://registry.npmjs.org/tar/-/tar-7.5.21.tgz",
      integrity:
        "sha512-XdhtCvlMywwxpCW8YEq3lOXBJpUPTR2OHHcwLPO3HwsJqOHa2Ok/oJ7ruGzp+JrKoRPVCzJwAdEjqLW/vNRPHA==",
    });
    expect(shrinkwrap.packages["node_modules/@openclaw/fs-safe"].optionalDependencies).toEqual({
      jszip: "^3.10.1",
      tar: "7.5.21",
    });
    expect(shrinkwrap.packages[""].dependencies).toMatchObject({ tar: "7.5.21" });
    expect(
      readJson<{ dependencies: Record<string, string> }>(path.join(directory, "package.json")),
    ).toMatchObject({ dependencies: { tar: "7.5.21", undici: "8.10.0" } });
  });

  it("rejects a current OpenClaw manifest with a changed tar dependency", () => {
    const directory = writeCurrentCoreFixture();
    const packageJsonPath = path.join(directory, "package.json");
    const packageJson = readJson<{ dependencies: Record<string, string> }>(packageJsonPath);
    packageJson.dependencies.tar = "7.5.20";
    writeJson(packageJsonPath, packageJson);

    expect(() => patchCurrentOpenClawCorePackageGraph(directory)).toThrow(
      "dependency boundary changed after review",
    );
  });

  it("rejects a current OpenClaw fs-safe edge with a changed tar dependency", () => {
    const directory = writeCurrentCoreFixture();
    const shrinkwrapPath = path.join(directory, "npm-shrinkwrap.json");
    const shrinkwrap = readJson<{
      packages: Record<string, { optionalDependencies: Record<string, string> }>;
    }>(shrinkwrapPath);
    shrinkwrap.packages["node_modules/@openclaw/fs-safe"].optionalDependencies.tar = "7.5.20";
    writeJson(shrinkwrapPath, shrinkwrap);

    expect(() => patchCurrentOpenClawCorePackageGraph(directory)).toThrow(
      "@openclaw/fs-safe tar layout changed after review",
    );
  });

  it.each([
    ["version", "7.5.20"],
    ["resolved", "https://registry.npmjs.org/tar/-/tar-7.5.20.tgz"],
    ["integrity", "sha512-deliberate-mismatch"],
  ])("rejects a current OpenClaw tar shrinkwrap with changed %s", (field, value) => {
    const directory = writeCurrentCoreFixture();
    const shrinkwrapPath = path.join(directory, "npm-shrinkwrap.json");
    const shrinkwrap = readJson<{
      packages: Record<string, Record<string, unknown>>;
    }>(shrinkwrapPath);
    shrinkwrap.packages["node_modules/tar"][field] = value;
    writeJson(shrinkwrapPath, shrinkwrap);

    expect(() => patchCurrentOpenClawCorePackageGraph(directory)).toThrow(
      "tar layout changed after review",
    );
  });

  it.each([
    ["brace-expansion", "5.0.6", "brace-expansion layout changed after review"],
    ["fast-uri", "3.1.1", "fast-uri layout changed after review"],
    ["undici", "8.4.0", "dependency boundary changed after review"],
    ["ip-address", "10.1.1", "ip-address layout changed after review"],
  ])(
    "rejects a current OpenClaw %s graph that changed after review",
    (dependency, version, error) => {
      const directory =
        dependency === "brace-expansion"
          ? writeCurrentCoreFixture(version)
          : dependency === "fast-uri"
            ? writeCurrentCoreFixture("5.0.7", version)
            : dependency === "undici"
              ? writeCurrentCoreFixture("5.0.7", "3.1.2", version)
              : writeCurrentCoreFixture("5.0.7", "3.1.2", "8.5.0", version);

      expect(() => patchCurrentOpenClawCorePackageGraph(directory)).toThrow(error);
    },
  );

  it.each([
    ["resolved", "https://registry.npmjs.org/undici/-/undici-8.4.0.tgz"],
    ["integrity", "sha512-deliberate-mismatch"],
    ["engines", { node: ">=22.20.0" }],
  ])("rejects a current OpenClaw undici shrinkwrap with changed %s", (field, value) => {
    const directory = writeCurrentCoreFixture();
    const shrinkwrapPath = path.join(directory, "npm-shrinkwrap.json");
    const shrinkwrap = readJson<{
      packages: Record<string, Record<string, unknown>>;
    }>(shrinkwrapPath);
    shrinkwrap.packages["node_modules/undici"][field] = value;
    writeJson(shrinkwrapPath, shrinkwrap);

    expect(() => patchCurrentOpenClawCorePackageGraph(directory)).toThrow(
      "undici layout changed after review",
    );
  });

  it("replaces the reviewed OpenClaw Discord undici dependency", () => {
    const directory = writeDiscordFixture();

    patchOpenClawDiscordPackageGraph(directory);

    expect(readPackageField<string>(directory, "dependencies.undici")).toBe("8.10.0");
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
    expect(shrinkwrap.packages[""].dependencies).toMatchObject({ undici: "8.10.0" });
    expect(shrinkwrap.packages["node_modules/undici"]).toMatchObject({
      version: "8.10.0",
      resolved: "https://registry.npmjs.org/undici/-/undici-8.10.0.tgz",
      integrity:
        "sha512-HvltHd7avK13QIw/oLe4qoOLyoVSoafqJ2jYOrtMRBkbYT31eiBQ8O0ehRKZiEZCMEyLFQNIADpgCWC5fALvYQ==",
    });
  });

  it("rejects an OpenClaw Discord undici graph that changed after review", () => {
    const directory = writeDiscordFixture("8.4.0");

    expect(() => patchOpenClawDiscordPackageGraph(directory)).toThrow(
      "undici dependency changed after review",
    );
  });

  it.each([
    ["resolved", "https://registry.npmjs.org/undici/-/undici-8.4.0.tgz"],
    ["integrity", "sha512-deliberate-mismatch"],
    ["engines", { node: ">=22.20.0" }],
  ])("rejects an OpenClaw Discord undici shrinkwrap with changed %s", (field, value) => {
    const directory = writeDiscordFixture();
    const shrinkwrapPath = path.join(directory, "npm-shrinkwrap.json");
    const shrinkwrap = readJson<{
      packages: Record<string, Record<string, unknown>>;
    }>(shrinkwrapPath);
    shrinkwrap.packages["node_modules/undici"][field] = value;
    writeJson(shrinkwrapPath, shrinkwrap);

    expect(() => patchOpenClawDiscordPackageGraph(directory)).toThrow(
      "undici layout changed after review",
    );
  });

  it("rejects a changed OpenClaw Discord bundled undici identity", () => {
    const directory = writeDiscordFixture();
    writeJson(path.join(directory, "node_modules", "undici", "package.json"), {
      name: "undici",
      version: "8.4.0",
      engines: { node: ">=22.19.0" },
    });

    expect(() => patchOpenClawDiscordPackageGraph(directory)).toThrow("must be undici@8.5.0");
  });

  it("rejects a changed OpenClaw Discord bundled undici layout", () => {
    const directory = writeDiscordFixture();
    writeJson(path.join(directory, "node_modules", "undici", "package.json"), {
      name: "undici",
      version: "8.5.0",
      engines: { node: ">=22.20.0" },
    });

    expect(() => patchOpenClawDiscordPackageGraph(directory)).toThrow(
      "bundled undici layout changed after review",
    );
  });

  it("rebuilds the legacy fixture archive with the reviewed tar package bundled", () => {
    const fixture = writeLegacyCoreArchiveFixtures();
    const request = {
      archivePath: fixture.archivePath,
      env: { NEMOCLAW_REVIEWED_NPM_EXECUTABLE: fixture.npmExecutable },
      packageSpec: "openclaw@2026.3.11",
      workingDirectory: fixture.workingDirectory,
    };
    const remediated = buildRemediatedOpenClawArchive(request);
    expect(() =>
      buildRemediatedOpenClawArchive({
        ...request,
        expectedPatchedMetadataIntegrity: "sha512-deliberate-mismatch",
      }),
    ).toThrow(`got ${remediated.metadataIntegrity}`);

    const extracted = path.join(path.dirname(fixture.archivePath), "asserted");
    mkdirSync(extracted, { recursive: true });
    const extraction = spawnSync("tar", ["-xzf", remediated.archivePath, "-C", extracted], {
      encoding: "utf8",
    });
    expect(extraction.status, extraction.stderr).toBe(0);
    expect(existsSync(path.join(extracted, "package", "npm-shrinkwrap.json"))).toBe(false);
    expect(
      readJson<{
        bundledDependencies?: string[];
        dependencies?: Record<string, string>;
      }>(path.join(extracted, "package", "package.json")),
    ).toMatchObject({ bundledDependencies: ["tar"], dependencies: { tar: "7.5.21" } });
    expect(
      readJson<{ name?: string; version?: string }>(
        path.join(extracted, "package", "node_modules", "tar", "package.json"),
      ),
    ).toMatchObject({ name: "tar", version: "7.5.21" });
  }, 60_000);
});
