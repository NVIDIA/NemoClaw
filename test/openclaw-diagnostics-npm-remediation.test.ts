// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { patchOpenClawDiagnosticsPackageGraph } from "../scripts/lib/openclaw-npm-remediation.mts";

const temporaryDirectories: string[] = [];

function writeDiagnosticsFixture(jaegerVersion = "2.8.0"): string {
  const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-openclaw-otel-remediation-"));
  temporaryDirectories.push(directory);
  const bundledDependencies = ["@opentelemetry/sdk-node"];
  writeFileSync(
    path.join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "@openclaw/diagnostics-otel",
        version: "2026.6.10",
        dependencies: { "@opentelemetry/sdk-node": "0.219.0" },
        bundledDependencies,
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
          "node_modules/@opentelemetry/core": {
            version: "2.8.0",
          },
          "node_modules/@opentelemetry/propagator-jaeger": {
            version: jaegerVersion,
            resolved: `https://registry.npmjs.org/@opentelemetry/propagator-jaeger/-/propagator-jaeger-${jaegerVersion}.tgz`,
            integrity: "sha512-old-jaeger",
            dependencies: { "@opentelemetry/core": "2.8.0" },
          },
          "node_modules/@opentelemetry/sdk-node": {
            version: "0.219.0",
            dependencies: { "@opentelemetry/propagator-jaeger": jaegerVersion },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  const sdkDirectory = path.join(directory, "node_modules", "@opentelemetry", "sdk-node");
  mkdirSync(sdkDirectory, { recursive: true });
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
  return directory;
}

function readJson<T>(filename: string): T {
  return JSON.parse(readFileSync(filename, "utf8")) as T;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("OpenClaw diagnostics OTEL npm remediation", () => {
  it("replaces the vulnerable Jaeger propagator with its isolated patched core", () => {
    const directory = writeDiagnosticsFixture();

    patchOpenClawDiagnosticsPackageGraph(directory);

    const packages = readJson<{
      packages: Record<
        string,
        {
          dependencies?: Record<string, string>;
          integrity?: string;
          resolved?: string;
          version?: string;
        }
      >;
    }>(path.join(directory, "npm-shrinkwrap.json")).packages;
    expect(packages["node_modules/@opentelemetry/sdk-node"]?.dependencies).toMatchObject({
      "@opentelemetry/propagator-jaeger": "2.9.0",
    });
    expect(packages["node_modules/@opentelemetry/propagator-jaeger"]).toMatchObject({
      version: "2.9.0",
      resolved:
        "https://registry.npmjs.org/@opentelemetry/propagator-jaeger/-/propagator-jaeger-2.9.0.tgz",
      integrity:
        "sha512-4mYGty27rYvSM0jtp1ZUOqd3LfVRCYg9H5G9OFzSx5HViYToU21MFhWfco7x1HwXr7ER8yGOiCIHZUwjPksc0Q==",
      dependencies: { "@opentelemetry/core": "2.9.0" },
    });
    expect(
      packages["node_modules/@opentelemetry/propagator-jaeger/node_modules/@opentelemetry/core"],
    ).toMatchObject({
      version: "2.9.0",
      resolved: "https://registry.npmjs.org/@opentelemetry/core/-/core-2.9.0.tgz",
      integrity:
        "sha512-m2nckMT80NnmjTYSPjJQObBJ+8dgkoajEOUbznL8AHZ3T3yHRk2P7gI1PhEBc1+lOnrYE9UWrWHqJDsmqjmNbw==",
    });
  });

  it("rejects an unreviewed diagnostics Jaeger source graph", () => {
    const directory = writeDiagnosticsFixture("2.7.1");

    expect(() => patchOpenClawDiagnosticsPackageGraph(directory)).toThrow(
      "Jaeger graph changed; review the remediation",
    );
  });
});
