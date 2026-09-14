// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { testTimeoutOptions } from "../../helpers/timeouts.ts";
import {
  runSupervisedProcess,
  type SupervisedProcessOwner,
  type SupervisedProcessResult,
} from "../../helpers/supervised-process.ts";
import {
  readReviewedOpenShellSdkInstallScript,
  validateReviewedOpenShellSdkInstallAction,
} from "../../../tools/e2e/reviewed-openshell-sdk-install-workflow-boundary.mts";
const installScript = readReviewedOpenShellSdkInstallScript();

type RunProcessOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  owner: SupervisedProcessOwner;
  timeoutMs: number;
};

function runProcess(
  file: string,
  args: readonly string[],
  options: RunProcessOptions,
): Promise<SupervisedProcessResult> {
  return runSupervisedProcess(file, args, {
    cwd: options.cwd,
    env: options.env,
    maxOutputBytesPerStream: 10 * 1024 * 1024,
    owner: options.owner,
    timeoutMs: options.timeoutMs,
  });
}

async function runSuccessfulProcess(
  file: string,
  args: readonly string[],
  options: RunProcessOptions,
): Promise<SupervisedProcessResult> {
  const result = await runProcess(file, args, options);
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
}

async function runProcessWithStatus(
  file: string,
  args: readonly string[],
  options: RunProcessOptions,
  expectedStatus: number,
): Promise<void> {
  const result = await runProcess(file, args, options);
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null);
  assert.equal(result.status, expectedStatus, result.stderr);
}

vi.setConfig({ maxConcurrency: 3 });

type PackageDefinition = {
  dependencies?: Record<string, string>;
  name: string;
  version?: string;
};

async function writePackageArchives(
  root: string,
  packages: readonly PackageDefinition[],
  owner: SupervisedProcessOwner,
) {
  const sources = packages.map(({ dependencies = {}, name, version = "1.0.0" }) => {
    const source = path.join(root, `${name.replaceAll("/", "-")}-${version}`);
    fs.mkdirSync(source);
    fs.writeFileSync(
      path.join(source, "package.json"),
      JSON.stringify({
        name,
        version,
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
        : `export const version = ${JSON.stringify(version)};`,
    );
    return { dependencies, name, source, version };
  });
  const packed = JSON.parse(
    (
      await runSuccessfulProcess(
        "npm",
        [
          "pack",
          ...sources.map(({ source }) => source),
          "--pack-destination",
          root,
          "--json",
          "--offline",
          "--ignore-scripts",
        ],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            HOME: root,
            NPM_CONFIG_CACHE: path.join(root, "pack-cache"),
          },
          owner,
          timeoutMs: 30_000,
        },
      )
    ).stdout,
  ) as Array<{ filename: string; name: string; version: string }>;
  return sources.map(({ dependencies, name, version }) => {
    const filename = packed.find(
      (archive) => archive.name === name && archive.version === version,
    )?.filename;
    assert.ok(filename, `npm pack did not return ${name}@${version}`);
    const archive = path.join(root, filename);
    return {
      archive,
      lock: {
        version,
        hasInstallScript: true,
        resolved: `https://registry.example.invalid/${filename}`,
        integrity: `sha512-${createHash("sha512").update(fs.readFileSync(archive)).digest("base64")}`,
        dependencies,
      },
    };
  });
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

describe.concurrent("catalogue OpenShell SDK installation", () => {
  it("rejects changes to the immutable action content", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sdk-action-"));
    const actionPath = path.join(directory, "action.yaml");
    try {
      fs.writeFileSync(
        actionPath,
        fs
          .readFileSync(".github/actions/install-reviewed-openshell-sdk/action.yaml", "utf8")
          .replace("npm ci --offline --ignore-scripts", "npm ci --offline"),
      );
      expect(validateReviewedOpenShellSdkInstallAction(actionPath)).toContain(
        "reviewed OpenShell SDK install action content must match its immutable commit pin",
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("reaps helper descendants after the process-group leader exits", async (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sdk-process-tree-"));
    const pidFile = path.join(root, "descendant.pid");
    try {
      const result = await runProcess(
        "bash",
        [
          "-c",
          `trap 'exit 0' TERM; bash -c 'trap "" TERM; while :; do sleep 1; done' >/dev/null 2>&1 & echo $! > "$PID_FILE"; wait`,
        ],
        { env: { ...process.env, PID_FILE: pidFile }, owner: context, timeoutMs: 300 },
      );
      const descendantPid = Number(fs.readFileSync(pidFile, "utf8").trim());

      context.expect(result.error).toBeUndefined();
      context.expect(descendantPid).toBeGreaterThan(0);
      await vi.waitFor(() => {
        context.expect(() => process.kill(descendantPid, 0)).toThrow();
      });
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it.for([
    { name: "active SDK", lockedSdkVersion: "0.9.0" },
    { name: "replacement SDK", lockedSdkVersion: "1.0.0" },
  ])(
    "installs the lock-selected SDK and dependencies offline for $name",
    testTimeoutOptions(90_000),
    async ({ lockedSdkVersion }, context) => {
      const { expect } = context;
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sdk-real-npm-"));
      try {
        const [sdk, previousSdk, transport, sibling] = await writePackageArchives(
          root,
          [
            {
              name: "@nvidia/openshell-sdk",
              dependencies: { "fixture-transport": "^1.0.0" },
            },
            {
              name: "@nvidia/openshell-sdk",
              version: "0.9.0",
              dependencies: { "fixture-transport": "^1.0.0" },
            },
            { name: "fixture-transport" },
            { name: "fixture-sibling" },
          ],
          context,
        );
        const selectedSdk = lockedSdkVersion === "1.0.0" ? sdk : previousSdk;
        const workspace = path.join(root, "workspace");
        fs.mkdirSync(workspace);
        const manifest = JSON.stringify({
          name: "sdk-install-fixture",
          version: "1.0.0",
          dependencies: { "fixture-sibling": "^1.0.0" },
          optionalDependencies: { "@nvidia/openshell-sdk": lockedSdkVersion },
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
            "node_modules/@nvidia/openshell-sdk": { ...selectedSdk.lock, optional: true },
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
          runSuccessfulProcess("npm", args, {
            cwd: workspace,
            env,
            owner: context,
            timeoutMs: 30_000,
          });
        await runNpm([
          "cache",
          "add",
          transport.archive,
          sibling.archive,
          "--offline",
          "--ignore-scripts",
        ]);
        await runNpm(["ci", "--ignore-scripts"]);
        expect(fs.existsSync(path.join(workspace, "node_modules/@nvidia/openshell-sdk"))).toBe(
          false,
        );
        fs.mkdirSync(path.join(root, "openshell-sdk"));
        fs.copyFileSync(sdk.archive, path.join(root, "openshell-sdk", "sdk.tgz"));
        fs.copyFileSync(previousSdk.archive, path.join(root, "openshell-sdk", "previous-sdk.tgz"));

        await runSuccessfulProcess("bash", ["-c", installScript], {
          cwd: workspace,
          env,
          owner: context,
          timeoutMs: 60_000,
        });

        const observed = await runSuccessfulProcess(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            'import { OpenShellClient } from "@nvidia/openshell-sdk"; import { version } from "fixture-sibling"; console.log(JSON.stringify([OpenShellClient.connect(), version]));',
          ],
          { cwd: workspace, env, owner: context, timeoutMs: 10_000 },
        );
        expect(JSON.parse(observed.stdout)).toEqual(["1.0.0", "1.0.0"]);
        expect(
          JSON.parse(
            fs.readFileSync(
              path.join(workspace, "node_modules/@nvidia/openshell-sdk/package.json"),
              "utf8",
            ),
          ).version,
        ).toBe(lockedSdkVersion);
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
    },
  );

  it(
    "rejects a lock-selected SDK that is absent from the reviewed archives",
    testTimeoutOptions(90_000),
    async (context) => {
      const { expect } = context;
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sdk-cache-miss-"));
      try {
        const [reviewedSdk, lockedSdk, transport] = await writePackageArchives(
          root,
          [
            {
              name: "@nvidia/openshell-sdk",
              dependencies: { "fixture-transport": "^1.0.0" },
            },
            {
              name: "@nvidia/openshell-sdk",
              version: "2.0.0",
              dependencies: { "fixture-transport": "^1.0.0" },
            },
            { name: "fixture-transport" },
          ],
          context,
        );
        const workspace = path.join(root, "workspace");
        fs.mkdirSync(workspace);
        const manifest = JSON.stringify({
          name: "sdk-cache-miss-fixture",
          version: "1.0.0",
          optionalDependencies: { "@nvidia/openshell-sdk": "2.0.0" },
        });
        const lock = JSON.stringify({
          name: "sdk-cache-miss-fixture",
          version: "1.0.0",
          lockfileVersion: 3,
          requires: true,
          packages: {
            "": JSON.parse(manifest),
            "node_modules/@nvidia/openshell-sdk": { ...lockedSdk.lock, optional: true },
            "node_modules/fixture-transport": { ...transport.lock, optional: true },
          },
        });
        fs.writeFileSync(path.join(workspace, "package.json"), manifest);
        fs.writeFileSync(path.join(workspace, "package-lock.json"), lock);
        fs.mkdirSync(path.join(root, "openshell-sdk"));
        fs.copyFileSync(reviewedSdk.archive, path.join(root, "openshell-sdk", "sdk.tgz"));
        const env = {
          PATH: process.env.PATH,
          HOME: root,
          NPM_CONFIG_CACHE: path.join(root, "cache"),
          NPM_CONFIG_AUDIT: "false",
          NPM_CONFIG_FUND: "false",
          NPM_CONFIG_UPDATE_NOTIFIER: "false",
          RUNNER_TEMP: root,
        };
        await runSuccessfulProcess("npm", ["cache", "add", transport.archive, "--offline"], {
          cwd: workspace,
          env,
          owner: context,
          timeoutMs: 30_000,
        });

        await runProcessWithStatus(
          "bash",
          ["-c", installScript],
          {
            cwd: workspace,
            env,
            owner: context,
            timeoutMs: 60_000,
          },
          1,
        );
        expect(fs.existsSync(path.join(workspace, "node_modules/@nvidia/openshell-sdk"))).toBe(
          false,
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it(
    "rejects a candidate-local SDK even when it claims a reviewed version",
    testTimeoutOptions(90_000),
    async (context) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sdk-local-"));
      try {
        const [reviewedSdk] = await writePackageArchives(
          root,
          [{ name: "@nvidia/openshell-sdk" }],
          context,
        );
        const workspace = path.join(root, "workspace");
        const localSdk = path.join(workspace, "local-sdk");
        fs.mkdirSync(localSdk, { recursive: true });
        fs.writeFileSync(
          path.join(localSdk, "package.json"),
          JSON.stringify({ name: "@nvidia/openshell-sdk", version: "1.0.0" }),
        );
        const manifest = {
          name: "sdk-local-fixture",
          version: "1.0.0",
          optionalDependencies: { "@nvidia/openshell-sdk": "file:./local-sdk" },
        };
        fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify(manifest));
        fs.writeFileSync(
          path.join(workspace, "package-lock.json"),
          JSON.stringify({
            ...manifest,
            lockfileVersion: 3,
            requires: true,
            packages: {
              "": manifest,
              "local-sdk": { name: "@nvidia/openshell-sdk", version: "1.0.0" },
              "node_modules/@nvidia/openshell-sdk": {
                version: "1.0.0",
                resolved: "file:local-sdk",
                integrity: reviewedSdk.lock.integrity,
                optional: true,
              },
            },
          }),
        );
        fs.mkdirSync(path.join(root, "openshell-sdk"));
        fs.copyFileSync(reviewedSdk.archive, path.join(root, "openshell-sdk", "sdk.tgz"));

        await runProcessWithStatus(
          "bash",
          ["-c", installScript],
          {
            cwd: workspace,
            env: {
              PATH: process.env.PATH,
              HOME: root,
              NPM_CONFIG_CACHE: path.join(root, "cache"),
              RUNNER_TEMP: root,
            },
            owner: context,
            timeoutMs: 60_000,
          },
          1,
        );
        context
          .expect(fs.existsSync(path.join(workspace, "node_modules/@nvidia/openshell-sdk")))
          .toBe(false);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.for([
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
      name: "one approved transition pair",
      archives: ["first.tgz", "second.tgz"],
      sdk: "export class OpenShellClient { static connect() {} }",
      status: 0,
      calls: 3,
      failure: "",
    },
    {
      name: "more than one transition pair",
      archives: ["first.tgz", "second.tgz", "third.tgz"],
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
    testTimeoutOptions(30_000),
    async ({ archives, sdk, status, calls, failure }, context) => {
      const { expect } = context;
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sdk-install-"));
      const archiveDirectory = path.join(directory, "openshell-sdk");
      const bin = path.join(directory, "bin");
      const log = path.join(directory, "install.json");
      try {
        fs.mkdirSync(archiveDirectory);
        fs.mkdirSync(bin);
        fs.writeFileSync(log, "[]");
        const packed = await writePackageArchives(
          directory,
          [
            { name: "@nvidia/openshell-sdk", version: "1.0.0" },
            ...archives.slice(1).map((_, index) => ({
              name: "@nvidia/openshell-sdk",
              version: `1.0.${index + 1}`,
            })),
          ],
          context,
        );
        const reviewed = packed.slice(0, archives.length);
        archives.forEach((archive, index) =>
          fs.copyFileSync(reviewed[index]!.archive, path.join(archiveDirectory, archive)),
        );
        const manifest = {
          name: "sdk-install-check-fixture",
          version: "1.0.0",
          optionalDependencies: { "@nvidia/openshell-sdk": "1.0.0" },
        };
        fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify(manifest));
        fs.writeFileSync(
          path.join(directory, "package-lock.json"),
          JSON.stringify({
            ...manifest,
            lockfileVersion: 3,
            requires: true,
            packages: {
              "": manifest,
              "node_modules/@nvidia/openshell-sdk": {
                ...reviewed[0]?.lock,
                optional: true,
              },
            },
          }),
        );
        fs.writeFileSync(path.join(bin, "npm"), npmFixture, { mode: 0o755 });
        fs.symlinkSync(process.execPath, path.join(bin, "node"));

        await runProcessWithStatus(
          "bash",
          ["-c", installScript],
          {
            cwd: directory,
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
            owner: context,
            timeoutMs: 10_000,
          },
          status,
        );
        const expectedCalls = [
          ...archives.map((archive) => ({
            args: [
              "cache",
              "add",
              path.join(archiveDirectory, archive),
              "--offline",
              "--ignore-scripts",
            ],
            auth: [null, null, null],
          })),
          {
            args: ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"],
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
