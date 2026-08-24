// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, X509Certificate } from "node:crypto";
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rootCertificates } from "node:tls";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

const REPOSITORY_ROOT = path.join(import.meta.dirname, "..", "..");
const PLUGIN_SOURCE = path.join(REPOSITORY_ROOT, "nemoclaw");
const PRIVATE_AUTHENTICATION_CONTENTS = "opaque-private-authentication-material";
const PRIVATE_AMBIENT_CONTENTS = "opaque-ambient-gateway-material";
const CA_PEM = rootCertificates[0]!;

function commandOutput(result: SpawnSyncReturns<string>): string {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function assertCommandSucceeded(result: SpawnSyncReturns<string>, label: string): void {
  expect(result.status, `${label} failed:\n${commandOutput(result)}`).toBe(0);
}

function npmEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
}

function writeRuntimeProbe(probePath: string): void {
  fs.writeFileSync(
    probePath,
    String.raw`
import childProcess from "node:child_process";
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { pathToFileURL } from "node:url";

const [runnerPath, blueprintRoot, ambientRoot, credentialPath] = process.argv.slice(2);
const effects = [];
const forbid = (kind) => (..._args) => {
  effects.push(kind);
  throw new Error("forbidden packaged-runner effect");
};

for (const name of ["exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync"]) {
  childProcess[name] = forbid("subprocess");
}
for (const name of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny"]) {
  dns[name] = forbid("network");
}
http.get = forbid("network");
http.request = forbid("network");
https.get = forbid("network");
https.request = forbid("network");
net.Socket.prototype.connect = forbid("network");
tls.connect = forbid("network");
globalThis.fetch = forbid("network");

const ambientPrefix = path.resolve(ambientRoot) + path.sep;
const resolvedCredentialPath = path.resolve(credentialPath);
const credentialDescriptors = new Set();
const originalReaders = new Map();
for (const name of ["accessSync", "lstatSync", "readdirSync", "statSync"]) {
  originalReaders.set(name, fs[name]);
  fs[name] = (...args) => {
    const candidate = args[0];
    if (typeof candidate === "string" && path.resolve(candidate).startsWith(ambientPrefix)) {
      effects.push("ambient-gateway-read");
      throw new Error("forbidden ambient gateway read");
    }
    return originalReaders.get(name)(...args);
  };
}
const originalOpenSync = fs.openSync;
fs.openSync = (...args) => {
  const descriptor = originalOpenSync(...args);
  if (typeof args[0] === "string" && path.resolve(args[0]) === resolvedCredentialPath) {
    credentialDescriptors.add(descriptor);
  }
  return descriptor;
};
const originalCloseSync = fs.closeSync;
fs.closeSync = (descriptor) => {
  credentialDescriptors.delete(descriptor);
  return originalCloseSync(descriptor);
};
const originalReadFileSync = fs.readFileSync;
fs.readFileSync = (...args) => {
  const candidate = args[0];
  if (typeof candidate === "string" && path.resolve(candidate) === resolvedCredentialPath) {
    effects.push("authentication-content-read");
    throw new Error("forbidden authentication content read");
  }
  if (typeof candidate === "string" && path.resolve(candidate).startsWith(ambientPrefix)) {
    effects.push("ambient-gateway-read");
    throw new Error("forbidden ambient gateway read");
  }
  return originalReadFileSync(...args);
};
const originalReadSync = fs.readSync;
fs.readSync = (descriptor, ...args) => {
  if (credentialDescriptors.has(descriptor)) {
    effects.push("authentication-content-read");
    throw new Error("forbidden authentication content read");
  }
  return originalReadSync(descriptor, ...args);
};
for (const name of [
  "appendFileSync",
  "chmodSync",
  "chownSync",
  "copyFileSync",
  "cpSync",
  "linkSync",
  "mkdirSync",
  "renameSync",
  "rmSync",
  "rmdirSync",
  "symlinkSync",
  "truncateSync",
  "unlinkSync",
  "writeFileSync",
]) {
  fs[name] = forbid("local-mutation");
}
syncBuiltinESMExports();

process.env.HOME = ambientRoot;
process.env.XDG_CONFIG_HOME = path.join(ambientRoot, ".config");
process.env.NEMOCLAW_BLUEPRINT_PATH = blueprintRoot;

const runnerUrl = pathToFileURL(runnerPath).href;
const runner = await import(runnerUrl);
let planOutput = "";
const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk) => {
  planOutput += String(chunk);
  return true;
};

let applyError = "";
try {
  await runner.main(["plan"]);
  try {
    await runner.main(["apply"]);
  } catch (error) {
    applyError = error instanceof Error ? error.message : String(error);
  }
} finally {
  process.stdout.write = originalWrite;
}

originalWrite(JSON.stringify({ applyError, effects, planOutput, runnerUrl }));
`,
  );
}

describe("packaged Blueprint Runner external target", () => {
  it(
    "builds cleanly and denies network, subprocess, ambient gateway state, credential-content, and filesystem-mutation effects during target-only planning (#9872)",
    {
      timeout: 240_000,
    },
    () => {
      const fixtureRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-external-target-package-"),
      );
      const sourcePackage = path.join(fixtureRoot, "source-package");
      const archiveRoot = path.join(fixtureRoot, "archive");
      const extractedRoot = path.join(fixtureRoot, "extracted");
      const runtimeRoot = path.join(fixtureRoot, "runtime");
      const blueprintRoot = path.join(runtimeRoot, "blueprint");
      const privateRoot = path.join(runtimeRoot, "private-inputs");
      const ambientRoot = path.join(runtimeRoot, "ambient-home");
      const privateCaPath = path.join(privateRoot, "private-ca.pem");
      const privateAuthenticationPath = path.join(privateRoot, "private-authentication");

      try {
        fs.mkdirSync(sourcePackage, { recursive: true });
        fs.copyFileSync(
          path.join(PLUGIN_SOURCE, "package.json"),
          path.join(sourcePackage, "package.json"),
        );
        fs.copyFileSync(
          path.join(PLUGIN_SOURCE, "package-lock.json"),
          path.join(sourcePackage, "package-lock.json"),
        );
        fs.copyFileSync(
          path.join(PLUGIN_SOURCE, "tsconfig.json"),
          path.join(sourcePackage, "tsconfig.json"),
        );
        fs.copyFileSync(
          path.join(PLUGIN_SOURCE, "tsconfig.shared.json"),
          path.join(sourcePackage, "tsconfig.shared.json"),
        );
        fs.cpSync(path.join(PLUGIN_SOURCE, "src"), path.join(sourcePackage, "src"), {
          recursive: true,
        });
        expect(fs.existsSync(path.join(sourcePackage, "dist"))).toBe(false);

        const installBuildDependencies = spawnSync("npm", ["ci", "--ignore-scripts", "--offline"], {
          cwd: sourcePackage,
          encoding: "utf8",
          env: npmEnvironment(),
        });
        assertCommandSucceeded(installBuildDependencies, "offline clean-build dependency install");

        const build = spawnSync("npm", ["run", "build"], {
          cwd: sourcePackage,
          encoding: "utf8",
          env: npmEnvironment(),
        });
        assertCommandSucceeded(build, "clean package build");
        expect(fs.existsSync(path.join(sourcePackage, "dist", "blueprint", "runner.js"))).toBe(
          true,
        );

        fs.mkdirSync(archiveRoot, { recursive: true });
        const pack = spawnSync(
          "npm",
          ["pack", "--ignore-scripts", "--silent", "--pack-destination", archiveRoot],
          { cwd: sourcePackage, encoding: "utf8", env: npmEnvironment() },
        );
        assertCommandSucceeded(pack, "package archive creation");
        const archives = fs.readdirSync(archiveRoot).filter((entry) => entry.endsWith(".tgz"));
        expect(archives).toHaveLength(1);

        fs.mkdirSync(extractedRoot, { recursive: true });
        execFileSync("tar", ["-xzf", path.join(archiveRoot, archives[0]!), "-C", extractedRoot]);
        const installedPackage = path.join(extractedRoot, "package");
        const installedRunner = path.join(installedPackage, "dist", "blueprint", "runner.js");
        expect(fs.existsSync(installedRunner)).toBe(true);
        expect(fs.existsSync(path.join(installedPackage, "src"))).toBe(false);

        const pruneBuildDependencies = spawnSync(
          "npm",
          ["prune", "--omit=dev", "--ignore-scripts", "--offline"],
          { cwd: sourcePackage, encoding: "utf8", env: npmEnvironment() },
        );
        assertCommandSucceeded(pruneBuildDependencies, "offline production dependency pruning");
        fs.cpSync(
          path.join(sourcePackage, "node_modules"),
          path.join(installedPackage, "node_modules"),
          { recursive: true },
        );
        fs.rmSync(sourcePackage, { recursive: true, force: true });
        expect(
          fs
            .realpathSync(path.join(installedPackage, "node_modules", "execa"))
            .startsWith(`${fs.realpathSync(installedPackage)}${path.sep}`),
        ).toBe(true);

        fs.mkdirSync(blueprintRoot, { recursive: true });
        fs.mkdirSync(privateRoot, { recursive: true });
        fs.mkdirSync(path.join(ambientRoot, ".config", "openshell"), { recursive: true });
        fs.writeFileSync(privateCaPath, CA_PEM);
        fs.writeFileSync(privateAuthenticationPath, PRIVATE_AUTHENTICATION_CONTENTS);
        fs.writeFileSync(
          path.join(ambientRoot, ".config", "openshell", "gateway.env"),
          PRIVATE_AMBIENT_CONTENTS,
        );
        fs.writeFileSync(
          path.join(blueprintRoot, "blueprint.yaml"),
          YAML.stringify({
            version: "1.0.0",
            min_openshell_version: "0.0.106",
            max_openshell_version: "0.0.106",
            openshell_target: {
              endpoint: "https://openshell.example.test:8443",
              workspace: "default",
              expected_release: "0.0.106",
              lifecycle: "external",
              trust: { ca_file: privateCaPath },
              authentication: { credential_file: privateAuthenticationPath },
            },
          }),
        );

        const probePath = path.join(runtimeRoot, "probe.mjs");
        writeRuntimeProbe(probePath);
        const probe = spawnSync(
          process.execPath,
          [probePath, installedRunner, blueprintRoot, ambientRoot, privateAuthenticationPath],
          {
            cwd: runtimeRoot,
            encoding: "utf8",
            env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
          },
        );
        const privateValues = [
          privateCaPath,
          privateAuthenticationPath,
          PRIVATE_AUTHENTICATION_CONTENTS,
          PRIVATE_AMBIENT_CONTENTS,
          "BEGIN CERTIFICATE",
        ];
        const safeProbeDiagnostics = privateValues.reduce(
          (output, value) => output.replaceAll(value, "[redacted]"),
          commandOutput(probe),
        );
        expect(probe.status, `packaged runner probe failed:\n${safeProbeDiagnostics}`).toBe(0);

        const result = JSON.parse(probe.stdout) as {
          applyError: string;
          effects: string[];
          planOutput: string;
          runnerUrl: string;
        };
        expect(result.runnerUrl.startsWith("file://" + installedPackage)).toBe(true);
        expect(result.effects).toEqual([]);
        expect(result.applyError).toBe(
          "External OpenShell target apply is not available until typed readiness and inventory are implemented.",
        );

        const planStart = result.planOutput.indexOf("{");
        expect(planStart).toBeGreaterThan(-1);
        const plan = JSON.parse(result.planOutput.slice(planStart)) as Record<string, unknown>;
        expect(plan).toEqual({
          run_id: expect.stringMatching(/^nc-\d{8}-\d{6}-[0-9a-f]{8}$/u),
          openshell_target: {
            endpoint: "https://openshell.example.test:8443",
            workspace: "default",
            expected_release: "0.0.106",
            lifecycle: "external",
            authentication_source: "file",
            ca_fingerprint: `sha256:${createHash("sha256")
              .update(new X509Certificate(CA_PEM).raw)
              .digest("hex")}`,
          },
          dry_run: false,
        });
        const publicOutput = `${result.planOutput}\n${result.applyError}`;
        expect(privateValues.some((value) => publicOutput.includes(value))).toBe(false);
      } finally {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
  );
});
