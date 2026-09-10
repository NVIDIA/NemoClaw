// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
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

describe("catalogue OpenShell SDK installation", () => {
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
                "--package-lock=false",
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
