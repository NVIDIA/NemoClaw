// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hashPackageTree,
  patchOpenClawDiagnosticsOtelPackageGraph,
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

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf-8")) as T;
}

function readPackageField<T>(directory: string, field: string): T {
  const result = spawnSync("npm", ["pkg", "get", field, "--json"], {
    cwd: directory,
    encoding: "utf-8",
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as T;
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
});
