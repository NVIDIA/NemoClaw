// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  patchOpenClawCorePackageGraph,
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
        dependencies: { "@openclaw/fs-safe": "0.3.0", minimatch: "10.2.5", tar: tarVersion },
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
              "@openclaw/fs-safe": "0.3.0",
              minimatch: "10.2.5",
              tar: tarVersion,
            },
          },
          "node_modules/@openclaw/fs-safe": {
            version: "0.3.0",
            optionalDependencies: { tar: "7.5.13" },
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

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf-8")) as T;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("OpenClaw npm remediation", () => {
  it("replaces the reviewed bundled Axios graph with the patched graph", () => {
    const directory = writeFixture();

    patchOpenClawPluginPackageGraph(directory, "@openclaw/slack@2026.6.10");

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

    expect(() => patchOpenClawPluginPackageGraph(directory, "@openclaw/slack@2026.6.10")).toThrow(
      "must resolve node_modules/axios to 1.16.0 before remediation",
    );
  });

  it("replaces the reviewed OpenClaw core tar and brace-expansion graph", () => {
    const directory = writeCoreFixture();

    patchOpenClawCorePackageGraph(directory);

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
    expect(shrinkwrap.packages[""]).toMatchObject({ dependencies: { tar: "7.5.19" } });
    expect(shrinkwrap.packages["node_modules/tar"]).toMatchObject({
      version: "7.5.19",
      resolved: "https://registry.npmjs.org/tar/-/tar-7.5.19.tgz",
      integrity:
        "sha512-4LeEWl96twnS2Q7Bz4MGqgazLqO+hJN63GZxXoIqh1T3VweYD997gbU1ItNsQafqqXTXd5WFyFdReLtwvRBNiw==",
    });
    expect(shrinkwrap.packages["node_modules/@openclaw/fs-safe"]).toMatchObject({
      optionalDependencies: { tar: "7.5.19" },
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
});
