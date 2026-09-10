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
const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
  jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
};
const externalInstallScript = workflow.jobs["external-gateway-health"]!.steps.find(
  (step) => step.name === "Install reviewed OpenShell SDK archive without package credentials",
)!.run!;

const npmFixture = `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.INSTALL_LOG, JSON.stringify({
  args: process.argv.slice(2),
  auth: [process.env.NODE_AUTH_TOKEN, process.env.GITHUB_TOKEN, process.env.GH_TOKEN],
}));
const directory = "node_modules/@nvidia/openshell-sdk";
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(directory + "/package.json", JSON.stringify({ type: "module", exports: "./index.js" }));
fs.writeFileSync(directory + "/index.js", process.env.SDK_SOURCE);
`;

describe("reviewed OpenShell SDK installation", () => {
  it.each([
    { name: "catalogue", script: installScript },
    { name: "external gateway health", script: externalInstallScript },
  ])("uses locked dependencies during $name SDK installation (#11449)", ({ script }) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sdk-lockfile-"));
    const archiveDirectory = path.join(directory, "openshell-sdk");
    const cache = path.join(directory, "cache");
    const env = {
      PATH: process.env.PATH,
      RUNNER_TEMP: directory,
      npm_config_cache: cache,
      npm_config_userconfig: path.join(directory, "user.npmrc"),
      npm_config_globalconfig: path.join(directory, "global.npmrc"),
      npm_config_offline: "true",
      npm_config_audit: "false",
      npm_config_fund: "false",
    };
    const npm = (args: string[], cwd = directory) =>
      execFileSync("npm", args, { cwd, env, encoding: "utf8", timeout: 10_000 });
    try {
      fs.mkdirSync(archiveDirectory);
      // Only tarballs enter the isolated cache. Resolving registry metadata must fail offline.
      const pack = (name: string, destination: string) => {
        const source = fs.mkdtempSync(path.join(directory, "package-"));
        fs.writeFileSync(
          path.join(source, "package.json"),
          JSON.stringify({
            name,
            version: "1.0.0",
            type: "module",
            exports: "./index.js",
            scripts: { install: "node -e \"throw new Error('Lifecycle script executed')\"" },
          }),
        );
        fs.writeFileSync(
          path.join(source, "index.js"),
          "export class OpenShellClient { static connect() {} }",
        );
        const [{ filename }] = JSON.parse(
          npm(["pack", "--ignore-scripts", "--json", "--pack-destination", destination], source),
        ) as Array<{ filename: string }>;
        return path.join(destination, filename!);
      };
      const dependencyArchive = pack("locked-dependency", directory);
      pack("@nvidia/openshell-sdk", archiveDirectory);
      npm(["cache", "add", dependencyArchive]);
      const manifest = {
        name: "sdk-install-fixture",
        version: "1.0.0",
        dependencies: { "locked-dependency": "^1.0.0" },
      };
      const lock = {
        name: manifest.name,
        version: manifest.version,
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": manifest,
          "node_modules/locked-dependency": {
            version: "1.0.0",
            resolved: "https://registry.npmjs.org/locked-dependency/-/locked-dependency-1.0.0.tgz",
            integrity: `sha512-${createHash("sha512").update(fs.readFileSync(dependencyArchive)).digest("base64")}`,
            hasInstallScript: true,
          },
        },
      };
      fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify(manifest));
      fs.writeFileSync(path.join(directory, "package-lock.json"), JSON.stringify(lock));
      npm(["ci", "--ignore-scripts"]);
      const manifestHashes = () =>
        ["package.json", "package-lock.json"].map((filename) =>
          createHash("sha256")
            .update(fs.readFileSync(path.join(directory, filename)))
            .digest("hex"),
        );
      const before = manifestHashes();

      const result = spawnSync("bash", ["-c", script], {
        cwd: directory,
        env,
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, result.stderr).toBe(0);
      expect(manifestHashes()).toEqual(before);
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(directory, "node_modules/locked-dependency/package.json"),
            "utf8",
          ),
        ).version,
      ).toBe("1.0.0");
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(directory, "node_modules/@nvidia/openshell-sdk/package.json"),
            "utf8",
          ),
        ).version,
      ).toBe("1.0.0");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "one reviewed archive",
      archives: ["sdk.tgz"],
      sdk: 'if (process.env.NODE_AUTH_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN) throw new Error("Unexpected credential"); export class OpenShellClient { static connect() {} }',
      status: 0,
      install: true,
    },
    { name: "no archive", archives: [], sdk: "", status: 1, install: false },
    {
      name: "ambiguous archives",
      archives: ["first.tgz", "second.tgz"],
      sdk: "",
      status: 1,
      install: false,
    },
    {
      name: "an SDK without the connection API",
      archives: ["sdk.tgz"],
      sdk: "export const OpenShellClient = {};",
      status: 1,
      install: true,
    },
  ])("checks $name before running the catalogue target", ({ archives, sdk, status, install }) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sdk-install-"));
    const archiveDirectory = path.join(directory, "openshell-sdk");
    const bin = path.join(directory, "bin");
    const log = path.join(directory, "install.json");
    try {
      fs.mkdirSync(archiveDirectory);
      fs.mkdirSync(bin);
      fs.writeFileSync(log, "null");
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
          NODE_AUTH_TOKEN: "package-credential-canary",
          GITHUB_TOKEN: "github-credential-canary",
          GH_TOKEN: "gh-credential-canary",
        },
      });

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, result.stderr).toBe(status);
      expect(JSON.parse(fs.readFileSync(log, "utf8"))).toEqual(
        install
          ? {
              args: [
                "install",
                "--no-save",
                "--ignore-scripts",
                path.join(archiveDirectory, archives[0]!),
              ],
              auth: [null, null, null],
            }
          : null,
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
