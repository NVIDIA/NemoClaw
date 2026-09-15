// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  readReviewedOpenShellSdkInstallScript,
  validateReviewedOpenShellSdkInstallAction,
} from "../../../tools/e2e/reviewed-openshell-sdk-install-workflow-boundary.mts";
import { parseNpmPackArchives } from "./openshell-sdk-pack-archives.ts";

describe("reviewed OpenShell SDK E2E boundary", () => {
  it.for([
    {
      name: "npm 11 array metadata",
      output: JSON.stringify([
        { filename: "fixture-transport-1.0.0.tgz", name: "fixture-transport", version: "1.0.0" },
      ]),
    },
    {
      name: "npm 12 keyed metadata",
      output: JSON.stringify({
        "fixture-transport@1.0.0": {
          filename: "fixture-transport-1.0.0.tgz",
          name: "fixture-transport",
          version: "1.0.0",
        },
      }),
    },
  ])("reads $name from npm pack", ({ output }) => {
    expect(parseNpmPackArchives(output)).toEqual([
      { filename: "fixture-transport-1.0.0.tgz", name: "fixture-transport", version: "1.0.0" },
    ]);
  });

  it("rejects npm pack metadata without an archive filename", () => {
    expect(() =>
      parseNpmPackArchives(JSON.stringify([{ name: "fixture-transport", version: "1.0.0" }])),
    ).toThrow("npm pack --json returned invalid package metadata");
  });

  it("keeps the E2E action as a thin trusted-installer adapter", () => {
    expect(readReviewedOpenShellSdkInstallScript()).toContain(
      'bash "$GITHUB_ACTION_PATH/../ci-install-dependencies.sh" none artifact',
    );
  });

  it("executes the action through the credential-free artifact installer boundary", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sdk-action-execution-"));
    const trustedRoot = path.join(directory, "trusted");
    const targetRoot = path.join(directory, "target");
    const runnerTemp = path.join(directory, "runner-temp");
    const actionPath = path.join(
      trustedRoot,
      ".github",
      "actions",
      "install-reviewed-openshell-sdk",
    );
    const dependencyRoot = path.join(directory, "fixture-transport");
    const sdkRoot = path.join(directory, "openshell-sdk");
    const lifecycleMarker = path.join(directory, "lifecycle-ran");
    try {
      fs.mkdirSync(path.join(trustedRoot, ".github", "actions"), { recursive: true });
      fs.mkdirSync(path.join(trustedRoot, "ci"), { recursive: true });
      fs.cpSync("scripts", path.join(trustedRoot, "scripts"), { recursive: true });
      fs.cpSync(
        ".github/actions/ci-install-dependencies.sh",
        path.join(trustedRoot, ".github", "actions", "ci-install-dependencies.sh"),
      );
      fs.cpSync(".github/actions/install-reviewed-openshell-sdk", actionPath, { recursive: true });
      fs.mkdirSync(targetRoot);
      fs.mkdirSync(runnerTemp);
      fs.mkdirSync(dependencyRoot);
      fs.writeFileSync(
        path.join(directory, "credentialed-npmrc"),
        "registry=https://registry.invalid/\n//registry.invalid/:_authToken=must-not-reach-installer\n",
      );
      fs.writeFileSync(
        path.join(dependencyRoot, "package.json"),
        JSON.stringify({ name: "fixture-transport", version: "1.0.0" }),
      );
      fs.writeFileSync(path.join(dependencyRoot, "index.js"), "export const transport = true;\n");
      fs.mkdirSync(sdkRoot);
      fs.writeFileSync(
        path.join(sdkRoot, "package.json"),
        JSON.stringify({
          dependencies: { "fixture-transport": "1.0.0" },
          exports: "./index.js",
          name: "@nvidia/openshell-sdk",
          scripts: { preinstall: `touch ${JSON.stringify(lifecycleMarker)}` },
          type: "module",
          version: "0.0.106",
        }),
      );
      fs.writeFileSync(
        path.join(sdkRoot, "index.js"),
        `import { transport } from "fixture-transport";
const credentials = ["NODE_AUTH_TOKEN", "NPM_TOKEN", "NPM_CONFIG__AUTH_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"];
if (credentials.some((name) => process.env[name])) throw new Error("credential reached fixture SDK");
if (process.env.NPM_CONFIG_USERCONFIG !== "/dev/null") throw new Error("npm user config reached fixture SDK");
export class OpenShellClient { static connect() { return transport; } }
`,
      );
      const installedDependency = path.join(sdkRoot, "node_modules", "fixture-transport");
      fs.mkdirSync(path.dirname(installedDependency), { recursive: true });
      fs.cpSync(dependencyRoot, installedDependency, { recursive: true });
      const artifactDirectory = path.join(runnerTemp, "openshell-sdk");
      fs.mkdirSync(artifactDirectory);
      const archiveStaging = path.join(directory, "archive-staging");
      fs.mkdirSync(archiveStaging);
      fs.cpSync(sdkRoot, path.join(archiveStaging, "package"), { recursive: true });
      const artifactFilename = "nvidia-openshell-sdk-0.0.106.tgz";
      execFileSync(
        "tar",
        ["-czf", path.join(artifactDirectory, artifactFilename), "-C", archiveStaging, "package"],
        { stdio: "pipe" },
      );
      const archive = fs.readFileSync(path.join(artifactDirectory, artifactFilename));
      const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
      const tarballUrl =
        "https://npm.pkg.github.com/download/@nvidia/openshell-sdk/0.0.106/action-fixture";
      fs.writeFileSync(
        path.join(trustedRoot, "ci", "reviewed-npm-audit.json"),
        JSON.stringify({
          archiveGraphId: "action-fixture",
          archivePackages: [],
          archiveTarVersion: "7.5.21",
          artifactDirectory: "artifacts/reviewed-npm-audit",
          exceptionFile: "ci/npm-audit-exceptions.json",
          lockedGraphs: [],
          nodeVersion: "24.18.1",
          npmArchiveSha256: "5dbb86c71d07a1957f2e90734092dd6a58bdcd9ebc2d8d41ca1c6e6a21d364e1",
          npmIntegrity:
            "sha512-uIXokLlBj6FpNUTQX1PmT5pz7BlIN9QlixX+zdaSNHsd0qUXsbDLr50xzY6Sw7cJVr0uzHKDOle0swmPW/p5Qw==",
          npmVersion: "12.0.2",
          registryOrigin: "https://registry.npmjs.org/",
          schemaVersion: 2,
          severityThreshold: "high",
          sourceNestedShrinkwrapPackages: [],
          sourceRegistryPackage: {
            artifactName: artifactFilename,
            integrity,
            label: "OpenShell TypeScript SDK 0.0.106",
            packageSpec: "@nvidia/openshell-sdk@0.0.106",
            tarballUrl,
          },
          sourceRegistryPackagesWithoutIntegrity: [],
        }),
      );
      fs.writeFileSync(
        path.join(targetRoot, "package.json"),
        JSON.stringify({
          name: "reviewed-sdk-action-fixture",
          optionalDependencies: { "@nvidia/openshell-sdk": "0.0.106" },
          private: true,
          version: "1.0.0",
        }),
      );
      fs.writeFileSync(
        path.join(targetRoot, "package-lock.json"),
        JSON.stringify({
          lockfileVersion: 3,
          name: "reviewed-sdk-action-fixture",
          packages: {
            "": { optionalDependencies: { "@nvidia/openshell-sdk": "0.0.106" } },
            "node_modules/@nvidia/openshell-sdk": {
              bundleDependencies: ["fixture-transport"],
              dependencies: { "fixture-transport": `file:${dependencyRoot}` },
              integrity,
              optional: true,
              resolved: tarballUrl,
              version: "0.0.106",
            },
            "node_modules/@nvidia/openshell-sdk/node_modules/fixture-transport": {
              inBundle: true,
              integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
              optional: true,
              resolved:
                "https://registry.npmjs.org/fixture-transport/-/fixture-transport-1.0.0.tgz",
              version: "1.0.0",
            },
          },
          version: "1.0.0",
        }),
      );
      fs.mkdirSync(path.join(targetRoot, "nemoclaw"));
      fs.writeFileSync(
        path.join(targetRoot, "nemoclaw", "package-lock.json"),
        JSON.stringify({
          lockfileVersion: 3,
          name: "reviewed-sdk-action-plugin-fixture",
          packages: { "": {} },
          version: "1.0.0",
        }),
      );

      execFileSync("bash", ["-c", readReviewedOpenShellSdkInstallScript()], {
        cwd: targetRoot,
        env: {
          ...process.env,
          GH_TOKEN: "must-not-reach-installer",
          GITHUB_ACTION_PATH: actionPath,
          GITHUB_TOKEN: "must-not-reach-installer",
          NODE_AUTH_TOKEN: "must-not-reach-installer",
          NPM_CONFIG__AUTH_TOKEN: "must-not-reach-installer",
          NPM_CONFIG_USERCONFIG: path.join(directory, "credentialed-npmrc"),
          NPM_TOKEN: "must-not-reach-installer",
          RUNNER_TEMP: runnerTemp,
        },
        stdio: "pipe",
      });

      expect(fs.existsSync(lifecycleMarker)).toBe(false);
      expect(
        fs.existsSync(
          path.join(
            targetRoot,
            "node_modules",
            "@nvidia",
            "openshell-sdk",
            "node_modules",
            "fixture-transport",
            "index.js",
          ),
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects changes to the immutable action content", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sdk-action-"));
    const actionPath = path.join(directory, "action.yaml");
    try {
      fs.writeFileSync(
        actionPath,
        fs
          .readFileSync(".github/actions/install-reviewed-openshell-sdk/action.yaml", "utf8")
          .replace("none artifact", "none registry"),
      );
      expect(validateReviewedOpenShellSdkInstallAction(actionPath)).toContain(
        "reviewed OpenShell SDK install action content must match its immutable commit pin",
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });
});
