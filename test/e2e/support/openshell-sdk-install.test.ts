// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext, vi } from "vitest";
import YAML from "yaml";
import { testTimeoutOptions } from "../../helpers/timeouts.ts";
import { superviseChild } from "../../helpers/process-supervisor.ts";

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

type RunProcessOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  owner: Pick<TestContext, "onTestFinished" | "signal">;
  timeoutMs: number;
};

type RunProcessResult = {
  error?: Error;
  signal: NodeJS.Signals | null;
  status: number | null;
  stderr: string;
  stdout: string;
};

function runProcess(
  file: string,
  args: readonly string[],
  options: RunProcessOptions,
): Promise<RunProcessResult> {
  options.owner.signal.throwIfAborted();
  let stdout = "";
  let stderr = "";
  let outputError: Error | undefined;
  const child = spawn(file, [...args], {
    cwd: options.cwd,
    detached: true,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const finishController = new AbortController();
  const append = (current: string, chunk: string, stream: string): string => {
    const next = current + chunk;
    const limitError =
      !outputError && Buffer.byteLength(next, "utf8") > 10 * 1024 * 1024
        ? new Error(`${stream} exceeded the 10 MiB process output limit`)
        : undefined;
    outputError ??= limitError;
    void (limitError ? finishController.abort() : undefined);
    return outputError ? current : next;
  };
  const resultPromise = superviseChild(child, {
    killGraceMs: 0,
    onStderr: (chunk) => {
      stderr = append(stderr, chunk, "stderr");
    },
    onStdout: (chunk) => {
      stdout = append(stdout, chunk, "stdout");
    },
    signal: AbortSignal.any([options.owner.signal, finishController.signal]),
    timeoutMs: options.timeoutMs,
  });
  options.owner.onTestFinished(async () => {
    finishController.abort();
    await resultPromise;
  });
  return resultPromise.then((result) => ({
    ...(result.spawnError || result.cleanupError || outputError
      ? { error: result.spawnError ?? result.cleanupError ?? outputError }
      : {}),
    signal: result.signal,
    status: result.signal
      ? null
      : (result.exitCode ?? (result.spawnError || result.cleanupError || outputError ? -1 : null)),
    stderr,
    stdout,
  }));
}

async function runSuccessfulProcess(
  file: string,
  args: readonly string[],
  options: RunProcessOptions,
): Promise<RunProcessResult> {
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
  owner: Pick<TestContext, "onTestFinished" | "signal">,
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
    { name: "catalogue active SDK", script: installScript, lockedSdkVersion: "0.9.0" },
    { name: "catalogue replacement SDK", script: installScript, lockedSdkVersion: "1.0.0" },
    {
      name: "external gateway active SDK",
      script: externalGatewayInstallScript,
      lockedSdkVersion: "0.9.0",
    },
    {
      name: "external gateway replacement SDK",
      script: externalGatewayInstallScript,
      lockedSdkVersion: "1.0.0",
    },
  ])(
    "installs the lock-selected SDK and dependencies offline for $name",
    testTimeoutOptions(90_000),
    async ({ lockedSdkVersion, script }, context) => {
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

        await runSuccessfulProcess("bash", ["-c", script], {
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
        archives.forEach((archive) =>
          fs.writeFileSync(path.join(archiveDirectory, archive), "fixture"),
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
