// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const profile = YAML.parse(
  fs.readFileSync(".github/workflows/e2e-standard-profile.yaml", "utf8"),
) as {
  jobs: { run: { steps: Array<{ name?: string; run?: string }> } };
};
const installScript = profile.jobs.run.steps.find(
  (step) => step.name === "Install reviewed OpenShell SDK archive without package credentials",
)!.run!;

const externalGateway = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
  jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
};
const externalGatewayInstallScript = externalGateway.jobs["external-gateway-health"]!.steps.find(
  (step) => step.name === "Install reviewed OpenShell SDK archive without package credentials",
)!.run!;

function writePackageArchive(
  root: string,
  name: string,
  dependencies: Record<string, string> = {},
) {
  const source = path.join(root, name.replaceAll("/", "-"));
  fs.mkdirSync(source);
  fs.writeFileSync(
    path.join(source, "package.json"),
    JSON.stringify({
      name,
      version: "1.0.0",
      type: "module",
      exports: "./index.js",
      dependencies,
      scripts: {
        preinstall: "node -e \"require('node:fs').writeFileSync('lifecycle-ran', 'yes')\"",
      },
    }),
  );
  fs.writeFileSync(
    path.join(source, "index.js"),
    name === "@nvidia/openshell-sdk"
      ? 'import { version } from "fixture-transport"; if (process.env.NODE_AUTH_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN) throw new Error("Unexpected credential"); export class OpenShellClient { static connect() { return version; } }'
      : 'export const version = "1.0.0";',
  );
  const packed = JSON.parse(
    execFileSync(
      "npm",
      ["pack", source, "--pack-destination", root, "--json", "--offline", "--ignore-scripts"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: root,
          NPM_CONFIG_CACHE: path.join(root, "pack-cache"),
        },
        timeout: 10_000,
      },
    ),
  ) as Array<{ filename: string }>;
  const archive = path.join(root, packed[0]!.filename);
  return {
    archive,
    lock: {
      version: "1.0.0",
      hasInstallScript: true,
      resolved: `https://registry.example.invalid/${path.basename(archive)}`,
      integrity: `sha512-${createHash("sha512").update(fs.readFileSync(archive)).digest("base64")}`,
      dependencies,
    },
  };
}

const npmFixture = `#!/usr/bin/env node
const fs = require("node:fs");
const calls = JSON.parse(fs.readFileSync(process.env.INSTALL_LOG, "utf8"));
calls.push({
  args: process.argv.slice(2),
  auth: [process.env.NODE_AUTH_TOKEN, process.env.GITHUB_TOKEN, process.env.GH_TOKEN],
});
fs.writeFileSync(process.env.INSTALL_LOG, JSON.stringify(calls));
if (process.argv[2] === process.env.NPM_FAILURE) process.exit(17);
if (process.argv[2] === "cache") process.exit(0);
const directory = "node_modules/@nvidia/openshell-sdk";
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(directory + "/package.json", JSON.stringify({ type: "module", exports: "./index.js" }));
fs.writeFileSync(directory + "/index.js", process.env.SDK_SOURCE);
`;

describe("catalogue OpenShell SDK installation", () => {
  it.each([
    { name: "catalogue", script: installScript },
    { name: "external gateway", script: externalGatewayInstallScript },
  ])("installs the SDK and locked dependencies offline for $name", ({ script }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sdk-real-npm-"));
    try {
      const sdk = writePackageArchive(root, "@nvidia/openshell-sdk", {
        "fixture-transport": "^1.0.0",
      });
      const transport = writePackageArchive(root, "fixture-transport");
      const sibling = writePackageArchive(root, "fixture-sibling");
      const workspace = path.join(root, "workspace");
      fs.mkdirSync(workspace);
      const manifest = JSON.stringify({
        name: "sdk-install-fixture",
        version: "1.0.0",
        dependencies: { "fixture-sibling": "^1.0.0" },
        optionalDependencies: { "@nvidia/openshell-sdk": "1.0.0" },
        scripts: {
          preinstall: "node -e \"require('node:fs').writeFileSync('lifecycle-ran', 'yes')\"",
        },
      });
      const lock = JSON.stringify({
        name: "sdk-install-fixture",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": JSON.parse(manifest),
          "node_modules/@nvidia/openshell-sdk": { ...sdk.lock, optional: true },
          "node_modules/fixture-transport": { ...transport.lock, optional: true },
          "node_modules/fixture-sibling": sibling.lock,
        },
      });
      fs.writeFileSync(path.join(workspace, "package.json"), manifest);
      fs.writeFileSync(path.join(workspace, "package-lock.json"), lock);
      const env = {
        PATH: process.env.PATH,
        HOME: root,
        NPM_CONFIG_CACHE: path.join(root, "cache"),
        NPM_CONFIG_OFFLINE: "true",
        NPM_CONFIG_AUDIT: "false",
        NPM_CONFIG_FUND: "false",
        NPM_CONFIG_UPDATE_NOTIFIER: "false",
        RUNNER_TEMP: root,
      };
      const runNpm = (args: string[]) =>
        execFileSync("npm", args, {
          cwd: workspace,
          encoding: "utf8",
          env,
          timeout: 10_000,
        });
      runNpm(["cache", "add", transport.archive, sibling.archive, "--offline", "--ignore-scripts"]);
      runNpm(["ci", "--ignore-scripts"]);
      expect(fs.existsSync(path.join(workspace, "node_modules/@nvidia/openshell-sdk"))).toBe(false);
      fs.mkdirSync(path.join(root, "openshell-sdk"));
      fs.copyFileSync(sdk.archive, path.join(root, "openshell-sdk", "sdk.tgz"));

      const result = spawnSync("bash", ["-c", script], {
        cwd: workspace,
        encoding: "utf8",
        env,
        timeout: 20_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const observed = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          'import { OpenShellClient } from "@nvidia/openshell-sdk"; import { version } from "fixture-sibling"; console.log(JSON.stringify([OpenShellClient.connect(), version]));',
        ],
        { cwd: workspace, encoding: "utf8", env },
      );
      expect(JSON.parse(observed)).toEqual(["1.0.0", "1.0.0"]);
      expect(fs.existsSync(path.join(workspace, "lifecycle-ran"))).toBe(false);
      expect(
        fs.existsSync(path.join(workspace, "node_modules/@nvidia/openshell-sdk/lifecycle-ran")),
      ).toBe(false);
      expect(
        fs.existsSync(path.join(workspace, "node_modules/fixture-transport/lifecycle-ran")),
      ).toBe(false);
      expect(
        fs.existsSync(path.join(workspace, "node_modules/fixture-sibling/lifecycle-ran")),
      ).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "one reviewed archive",
      archives: ["sdk.tgz"],
      sdk: 'if (process.env.NODE_AUTH_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN) throw new Error("Unexpected credential"); export class OpenShellClient { static connect() {} }',
      status: 0,
      calls: 2,
      failure: "",
    },
    { name: "no archive", archives: [], sdk: "", status: 1, calls: 0, failure: "" },
    {
      name: "ambiguous archives",
      archives: ["first.tgz", "second.tgz"],
      sdk: "",
      status: 1,
      calls: 0,
      failure: "",
    },
    {
      name: "an SDK without the connection API",
      archives: ["sdk.tgz"],
      sdk: "export const OpenShellClient = {};",
      status: 1,
      calls: 2,
      failure: "",
    },
    {
      name: "a cache staging failure",
      archives: ["sdk.tgz"],
      sdk: "",
      status: 17,
      calls: 1,
      failure: "cache",
    },
    {
      name: "a dependency install failure",
      archives: ["sdk.tgz"],
      sdk: "",
      status: 17,
      calls: 2,
      failure: "ci",
    },
  ])(
    "checks $name before running the catalogue target",
    ({ archives, sdk, status, calls, failure }) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sdk-install-"));
      const archiveDirectory = path.join(directory, "openshell-sdk");
      const bin = path.join(directory, "bin");
      const log = path.join(directory, "install.json");
      try {
        fs.mkdirSync(archiveDirectory);
        fs.mkdirSync(bin);
        fs.writeFileSync(log, "[]");
        archives.forEach((archive) =>
          fs.writeFileSync(path.join(archiveDirectory, archive), "fixture"),
        );
        fs.writeFileSync(path.join(bin, "npm"), npmFixture, { mode: 0o755 });
        fs.symlinkSync(process.execPath, path.join(bin, "node"));

        const result = spawnSync("bash", ["-c", installScript], {
          cwd: directory,
          encoding: "utf8",
          timeout: 10_000,
          env: {
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
            RUNNER_TEMP: directory,
            INSTALL_LOG: log,
            SDK_SOURCE: sdk,
            NPM_FAILURE: failure,
            NODE_AUTH_TOKEN: "package-credential-canary",
            GITHUB_TOKEN: "github-credential-canary",
            GH_TOKEN: "gh-credential-canary",
          },
        });

        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status, result.stderr).toBe(status);
        const expectedCalls = [
          {
            args: [
              "cache",
              "add",
              path.join(archiveDirectory, archives[0] ?? ""),
              "--offline",
              "--ignore-scripts",
            ],
            auth: [null, null, null],
          },
          {
            args: ["ci", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"],
            auth: [null, null, null],
          },
        ].slice(0, calls);
        expect(JSON.parse(fs.readFileSync(log, "utf8"))).toEqual(expectedCalls);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
