// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rootCertificates } from "node:tls";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

const REPOSITORY_ROOT = path.join(import.meta.dirname, "..", "..");
const OPENSHELL_SDK_PACKAGE = "@nvidia/openshell-sdk";
const UNSAFE_RUNNER_FIXTURE = path.join(
  REPOSITORY_ROOT,
  "test",
  "package-contract",
  "fixtures",
  "blueprint-runner-unsafe-diagnostic.ts",
);
const PRIVATE_AUTHENTICATION_CONTENTS = "opaque-private-authentication-material";
const PRIVATE_AMBIENT_CONTENTS = "opaque-ambient-gateway-material";
const PRIVATE_ENTRY_SECRET = `nvapi-${"A".repeat(64)}`;
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

function packagePath(root: string, packageName: string): string {
  return path.join(root, "node_modules", ...packageName.split("/"));
}

function installedPackageIdentity(
  installRoot: string,
  packageName: string,
): Readonly<{ name: unknown; version: unknown }> {
  const manifestPath = path.join(packagePath(installRoot, packageName), "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  return { name: manifest.name, version: manifest.version };
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

describe("packaged Blueprint Runner external target", () => {
  it(
    "executes the installed package command and fails before effects when the SDK is absent (#9872)",
    { timeout: 240_000 },
    () => {
      const fixtureRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-external-target-package-"),
      );
      const archiveRoot = path.join(fixtureRoot, "archive");
      const consumerRoot = path.join(fixtureRoot, "consumer");
      const installRoot = path.join(fixtureRoot, "install");
      const runtimeRoot = path.join(fixtureRoot, "runtime");
      const blueprintRoot = path.join(runtimeRoot, "blueprint");
      const privateRoot = path.join(runtimeRoot, "private-inputs");
      const ambientRoot = path.join(runtimeRoot, "ambient-home");
      const privateCaPath = path.join(privateRoot, "private-ca.pem");
      const privateAuthenticationPath = path.join(privateRoot, "private-authentication");
      const evidencePath = path.join(runtimeRoot, "probe-evidence.json");

      try {
        fs.mkdirSync(archiveRoot, { recursive: true });
        const pack = spawnSync(
          "npm",
          ["pack", "--ignore-scripts", "--silent", "--pack-destination", archiveRoot],
          { cwd: REPOSITORY_ROOT, encoding: "utf8", env: npmEnvironment() },
        );
        assertCommandSucceeded(pack, "root package archive creation");
        const archives = fs.readdirSync(archiveRoot).filter((entry) => entry.endsWith(".tgz"));
        expect(archives).toHaveLength(1);
        const archive = path.join(archiveRoot, archives[0]!);

        fs.mkdirSync(installRoot, { recursive: true });
        const extract = spawnSync(
          "tar",
          ["-xzf", archive, "--strip-components=1", "-C", installRoot],
          { encoding: "utf8", env: npmEnvironment() },
        );
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
        assertCommandSucceeded(
          consumerInstall,
          "offline consumer installation of the packed Runner",
        );

        const installedPackage = installRoot;
        const installedRunner = path.join(
          installedPackage,
          "nemoclaw",
          "dist",
          "blueprint",
          "runner.js",
        );
        const installedRuntimeRunner = path.join(
          installedPackage,
          "dist",
          "nemoclaw",
          "blueprint",
          "runner.js",
        );
        const installedSharedSdkObserver = path.join(
          installedPackage,
          "nemoclaw",
          "dist",
          "shared",
          "openshell-gateway-health-sdk.js",
        );
        const installedRuntimeSdkObserver = path.join(
          installedPackage,
          "dist",
          "nemoclaw",
          "shared",
          "openshell-gateway-health-sdk.js",
        );
        const installedBinary = path.join(
          consumerRoot,
          "node_modules",
          ".bin",
          "nemoclaw-blueprint-runner",
        );
        expect(fs.existsSync(installedRunner)).toBe(true);
        expect(fs.existsSync(installedSharedSdkObserver)).toBe(true);
        expect(fs.existsSync(installedRuntimeSdkObserver)).toBe(false);
        expect(fs.existsSync(path.join(installedPackage, "nemoclaw", "src"))).toBe(false);
        expect(fs.existsSync(installedRuntimeRunner)).toBe(true);
        expect(
          JSON.parse(
            fs.readFileSync(
              path.join(installedPackage, "dist", "nemoclaw", "package.json"),
              "utf8",
            ),
          ),
        ).toEqual({ type: "module" });
        expect(installedPackageIdentity(installRoot, "@bufbuild/protobuf")).toEqual({
          name: "@bufbuild/protobuf",
          version: "2.12.1",
        });
        expect(installedPackageIdentity(installRoot, "@connectrpc/connect")).toEqual({
          name: "@connectrpc/connect",
          version: "2.1.2",
        });
        expect(installedPackageIdentity(installRoot, "@connectrpc/connect-node")).toEqual({
          name: "@connectrpc/connect-node",
          version: "2.1.2",
        });
        expect(installedPackageIdentity(installRoot, OPENSHELL_SDK_PACKAGE)).toEqual({
          name: OPENSHELL_SDK_PACKAGE,
          version: "0.0.106",
        });
        const installedSdkRoot = packagePath(installRoot, OPENSHELL_SDK_PACKAGE);
        expect(
          fs.existsSync(path.join(installedSdkRoot, "node_modules", "@bufbuild", "protobuf")),
        ).toBe(false);
        expect(
          fs.existsSync(path.join(installedSdkRoot, "node_modules", "@connectrpc", "connect")),
        ).toBe(false);
        expect(
          fs.existsSync(path.join(installedSdkRoot, "node_modules", "@connectrpc", "connect-node")),
        ).toBe(false);

        fs.mkdirSync(blueprintRoot, { recursive: true });
        fs.mkdirSync(privateRoot, { recursive: true });
        fs.mkdirSync(path.join(ambientRoot, ".config", "openshell"), { recursive: true });
        fs.writeFileSync(privateCaPath, CA_PEM);
        fs.writeFileSync(privateAuthenticationPath, PRIVATE_AUTHENTICATION_CONTENTS);
        fs.writeFileSync(
          path.join(ambientRoot, ".config", "openshell", "gateway.env"),
          PRIVATE_AMBIENT_CONTENTS,
        );
        const blueprintFile = path.join(blueprintRoot, "blueprint.yaml");
        const validBlueprintDocument = {
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
        const validBlueprint = YAML.stringify(validBlueprintDocument);
        fs.writeFileSync(blueprintFile, validBlueprint);

        const probePath = path.join(installedPackage, "runtime-probe.mjs");
        writeRuntimeProbe(probePath);
        const privateValues = [
          fixtureRoot,
          privateCaPath,
          privateAuthenticationPath,
          PRIVATE_AUTHENTICATION_CONTENTS,
          PRIVATE_AMBIENT_CONTENTS,
          PRIVATE_ENTRY_SECRET,
          "BEGIN CERTIFICATE",
        ];
        const runRunner = (argv: string[]) => {
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

        const hiddenBlueprint = `${blueprintFile}.hidden`;
        fs.renameSync(blueprintFile, hiddenBlueprint);
        const missingBlueprint = runRunner(["status", "--external-target"]);
        fs.renameSync(hiddenBlueprint, blueprintFile);
        expect(missingBlueprint.result.status, missingBlueprint.safeDiagnostics).toBe(1);
        expect(missingBlueprint.result.stderr).toContain("blueprint.yaml not found");
        expect(missingBlueprint.result.stderr).not.toContain(blueprintRoot);
        expectStableSingleLineDiagnostic(missingBlueprint.result.stderr);
        expect(missingBlueprint.evidence).toEqual({ effects: [] });

        fs.writeFileSync(
          blueprintFile,
          `openshell_target:\n  trust:\n    ca_file: [${privateCaPath}\u001b[31m`,
        );
        const malformedBlueprint = runRunner(["status", "--external-target"]);
        expect(malformedBlueprint.result.status, malformedBlueprint.safeDiagnostics).toBe(1);
        expect(malformedBlueprint.result.stderr).toContain("blueprint.yaml contains invalid YAML");
        expect(malformedBlueprint.result.stderr).not.toContain(privateCaPath);
        expectStableSingleLineDiagnostic(malformedBlueprint.result.stderr);
        expect(malformedBlueprint.evidence).toEqual({ effects: [] });

        fs.writeFileSync(blueprintFile, privateCaPath);
        const invalidBlueprint = runRunner(["status", "--external-target"]);
        expect(invalidBlueprint.result.status, invalidBlueprint.safeDiagnostics).toBe(1);
        expect(invalidBlueprint.result.stderr).toContain(
          "blueprint.yaml must contain a YAML mapping with valid nested component shapes",
        );
        expect(invalidBlueprint.result.stderr).not.toContain(privateCaPath);
        expectStableSingleLineDiagnostic(invalidBlueprint.result.stderr);
        expect(invalidBlueprint.evidence).toEqual({ effects: [] });

        fs.writeFileSync(blueprintFile, validBlueprint);
        const invalidAction = runRunner([`\u001b[31m${privateCaPath}\u202e`]);
        expect(invalidAction.result.status, invalidAction.safeDiagnostics).toBe(1);
        expect(invalidAction.result.stderr).toContain(
          "Unknown action. Use: plan, apply, status, reconcile, rollback, snapshots",
        );
        expect(invalidAction.result.stderr).not.toContain(privateCaPath);
        expectStableSingleLineDiagnostic(invalidAction.result.stderr);
        expect(invalidAction.evidence).toEqual({ effects: [] });

        const installedRunnerSource = fs.readFileSync(installedRuntimeRunner, "utf8");
        const boundedEntryDiagnostic = (() => {
          try {
            fs.copyFileSync(UNSAFE_RUNNER_FIXTURE, installedRuntimeRunner);
            return runRunner(["status", "--external-target"]);
          } finally {
            fs.writeFileSync(installedRuntimeRunner, installedRunnerSource);
          }
        })();
        expect(boundedEntryDiagnostic.result.status, boundedEntryDiagnostic.safeDiagnostics).toBe(
          1,
        );
        expect(boundedEntryDiagnostic.result.stderr).toContain("<REDACTED>");
        expect(boundedEntryDiagnostic.result.stderr).not.toContain(PRIVATE_ENTRY_SECRET);
        expect(boundedEntryDiagnostic.result.stderr.length).toBeLessThanOrEqual(1_032);
        expectStableSingleLineDiagnostic(boundedEntryDiagnostic.result.stderr);
        expect(boundedEntryDiagnostic.evidence).toEqual({ effects: [] });

        const installedSdk = packagePath(installRoot, OPENSHELL_SDK_PACKAGE);
        const disabledSdk = `${installedSdk}.disabled`;
        fs.renameSync(installedSdk, disabledSdk);
        const absentStatus = runRunner(["status", "--external-target"]);
        fs.renameSync(disabledSdk, installedSdk);
        expect(absentStatus.result.status, absentStatus.safeDiagnostics).toBe(1);
        expect(absentStatus.result.stderr).toContain(
          "The approved OpenShell SDK 0.0.106 is unavailable.",
        );
        expect(absentStatus.result.stderr).not.toContain("NemoClaw could not reach");
        expect(absentStatus.evidence).toEqual({ effects: [] });

        const presentStatus = runRunner(["status", "--external-target"]);
        expect(presentStatus.result.status, presentStatus.safeDiagnostics).toBe(1);
        expect(presentStatus.result.stderr).toContain(
          "NemoClaw could not reach the external OpenShell target.",
        );
        expect(presentStatus.evidence).toEqual({ effects: ["network"] });

        fs.writeFileSync(
          blueprintFile,
          YAML.stringify({
            ...validBlueprintDocument,
            min_openshell_version: "0.0.105",
            openshell_target: {
              ...validBlueprintDocument.openshell_target,
              expected_release: "0.0.105",
            },
          }),
        );
        const unsupportedReleasePlan = runRunner(["plan"]);
        expect(unsupportedReleasePlan.result.status, unsupportedReleasePlan.safeDiagnostics).toBe(
          1,
        );
        expect(unsupportedReleasePlan.result.stderr).toContain(
          "external OpenShell target expected_release must be 0.0.106",
        );
        expect(unsupportedReleasePlan.result.stdout).not.toContain("openshell_target");
        expect(unsupportedReleasePlan.evidence.effects).toEqual([]);
        fs.writeFileSync(blueprintFile, validBlueprint);

        const plan = runRunner(["plan"]);
        expect(plan.result.status, plan.safeDiagnostics).toBe(0);
        expect(plan.evidence.effects).toEqual([]);
        const planStart = plan.result.stdout.indexOf("{");
        expect(planStart).toBeGreaterThan(-1);
        expect(JSON.parse(plan.result.stdout.slice(planStart))).toEqual({
          run_id: expect.stringMatching(/^nc-\d{8}-\d{6}-[0-9a-f]{8}$/u),
          openshell_target: {
            endpoint: "https://192.0.2.1:8443",
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

        const apply = runRunner(["apply"]);
        expect(apply.result.status, apply.safeDiagnostics).toBe(1);
        expect(apply.result.stderr).toContain(
          "External OpenShell target apply is not available until typed readiness and inventory are implemented.",
        );
        expect(apply.evidence.effects).toEqual([]);

        const publicOutput = [
          absentStatus.result.stdout,
          absentStatus.result.stderr,
          presentStatus.result.stdout,
          presentStatus.result.stderr,
          unsupportedReleasePlan.result.stdout,
          unsupportedReleasePlan.result.stderr,
          plan.result.stdout,
          plan.result.stderr,
          apply.result.stdout,
          apply.result.stderr,
          missingBlueprint.result.stdout,
          missingBlueprint.result.stderr,
          malformedBlueprint.result.stdout,
          malformedBlueprint.result.stderr,
          invalidBlueprint.result.stdout,
          invalidBlueprint.result.stderr,
          invalidAction.result.stdout,
          invalidAction.result.stderr,
          boundedEntryDiagnostic.result.stdout,
          boundedEntryDiagnostic.result.stderr,
        ].join("\n");
        expect(privateValues.some((value) => publicOutput.includes(value))).toBe(false);
      } finally {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
  );
});
