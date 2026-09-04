// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rootCertificates } from "node:tls";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";

const REPOSITORY_ROOT = path.join(import.meta.dirname, "..", "..");
const PRIVATE_AUTHENTICATION_CONTENTS = "opaque-private-authentication-material";
const PRIVATE_AMBIENT_CONTENTS = "opaque-ambient-gateway-material";
const CA_PEM = rootCertificates[0]!;
const UNSAFE_DIAGNOSTIC_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;

function commandOutput(result: SpawnSyncReturns<string>): string {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function assertCommandSucceeded(result: SpawnSyncReturns<string>, label: string): void {
  expect(result.status, `${label} failed:\n${commandOutput(result)}`).toBe(0);
}

function expectStableSingleLineDiagnostic(stderr: string): void {
  expect(stderr.endsWith("\n")).toBe(true);
  expect(stderr.slice(0, -1)).not.toMatch(UNSAFE_DIAGNOSTIC_CHARACTERS);
}

function npmEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  cacheExists: (candidate: string) => boolean = fs.existsSync,
): NodeJS.ProcessEnv {
  const runnerCache = environment.RUNNER_TEMP
    ? path.join(environment.RUNNER_TEMP, "npm")
    : undefined;
  const cacheDirectory =
    environment.NPM_CONFIG_CACHE ??
    (runnerCache && cacheExists(path.join(runnerCache, "_cacache")) ? runnerCache : undefined) ??
    environment.npm_config_cache;
  return {
    ...environment,
    npm_config_audit: "false",
    ...(cacheDirectory ? { npm_config_cache: cacheDirectory } : {}),
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
}

function rootPackagePackEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...npmEnvironment(environment), NEMOCLAW_INSTALLING: "1" };
}

function writeRuntimeProbe(probePath: string): void {
  fs.writeFileSync(
    probePath,
    String.raw`
import childProcess from "node:child_process";
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";

const effects = [];
const ambientPrefix = path.resolve(process.env.NEMOCLAW_TEST_AMBIENT_ROOT) + path.sep;
const credentialPath = path.resolve(process.env.NEMOCLAW_TEST_AUTHENTICATION_FILE);
const evidencePath = path.resolve(process.env.NEMOCLAW_TEST_EVIDENCE_FILE);
const originalWriteFileSync = fs.writeFileSync;
const credentialDescriptors = new Set();
const forbid = (kind) => (..._args) => {
  effects.push(kind);
  throw new Error("forbidden packaged-runner effect");
};

process.on("exit", () => {
  originalWriteFileSync(evidencePath, JSON.stringify({ effects }));
});

for (const name of ["exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync"]) {
  childProcess[name] = forbid("subprocess");
}
for (const name of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny"]) {
  dns[name] = forbid("network");
}
http.get = forbid("network");
http.request = forbid("network");
http2.connect = forbid("network");
https.get = forbid("network");
https.request = forbid("network");
net.Socket.prototype.connect = forbid("network");
tls.connect = forbid("network");
globalThis.fetch = forbid("network");

for (const name of ["accessSync", "lstatSync", "readdirSync", "statSync"]) {
  const original = fs[name];
  fs[name] = (...args) => {
    const candidate = args[0];
    if (typeof candidate === "string" && path.resolve(candidate).startsWith(ambientPrefix)) {
      effects.push("ambient-gateway-read");
      throw new Error("forbidden ambient gateway read");
    }
    return original(...args);
  };
}
const originalOpenSync = fs.openSync;
fs.openSync = (...args) => {
  const descriptor = originalOpenSync(...args);
  if (typeof args[0] === "string" && path.resolve(args[0]) === credentialPath) {
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
  if (typeof candidate === "string" && path.resolve(candidate) === credentialPath) {
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
`,
  );
}

type ProbeEvidence = Readonly<{
  effects: string[];
}>;

describe("packaged Blueprint Runner npm cache", () => {
  it("marks root package packing as installer-owned so prepare cannot race the build", () => {
    const environment = rootPackagePackEnvironment({ NEMOCLAW_INSTALLING: "" });

    expect(environment.NEMOCLAW_INSTALLING).toBe("1");
  });

  it("uses the populated trusted runner cache before npm exec's default", () => {
    const runnerTemp = path.join(os.tmpdir(), "trusted-runner");
    const environment = npmEnvironment(
      { RUNNER_TEMP: runnerTemp, npm_config_cache: path.join(os.tmpdir(), "npm-default") },
      (candidate) => candidate === path.join(runnerTemp, "npm", "_cacache"),
    );

    expect(environment.npm_config_cache).toBe(path.join(runnerTemp, "npm"));
  });

  it("keeps npm exec's cache when the runner cache is not populated", () => {
    const defaultCache = path.join(os.tmpdir(), "npm-default");
    const environment = npmEnvironment(
      { RUNNER_TEMP: path.join(os.tmpdir(), "empty-runner"), npm_config_cache: defaultCache },
      () => false,
    );

    expect(environment.npm_config_cache).toBe(defaultCache);
  });
});

type RunnerResult = Readonly<{
  evidence: ProbeEvidence;
  result: SpawnSyncReturns<string>;
  safeDiagnostics: string;
}>;

describe.sequential("packaged Blueprint Runner external target", () => {
  let ambientRoot: string;
  let blueprintFile: string;
  let blueprintRoot: string;
  let evidencePath: string;
  let fixtureRoot: string;
  let installedBinary: string;
  let privateAuthenticationPath: string;
  let privateCaPath: string;
  let privateValues: string[];
  let runRunner: (argv: string[]) => RunnerResult;
  let validBlueprint: string;
  let validBlueprintDocument: Record<string, unknown>;

  beforeAll(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-external-target-package-"));
    const archiveRoot = path.join(fixtureRoot, "archive");
    const consumerRoot = path.join(fixtureRoot, "consumer");
    const installRoot = path.join(fixtureRoot, "install");
    const runtimeRoot = path.join(fixtureRoot, "runtime");
    blueprintRoot = path.join(runtimeRoot, "blueprint");
    const privateRoot = path.join(runtimeRoot, "private-inputs");
    ambientRoot = path.join(runtimeRoot, "ambient-home");
    privateCaPath = path.join(privateRoot, "private-ca.pem");
    privateAuthenticationPath = path.join(privateRoot, "private-authentication");
    evidencePath = path.join(runtimeRoot, "probe-evidence.json");

    fs.mkdirSync(archiveRoot, { recursive: true });
    const pack = spawnSync(
      "npm",
      ["pack", "--ignore-scripts", "--silent", "--pack-destination", archiveRoot],
      { cwd: REPOSITORY_ROOT, encoding: "utf8", env: rootPackagePackEnvironment() },
    );
    assertCommandSucceeded(pack, "root package archive creation");
    const archives = fs.readdirSync(archiveRoot).filter((entry) => entry.endsWith(".tgz"));
    expect(archives).toHaveLength(1);
    const archive = path.join(archiveRoot, archives[0]!);

    fs.mkdirSync(installRoot, { recursive: true });
    const extract = spawnSync("tar", ["-xzf", archive, "--strip-components=1", "-C", installRoot], {
      encoding: "utf8",
      env: npmEnvironment(),
    });
    assertCommandSucceeded(extract, "root package archive extraction");
    fs.copyFileSync(
      path.join(REPOSITORY_ROOT, "package-lock.json"),
      path.join(installRoot, "package-lock.json"),
    );
    const install = spawnSync("npm", ["ci", "--ignore-scripts", "--offline", "--omit=dev"], {
      cwd: installRoot,
      encoding: "utf8",
      env: npmEnvironment(),
    });
    assertCommandSucceeded(install, "locked installation of the packed Runner graph");

    fs.mkdirSync(consumerRoot, { recursive: true });
    fs.writeFileSync(
      path.join(consumerRoot, "package.json"),
      JSON.stringify({ name: "nemoclaw-blueprint-runner-consumer", private: true }),
    );
    const consumerInstall = spawnSync(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--offline",
        "--omit=dev",
        "--no-save",
        "--package-lock=false",
        installRoot,
      ],
      {
        cwd: consumerRoot,
        encoding: "utf8",
        env: { ...npmEnvironment(), NEMOCLAW_INSTALLING: "1" },
      },
    );
    assertCommandSucceeded(consumerInstall, "offline consumer installation of the packed Runner");

    installedBinary = path.join(consumerRoot, "node_modules", ".bin", "nemoclaw-blueprint-runner");
    fs.mkdirSync(blueprintRoot, { recursive: true });
    fs.mkdirSync(privateRoot, { recursive: true });
    fs.mkdirSync(path.join(ambientRoot, ".config", "openshell"), { recursive: true });
    fs.writeFileSync(privateCaPath, CA_PEM);
    fs.writeFileSync(privateAuthenticationPath, PRIVATE_AUTHENTICATION_CONTENTS);
    fs.writeFileSync(
      path.join(ambientRoot, ".config", "openshell", "gateway.env"),
      PRIVATE_AMBIENT_CONTENTS,
    );
    blueprintFile = path.join(blueprintRoot, "blueprint.yaml");
    validBlueprintDocument = {
      version: "1.0.0",
      min_openshell_version: "0.0.106",
      max_openshell_version: "0.0.106",
      openshell_target: {
        endpoint: "https://192.0.2.1:8443",
        workspace: "default",
        expected_release: "0.0.106",
        lifecycle: "external",
        trust: { ca_file: privateCaPath },
        authentication: { credential_file: privateAuthenticationPath },
      },
    };
    validBlueprint = YAML.stringify(validBlueprintDocument);

    const probePath = path.join(installRoot, "runtime-probe.mjs");
    writeRuntimeProbe(probePath);
    privateValues = [
      fixtureRoot,
      privateCaPath,
      privateAuthenticationPath,
      PRIVATE_AUTHENTICATION_CONTENTS,
      PRIVATE_AMBIENT_CONTENTS,
      "BEGIN CERTIFICATE",
    ];
    runRunner = (argv: string[]) => {
      fs.rmSync(evidencePath, { force: true });
      const result = spawnSync(installedBinary, argv, {
        cwd: runtimeRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: ambientRoot,
          NODE_OPTIONS: `--import=${probePath}`,
          NEMOCLAW_BLUEPRINT_PATH: blueprintRoot,
          NEMOCLAW_TEST_AMBIENT_ROOT: ambientRoot,
          NEMOCLAW_TEST_AUTHENTICATION_FILE: privateAuthenticationPath,
          NEMOCLAW_TEST_EVIDENCE_FILE: evidencePath,
          XDG_CONFIG_HOME: path.join(ambientRoot, ".config"),
        },
      });
      const safeDiagnostics = privateValues.reduce(
        (output, value) => output.replaceAll(value, "[redacted]"),
        commandOutput(result),
      );
      expect(
        fs.existsSync(evidencePath),
        `packaged runner did not write probe evidence:\n${safeDiagnostics}`,
      ).toBe(true);
      const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8")) as ProbeEvidence;
      return { evidence, result, safeDiagnostics };
    };
  }, 240_000);

  beforeEach(() => {
    fs.mkdirSync(blueprintRoot, { recursive: true });
    fs.mkdirSync(path.dirname(privateCaPath), { recursive: true });
    fs.mkdirSync(path.join(ambientRoot, ".config", "openshell"), { recursive: true });
    fs.writeFileSync(privateCaPath, CA_PEM);
    fs.writeFileSync(privateAuthenticationPath, PRIVATE_AUTHENTICATION_CONTENTS);
    fs.writeFileSync(
      path.join(ambientRoot, ".config", "openshell", "gateway.env"),
      PRIVATE_AMBIENT_CONTENTS,
    );
    fs.writeFileSync(blueprintFile, validBlueprint);
  });

  afterAll(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function expectPrivateValuesRedacted(result: SpawnSyncReturns<string>): void {
    expect(privateValues.some((value) => commandOutput(result).includes(value))).toBe(false);
  }

  it("rejects a missing packaged blueprint before effects (#9872)", () => {
    // Setup
    const hiddenBlueprint = `${blueprintFile}.hidden`;
    fs.renameSync(blueprintFile, hiddenBlueprint);

    // Action
    const execution = runRunner(["status", "--external-target"]);
    fs.renameSync(hiddenBlueprint, blueprintFile);

    // Result
    expect(execution.result.status, execution.safeDiagnostics).toBe(1);
    expect(execution.result.stderr).toContain("blueprint.yaml not found");
    expect(execution.result.stderr).not.toContain(blueprintRoot);
    expectStableSingleLineDiagnostic(execution.result.stderr);
    expect(execution.evidence).toEqual({ effects: [] });
    expectPrivateValuesRedacted(execution.result);
  });

  it("rejects malformed packaged blueprint YAML before effects (#9872)", () => {
    // Setup
    fs.writeFileSync(
      blueprintFile,
      `openshell_target:\n  trust:\n    ca_file: [${privateCaPath}\u001b[31m`,
    );

    // Action
    const execution = runRunner(["status", "--external-target"]);

    // Result
    expect(execution.result.status, execution.safeDiagnostics).toBe(1);
    expect(execution.result.stderr).toContain("blueprint.yaml contains invalid YAML");
    expect(execution.result.stderr).not.toContain(privateCaPath);
    expectStableSingleLineDiagnostic(execution.result.stderr);
    expect(execution.evidence).toEqual({ effects: [] });
    expectPrivateValuesRedacted(execution.result);
  });

  it("rejects a packaged blueprint without a mapping before effects (#9872)", () => {
    // Setup
    fs.writeFileSync(blueprintFile, privateCaPath);

    // Action
    const execution = runRunner(["status", "--external-target"]);

    // Result
    expect(execution.result.status, execution.safeDiagnostics).toBe(1);
    expect(execution.result.stderr).toContain(
      "blueprint.yaml must contain a YAML mapping with valid nested component shapes",
    );
    expect(execution.result.stderr).not.toContain(privateCaPath);
    expectStableSingleLineDiagnostic(execution.result.stderr);
    expect(execution.evidence).toEqual({ effects: [] });
    expectPrivateValuesRedacted(execution.result);
  });

  it("rejects an invalid packaged runner action before effects (#9872)", () => {
    // Setup
    const invalidAction = `\u001b[31m${privateCaPath}\u202e`;

    // Action
    const execution = runRunner([invalidAction]);

    // Result
    expect(execution.result.status, execution.safeDiagnostics).toBe(1);
    expect(execution.result.stderr).toContain(
      "Unknown action. Use: plan, apply, status, reconcile, rollback, snapshots",
    );
    expect(execution.result.stderr).not.toContain(privateCaPath);
    expectStableSingleLineDiagnostic(execution.result.stderr);
    expect(execution.evidence).toEqual({ effects: [] });
    expectPrivateValuesRedacted(execution.result);
  });

  it("rejects an unsupported external target release before effects (#9872)", () => {
    // Setup
    fs.writeFileSync(
      blueprintFile,
      YAML.stringify({
        ...validBlueprintDocument,
        min_openshell_version: "0.0.105",
        openshell_target: {
          ...(validBlueprintDocument.openshell_target as Record<string, unknown>),
          expected_release: "0.0.105",
        },
      }),
    );

    // Action
    const execution = runRunner(["plan"]);

    // Result
    expect(execution.result.status, execution.safeDiagnostics).toBe(1);
    expect(execution.result.stderr).toContain(
      "external OpenShell target expected_release must be 0.0.106",
    );
    expect(execution.result.stdout).not.toContain("openshell_target");
    expect(execution.evidence).toEqual({ effects: [] });
    expectPrivateValuesRedacted(execution.result);
  });

  it("prints the packaged external target plan without effects (#9872)", () => {
    // Setup
    const expectedFingerprint = `sha256:${createHash("sha256").update(new X509Certificate(CA_PEM).raw).digest("hex")}`;

    // Action
    const execution = runRunner(["plan"]);

    // Result
    expect(execution.result.status, execution.safeDiagnostics).toBe(0);
    expect(execution.evidence).toEqual({ effects: [] });
    const planStart = execution.result.stdout.indexOf("{");
    expect(planStart).toBeGreaterThan(-1);
    expect(JSON.parse(execution.result.stdout.slice(planStart))).toEqual({
      run_id: expect.stringMatching(/^nc-\d{8}-\d{6}-[0-9a-f]{8}$/u),
      openshell_target: {
        endpoint: "https://192.0.2.1:8443",
        workspace: "default",
        expected_release: "0.0.106",
        lifecycle: "external",
        authentication_source: "file",
        ca_fingerprint: expectedFingerprint,
      },
      dry_run: false,
    });
    expectPrivateValuesRedacted(execution.result);
  });

  it("rejects packaged external target apply before effects (#9872)", () => {
    // Setup
    const expectedDiagnostic =
      "External OpenShell target apply is not available until typed readiness and inventory are implemented.";

    // Action
    const execution = runRunner(["apply"]);

    // Result
    expect(execution.result.status, execution.safeDiagnostics).toBe(1);
    expect(execution.result.stderr).toContain(expectedDiagnostic);
    expect(execution.evidence).toEqual({ effects: [] });
    expectPrivateValuesRedacted(execution.result);
  });
});
