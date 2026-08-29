// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertReviewedAuditReportsPass,
  auditMaterializedSourceGraph,
  materializeSourceGraph,
  normalizeOpenClawSignatureAlias,
  parseAuditConfig,
  reviewedArchiveGraphManifest,
  selectReviewedLockSha256,
  verifyMaterializedLockedGraph,
} from "../../../scripts/audit-reviewed-npm-graph.mts";
import { verifyInstalledNpmLock } from "../../../scripts/lib/reviewed-npm-archive.mts";
import type { AuditPolicyResult } from "../../../scripts/lib/reviewed-npm-audit.mts";

type WorkflowStep = {
  readonly env?: Record<string, string>;
  readonly id?: string;
  readonly if?: string;
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
};

type WorkflowJob = {
  readonly needs?: string | readonly string[];
  readonly steps?: readonly WorkflowStep[];
};

type Workflow = {
  readonly jobs: Record<string, WorkflowJob>;
};

const REPO_ROOT = path.join(import.meta.dirname, "../../..");
const DOMEXCEPTION_INTEGRITY =
  "sha512-tlc/FcYIv5i8RYsl2iDil4A0gOihaas1R5jPcIC4Zw3GhjKsVilw90aHcVlhZPTBLGBzd379S+VcnsDjd9ChiA==";

function requiredStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === name);
  expect(step, `Missing workflow step: ${name}`).toBeDefined();
  return step as WorkflowStep;
}

function writeProductionSourceGraph(
  root: string,
  packageRecord: Readonly<Record<string, unknown>>,
  additionalPackageRecords: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {},
  optional = false,
): Readonly<{ sourceLock: string; sourcePackage: string }> {
  const source = path.join(root, "source");
  const manifest = {
    ...(optional
      ? { optionalDependencies: { "fixture-package": "1.0.0" } }
      : { dependencies: { "fixture-package": "1.0.0" } }),
    name: "source-graph-fixture",
    private: true,
    version: "1.0.0",
  };
  const lock = {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": manifest,
      "node_modules/fixture-package": packageRecord,
      ...additionalPackageRecords,
    },
  };
  fs.mkdirSync(source);
  const sourcePackage = path.join(source, "package.json");
  const sourceLock = path.join(source, "package-lock.json");
  fs.writeFileSync(sourcePackage, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(sourceLock, `${JSON.stringify(lock, null, 2)}\n`);
  return { sourceLock, sourcePackage };
}

describe("trusted reviewed npm audit workflow (#5896)", () => {
  it("accepts only an explicitly reviewed lock during a dependency transition", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-reviewed-lock-transition-"));
    const lockfile = path.join(root, "package-lock.json");
    fs.writeFileSync(lockfile, "reviewed lock\n");
    const actualLock = "534ade489fdb2d8ff619a8b110c28fedbd2066e16ebf434738f64a5a44ec9860";
    const previousLock = "a".repeat(64);
    const unreviewedLock = "b".repeat(64);
    try {
      expect(selectReviewedLockSha256(lockfile, actualLock, undefined, "test graph")).toBe(
        actualLock,
      );
      expect(selectReviewedLockSha256(lockfile, previousLock, actualLock, "test graph")).toBe(
        actualLock,
      );
      expect(() =>
        selectReviewedLockSha256(lockfile, previousLock, unreviewedLock, "test graph"),
      ).toThrow("lock SHA-256 mismatch");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a replacement lock digest that duplicates the current digest", () => {
    const digest = "a".repeat(64);
    const config = {
      archiveGraphId: "reviewed-archive-graph",
      archivePackages: [],
      archiveTarVersion: "7.5.21",
      artifactDirectory: "artifacts/reviewed-npm-audit",
      exceptionFile: "ci/npm-audit-exceptions.json",
      lockedGraphs: [
        {
          directory: "agents/openclaw/openclaw-runtime",
          id: "openclaw-runtime",
          lockSha256: digest,
          replacementLockSha256: digest,
        },
      ],
      nodeVersion: "22.23.2",
      registryOrigin: "https://registry.npmjs.org/",
      schemaVersion: 2,
      severityThreshold: "high",
      sourceNestedShrinkwrapPackages: [],
      sourceRegistryPackage: {
        artifactName: "reviewed-package-1.0.0.tgz",
        integrity: "sha512-reviewedintegrity",
        label: "reviewed package 1.0.0",
        packageSpec: "@example/reviewed@1.0.0",
        tarballUrl: "https://npm.pkg.github.com/download/@example/reviewed/1.0.0/reviewed",
      },
      sourceRegistryPackagesWithoutIntegrity: [],
    };

    expect(() => parseAuditConfig(JSON.stringify(config))).toThrow(
      "ci/reviewed-npm-audit.json is invalid",
    );
  });

  // source-shape-contract: security -- One reviewed package field prevents a second package identity from bypassing the credential-isolation workflow
  it("rejects the removed plural source-registry package shape", () => {
    const configFile = path.join(REPO_ROOT, "ci", "reviewed-npm-audit.json");
    const config = JSON.parse(fs.readFileSync(configFile, "utf-8")) as Record<string, unknown>;
    config.sourceRegistryPackages = [config.sourceRegistryPackage];
    delete config.sourceRegistryPackage;

    expect(() => parseAuditConfig(JSON.stringify(config))).toThrow(
      "ci/reviewed-npm-audit.json is invalid",
    );
  });

  // source-shape-contract: security -- Exact package specifications must fail before malformed reviewed identities can authorize dependency installation
  it("rejects malformed reviewed source package specifications", () => {
    const configFile = path.join(REPO_ROOT, "ci", "reviewed-npm-audit.json");
    const readConfig = () =>
      JSON.parse(fs.readFileSync(configFile, "utf-8")) as {
        sourceRegistryPackage: { packageSpec: string };
        sourceRegistryPackagesWithoutIntegrity: Array<{ packageSpec: string }>;
      };

    let config = readConfig();
    config.sourceRegistryPackage.packageSpec = "@nvidia/openshell-sdk@latest";
    expect(() => parseAuditConfig(JSON.stringify(config))).toThrow(
      "ci/reviewed-npm-audit.json is invalid",
    );

    config = readConfig();
    config.sourceRegistryPackage.packageSpec = "@nvidia/openshell-sdk@01.2.3";
    expect(() => parseAuditConfig(JSON.stringify(config))).toThrow(
      "ci/reviewed-npm-audit.json is invalid",
    );

    config = readConfig();
    config.sourceRegistryPackage.packageSpec = "@nvidia/openshell-sdk@1.2.3-01";
    expect(() => parseAuditConfig(JSON.stringify(config))).toThrow(
      "ci/reviewed-npm-audit.json is invalid",
    );

    config = readConfig();
    config.sourceRegistryPackage.packageSpec = "@nvidia/openshell-sdk@1.2.3-foo..bar";
    expect(() => parseAuditConfig(JSON.stringify(config))).toThrow(
      "ci/reviewed-npm-audit.json is invalid",
    );

    config = readConfig();
    config.sourceRegistryPackagesWithoutIntegrity[0]!.packageSpec = "not-an-exact-spec";
    expect(() => parseAuditConfig(JSON.stringify(config))).toThrow(
      "ci/reviewed-npm-audit.json is invalid",
    );
  });

  it("rejects an affected tar release for the reviewed archive graph", () => {
    expect(() => reviewedArchiveGraphManifest("7.5.20")).toThrow(
      "reviewed archive graph tar version must be exactly 7.5.21",
    );
  });

  it("rejects a mismatched npm bootstrap archive before installation (#8253)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-reviewed-npm-bootstrap-"));
    const bin = path.join(root, "bin");
    const npmLog = path.join(root, "npm.log");
    const installMarker = path.join(root, "install-called");
    const npmStub = path.join(bin, "npm");
    const bootstrap = path.join(
      REPO_ROOT,
      ".github",
      "actions",
      "ci-reviewed-npm-audit",
      "verify-and-install-npm.sh",
    );

    try {
      fs.mkdirSync(bin);
      fs.writeFileSync(
        npmStub,
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$1" >> "$NEMOCLAW_TEST_NPM_LOG"
case "$1" in
  pack)
    shift
    download_dir=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--pack-destination" ]; then
        download_dir="$2"
        break
      fi
      shift
    done
    [ -n "$download_dir" ]
    printf 'tampered archive\\n' > "$download_dir/npm-10.9.4.tgz"
    ;;
  install)
    : > "$NEMOCLAW_TEST_INSTALL_MARKER"
    ;;
  *)
    exit 2
    ;;
esac
`,
        { mode: 0o755 },
      );

      const result = spawnSync("bash", [bootstrap], {
        encoding: "utf8",
        env: {
          ...process.env,
          NEMOCLAW_REVIEWED_NPM_INTEGRITY: "sha512-invalid",
          NEMOCLAW_REVIEWED_NPM_VERSION: "10.9.4",
          NEMOCLAW_TEST_INSTALL_MARKER: installMarker,
          NEMOCLAW_TEST_NPM_LOG: npmLog,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          RUNNER_TEMP: root,
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("npm@10.9.4 archive integrity mismatch");
      expect(fs.readFileSync(npmLog, "utf8")).toBe("pack\n");
      expect(fs.existsSync(installMarker)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("installs a matching npm bootstrap archive offline (#8253)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-reviewed-npm-bootstrap-"));
    const bin = path.join(root, "bin");
    const npmLog = path.join(root, "npm.log");
    const npmStub = path.join(bin, "npm");
    const archiveContents = "verified archive\n";
    const bootstrap = path.join(
      REPO_ROOT,
      ".github",
      "actions",
      "ci-reviewed-npm-audit",
      "verify-and-install-npm.sh",
    );

    try {
      fs.mkdirSync(bin);
      fs.writeFileSync(
        npmStub,
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$NEMOCLAW_TEST_NPM_LOG"
case "$1" in
  pack)
    shift
    download_dir=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--pack-destination" ]; then
        download_dir="$2"
        break
      fi
      shift
    done
    [ -n "$download_dir" ]
    printf 'verified archive\\n' > "$download_dir/npm-10.9.4.tgz"
    ;;
  install)
    ;;
  *)
    exit 2
    ;;
esac
`,
        { mode: 0o755 },
      );

      const integrity = `sha512-${createHash("sha512").update(archiveContents).digest("base64")}`;
      const result = spawnSync("bash", [bootstrap], {
        encoding: "utf8",
        env: {
          ...process.env,
          NEMOCLAW_REVIEWED_NPM_INTEGRITY: integrity,
          NEMOCLAW_REVIEWED_NPM_VERSION: "10.9.4",
          NEMOCLAW_TEST_NPM_LOG: npmLog,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          RUNNER_TEMP: root,
        },
      });

      const npmInvocations = fs.readFileSync(npmLog, "utf8").trim().split("\n");
      expect(result.status).toBe(0);
      expect(npmInvocations).toHaveLength(2);
      expect(npmInvocations[0]).toContain("pack npm@10.9.4 --pack-destination");
      expect(npmInvocations[1]).toMatch(
        /^install --global .*\/npm-10\.9\.4\.tgz --userconfig \/dev\/null --ignore-scripts --no-audit --no-fund --offline$/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("materializes the NemoClaw production graph without changing its lock (#8116)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-source-graph-"));
    const source = path.join(root, "source");
    const destination = path.join(root, "materialized");
    const manifest = { name: "source-graph-fixture", private: true, version: "1.0.0" };
    const lock = {
      name: manifest.name,
      version: manifest.version,
      lockfileVersion: 3,
      requires: true,
      packages: { "": manifest },
    };
    const lockSource = `${JSON.stringify(lock, null, 2)}\n`;
    try {
      fs.mkdirSync(source);
      fs.writeFileSync(path.join(source, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      fs.writeFileSync(path.join(source, "package-lock.json"), lockSource);

      expect(
        materializeSourceGraph(
          path.join(source, "package.json"),
          path.join(source, "package-lock.json"),
          destination,
          "https://registry.npmjs.org",
          () => {},
        ),
      ).toBe(destination);
      expect(fs.readFileSync(path.join(destination, "package-lock.json"), "utf-8")).toBe(
        lockSource,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts an omitted development-only package in a locked production install (#8394)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-locked-production-"));
    const lockfilePath = path.join(root, "package-lock.json");
    const lockSource = `${JSON.stringify(
      {
        lockfileVersion: 3,
        packages: {
          "": {
            devDependencies: { "@types/node": "25.5.2" },
            name: "locked-production-fixture",
            version: "1.0.0",
          },
          "node_modules/@types/node": { dev: true, version: "25.5.2" },
        },
      },
      null,
      2,
    )}\n`;
    try {
      fs.writeFileSync(lockfilePath, lockSource);
      expect(
        verifyMaterializedLockedGraph({
          destination: root,
          expectedLockSha256: createHash("sha256").update(lockSource).digest("hex"),
          label: "locked production fixture",
        }),
      ).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an unreviewed registry package before npm ci installs the root production graph (#8116)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-source-graph-registry-"));
    const destination = path.join(root, "materialized");
    const { sourceLock, sourcePackage } = writeProductionSourceGraph(root, {
      integrity: "sha512-fixture",
      resolved: "https://example.com/fixture-package-1.0.0.tgz",
      version: "1.0.0",
    });
    let installCalled = false;
    try {
      expect(() =>
        materializeSourceGraph(
          sourcePackage,
          sourceLock,
          destination,
          "https://registry.npmjs.org",
          () => {
            installCalled = true;
          },
        ),
      ).toThrow(
        "reviewed npm lock package must use the reviewed registry: node_modules/fixture-package",
      );
      expect(installCalled).toBe(false);
      expect(fs.existsSync(destination)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts one exact package identity from an approved additional registry", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-source-graph-reviewed-registry-"));
    const destination = path.join(root, "materialized");
    const integrity = "sha512-fixture";
    const tarballUrl = "https://npm.pkg.github.com/download/fixture-package/1.0.0/revision";
    const { sourceLock, sourcePackage } = writeProductionSourceGraph(
      root,
      {
        integrity,
        optional: true,
        resolved: tarballUrl,
        version: "1.0.0",
      },
      {},
      true,
    );
    let installCalled = false;
    try {
      expect(
        materializeSourceGraph(
          sourcePackage,
          sourceLock,
          destination,
          "https://registry.npmjs.org",
          () => {
            installCalled = true;
          },
          {
            integrity,
            label: "reviewed fixture package",
            packageSpec: "fixture-package@1.0.0",
            tarballUrl,
          },
        ),
      ).toBe(destination);
      expect(installCalled).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts one exact package without registry integrity metadata", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-source-graph-without-integrity-"));
    const destination = path.join(root, "materialized");
    const tarballUrl = "https://registry.npmjs.org/fixture-package/-/fixture-package-1.0.0.tgz";
    const { sourceLock, sourcePackage } = writeProductionSourceGraph(
      root,
      { optional: true, resolved: tarballUrl, version: "1.0.0" },
      {},
      true,
    );
    let installCalled = false;
    try {
      expect(
        materializeSourceGraph(
          sourcePackage,
          sourceLock,
          destination,
          "https://registry.npmjs.org",
          () => {
            installCalled = true;
          },
          undefined,
          [],
          [
            {
              label: "reviewed fixture package without integrity",
              packageSpec: "fixture-package@1.0.0",
              tarballUrl,
            },
          ],
        ),
      ).toBe(destination);
      expect(installCalled).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects drift from an approved additional-registry package identity", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-source-graph-registry-drift-"));
    const destination = path.join(root, "materialized");
    const tarballUrl = "https://npm.pkg.github.com/download/fixture-package/1.0.0/revision";
    const { sourceLock, sourcePackage } = writeProductionSourceGraph(root, {
      integrity: "sha512-fixture",
      resolved: tarballUrl,
      version: "1.0.0",
    });
    let installCalled = false;
    try {
      expect(() =>
        materializeSourceGraph(
          sourcePackage,
          sourceLock,
          destination,
          "https://registry.npmjs.org",
          () => {
            installCalled = true;
          },
          {
            integrity: "sha512-another-value",
            label: "reviewed fixture package",
            packageSpec: "fixture-package@1.0.0",
            tarballUrl,
          },
        ),
      ).toThrow(
        "reviewed npm lock package does not match its approved registry identity: node_modules/fixture-package",
      );
      expect(installCalled).toBe(false);
      expect(fs.existsSync(destination)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects dev: true when root production dependencies reach the package (#8116)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-source-graph-dev-flag-"));
    const destination = path.join(root, "materialized");
    const { sourceLock, sourcePackage } = writeProductionSourceGraph(
      root,
      {
        dependencies: { "transitive-package": "1.0.0" },
        integrity: "sha512-fixture",
        resolved: "https://registry.npmjs.org/fixture-package/-/fixture-package-1.0.0.tgz",
        version: "1.0.0",
      },
      {
        "node_modules/transitive-package": {
          dev: true,
          integrity: "sha512-transitive",
          resolved: "https://registry.npmjs.org/transitive-package/-/transitive-package-1.0.0.tgz",
          version: "1.0.0",
        },
      },
    );
    let installCalled = false;
    try {
      expect(() =>
        materializeSourceGraph(
          sourcePackage,
          sourceLock,
          destination,
          "https://registry.npmjs.org",
          () => {
            installCalled = true;
          },
        ),
      ).toThrow(
        "reviewed npm lock marks a production dependency as dev: true: node_modules/transitive-package",
      );
      expect(installCalled).toBe(false);
      expect(fs.existsSync(destination)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects dev: true when a production peer dependency reaches the package (#8116)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-source-graph-peer-dev-"));
    const destination = path.join(root, "materialized");
    const { sourceLock, sourcePackage } = writeProductionSourceGraph(
      root,
      {
        integrity: "sha512-fixture",
        peerDependencies: { "peer-package": "1.0.0" },
        resolved: "https://registry.npmjs.org/fixture-package/-/fixture-package-1.0.0.tgz",
        version: "1.0.0",
      },
      {
        "node_modules/peer-package": {
          dev: true,
          integrity: "sha512-peer",
          resolved: "https://registry.npmjs.org/peer-package/-/peer-package-1.0.0.tgz",
          version: "1.0.0",
        },
      },
    );
    let installCalled = false;
    try {
      expect(() =>
        materializeSourceGraph(
          sourcePackage,
          sourceLock,
          destination,
          "https://registry.npmjs.org",
          () => {
            installCalled = true;
          },
        ),
      ).toThrow(
        "reviewed npm lock marks a production dependency as dev: true: node_modules/peer-package",
      );
      expect(installCalled).toBe(false);
      expect(fs.existsSync(destination)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires a dependency declared only in dependencies (#8116)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-source-graph-required-"));
    const destination = path.join(root, "materialized");
    const { sourceLock, sourcePackage } = writeProductionSourceGraph(root, {
      dependencies: { "shared-package": "1.0.0" },
      integrity: "sha512-fixture",
      resolved: "https://registry.npmjs.org/fixture-package/-/fixture-package-1.0.0.tgz",
      version: "1.0.0",
    });
    let installCalled = false;
    try {
      expect(() =>
        materializeSourceGraph(
          sourcePackage,
          sourceLock,
          destination,
          "https://registry.npmjs.org",
          () => {
            installCalled = true;
          },
        ),
      ).toThrow(
        "reviewed npm lock is missing a production dependency: node_modules/fixture-package: shared-package",
      );
      expect(installCalled).toBe(false);
      expect(fs.existsSync(destination)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets optionalDependencies override a duplicate dependencies entry (#8116)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-source-graph-optional-"));
    const destination = path.join(root, "materialized");
    const { sourceLock, sourcePackage } = writeProductionSourceGraph(root, {
      dependencies: { "shared-package": "1.0.0" },
      integrity: "sha512-fixture",
      optionalDependencies: { "shared-package": "1.0.0" },
      resolved: "https://registry.npmjs.org/fixture-package/-/fixture-package-1.0.0.tgz",
      version: "1.0.0",
    });
    try {
      expect(
        materializeSourceGraph(
          sourcePackage,
          sourceLock,
          destination,
          "https://registry.npmjs.org",
          (directory) => {
            const packageDirectory = path.join(directory, "node_modules", "fixture-package");
            fs.mkdirSync(packageDirectory, { recursive: true });
            fs.writeFileSync(
              path.join(packageDirectory, "package.json"),
              `${JSON.stringify({ name: "fixture-package", version: "1.0.0" }, null, 2)}\n`,
            );
          },
        ),
      ).toBe(destination);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows a missing optional production peer dependency (#8116)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-source-graph-peer-optional-"));
    const destination = path.join(root, "materialized");
    const { sourceLock, sourcePackage } = writeProductionSourceGraph(root, {
      integrity: "sha512-fixture",
      peerDependencies: { "peer-package": "1.0.0" },
      peerDependenciesMeta: { "peer-package": { optional: true } },
      resolved: "https://registry.npmjs.org/fixture-package/-/fixture-package-1.0.0.tgz",
      version: "1.0.0",
    });
    try {
      expect(
        materializeSourceGraph(
          sourcePackage,
          sourceLock,
          destination,
          "https://registry.npmjs.org",
          (directory) => {
            const packageDirectory = path.join(directory, "node_modules", "fixture-package");
            fs.mkdirSync(packageDirectory, { recursive: true });
            fs.writeFileSync(
              path.join(packageDirectory, "package.json"),
              `${JSON.stringify({ name: "fixture-package", version: "1.0.0" }, null, 2)}\n`,
            );
          },
        ),
      ).toBe(destination);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an unreviewed non-dev package that root production dependencies do not reach (#8116)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-source-graph-non-dev-"));
    const destination = path.join(root, "materialized");
    const { sourceLock, sourcePackage } = writeProductionSourceGraph(
      root,
      {
        integrity: "sha512-fixture",
        resolved: "https://registry.npmjs.org/fixture-package/-/fixture-package-1.0.0.tgz",
        version: "1.0.0",
      },
      {
        "node_modules/unreachable-package": {
          integrity: "sha512-unreachable",
          resolved: "https://example.com/unreachable-package-1.0.0.tgz",
          version: "1.0.0",
        },
      },
    );
    let installCalled = false;
    try {
      expect(() =>
        materializeSourceGraph(
          sourcePackage,
          sourceLock,
          destination,
          "https://registry.npmjs.org",
          () => {
            installCalled = true;
          },
        ),
      ).toThrow(
        "reviewed npm lock package must use the reviewed registry: node_modules/unreachable-package",
      );
      expect(installCalled).toBe(false);
      expect(fs.existsSync(destination)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("omits dev: true when root production dependencies do not reach the package (#8116)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-source-graph-dev-only-"));
    const destination = path.join(root, "materialized");
    const { sourceLock, sourcePackage } = writeProductionSourceGraph(
      root,
      {
        integrity: "sha512-fixture",
        resolved: "https://registry.npmjs.org/fixture-package/-/fixture-package-1.0.0.tgz",
        version: "1.0.0",
      },
      {
        "node_modules/unreachable-package": {
          dev: true,
          integrity: "sha512-unreachable",
          resolved: "https://example.com/unreachable-package-1.0.0.tgz",
          version: "1.0.0",
        },
      },
    );
    let installCalled = false;
    try {
      expect(
        materializeSourceGraph(
          sourcePackage,
          sourceLock,
          destination,
          "https://registry.npmjs.org",
          (directory) => {
            installCalled = true;
            const packageDirectory = path.join(directory, "node_modules", "fixture-package");
            fs.mkdirSync(packageDirectory, { recursive: true });
            fs.writeFileSync(
              path.join(packageDirectory, "package.json"),
              `${JSON.stringify({ name: "fixture-package", version: "1.0.0" }, null, 2)}\n`,
            );
          },
        ),
      ).toBe(destination);
      expect(installCalled).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects nested shrinkwrap before npm ci installs the root production graph (#8116)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-source-graph-shrinkwrap-"));
    const destination = path.join(root, "materialized");
    const { sourceLock, sourcePackage } = writeProductionSourceGraph(root, {
      hasShrinkwrap: true,
      integrity: "sha512-fixture",
      resolved: "https://registry.npmjs.org/fixture-package/-/fixture-package-1.0.0.tgz",
      version: "1.0.0",
    });
    let installCalled = false;
    try {
      expect(() =>
        materializeSourceGraph(
          sourcePackage,
          sourceLock,
          destination,
          "https://registry.npmjs.org",
          () => {
            installCalled = true;
          },
        ),
      ).toThrow(
        "reviewed npm lock package must not delegate to nested shrinkwrap: node_modules/fixture-package",
      );
      expect(installCalled).toBe(false);
      expect(fs.existsSync(destination)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an installed package identity that differs from the reviewed lock (#8116)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-source-graph-identity-"));
    const destination = path.join(root, "materialized");
    const { sourceLock, sourcePackage } = writeProductionSourceGraph(root, {
      integrity: "sha512-fixture",
      resolved: "https://registry.npmjs.org/fixture-package/-/fixture-package-1.0.0.tgz",
      version: "1.0.0",
    });
    try {
      expect(() =>
        materializeSourceGraph(
          sourcePackage,
          sourceLock,
          destination,
          "https://registry.npmjs.org",
          (directory) => {
            const packageDirectory = path.join(directory, "node_modules", "fixture-package");
            fs.mkdirSync(packageDirectory, { recursive: true });
            fs.writeFileSync(
              path.join(packageDirectory, "package.json"),
              `${JSON.stringify({ name: "fixture-package", version: "1.0.1" }, null, 2)}\n`,
            );
          },
        ),
      ).toThrow(
        "NemoClaw CLI locked production graph installed package identity mismatch at node_modules/fixture-package: expected fixture-package@1.0.0, found fixture-package@1.0.1",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an invalid installed-lock package record with a stable error (#8116)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-installed-lock-record-"));
    const lockfilePath = path.join(root, "package-lock.json");
    const lockSource = `${JSON.stringify(
      {
        lockfileVersion: 3,
        packages: { "": { name: "fixture", version: "1.0.0" }, "node_modules/fixture": null },
      },
      null,
      2,
    )}\n`;
    try {
      fs.writeFileSync(lockfilePath, lockSource);
      expect(() =>
        verifyInstalledNpmLock({
          expectedLockSha256: createHash("sha256").update(lockSource).digest("hex"),
          installRoot: root,
          label: "fixture lock",
          lockfilePath,
        }),
      ).toThrow("fixture lock has an invalid locked package record: node_modules/fixture");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("audits the NemoClaw production graph, verifies signatures, and rejects blocking advisories (#8116)", () => {
    const events: string[] = [];
    const blockedResult = {
      acceptedAdvisories: [],
      blockingThreshold: "high",
      exceptionPolicySha256: "fixture-policy",
      graph: "nemoclaw-cli",
      reported: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 },
      schemaVersion: 1,
      status: "blocked",
      unacceptedBlockingAdvisories: [
        {
          advisory: "GHSA-aaaa-bbbb-cccc",
          installedVersion: "1.0.0",
          package: "fixture-package",
          severity: "high",
        },
      ],
    } satisfies AuditPolicyResult;
    const result = auditMaterializedSourceGraph(
      {
        artifactDirectory: "/artifacts",
        directory: "/materialized",
        exceptionFile: "/exceptions.json",
        npmVersion: "10.9.4",
        packageSpec: "nemoclaw@0.0.0",
        threshold: "high",
      },
      {
        runAudit: (options) => {
          events.push("policy-audit");
          expect(options).toMatchObject({
            directory: "/materialized",
            exceptionFile: "/exceptions.json",
            graph: "nemoclaw-cli",
            provenance: {
              label: "NemoClaw CLI locked production graph",
              npmVersion: "10.9.4",
              packageSpecs: ["nemoclaw@0.0.0"],
            },
            reportFile: path.join("/artifacts", "source-graph.json"),
            resultFile: path.join("/artifacts", "source-graph-policy.json"),
            threshold: "high",
            throwOnBlock: false,
          });
          return blockedResult;
        },
        verifySignatures: (directory) => {
          events.push(`signatures:${directory}`);
        },
      },
    );

    expect(events).toEqual(["policy-audit", "signatures:/materialized"]);
    expect(() =>
      assertReviewedAuditReportsPass(
        [{ label: "NemoClaw CLI locked production graph", result }],
        "high",
      ),
    ).toThrow(
      "reviewed npm audit threshold failed\nNemoClaw CLI locked production graph: 1 unaccepted at or above high",
    );
  });

  it("normalizes only the reviewed OpenClaw npm alias for registry signature verification", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-signature-alias-"));
    const aliasPath = path.join("node_modules", "openclaw", "node_modules", "node-domexception");
    const actualPath = path.join(
      "node_modules",
      "openclaw",
      "node_modules",
      "@nolyfill",
      "domexception",
    );
    const requesterPath = path.join("node_modules", "openclaw", "node_modules", "fetch-blob");
    const aliasManifest = { name: "@nolyfill/domexception", version: "1.0.28" };
    const requesterManifest = {
      name: "fetch-blob",
      version: "3.2.0",
      dependencies: { "node-domexception": "^1.0.0" },
    };
    const lock = {
      lockfileVersion: 3,
      packages: {
        [aliasPath]: {
          ...aliasManifest,
          resolved: "https://registry.npmjs.org/@nolyfill/domexception/-/domexception-1.0.28.tgz",
          integrity: DOMEXCEPTION_INTEGRITY,
        },
        [requesterPath]: requesterManifest,
      },
    };
    try {
      for (const [directory, manifest] of [
        [aliasPath, aliasManifest],
        [requesterPath, requesterManifest],
      ] as const) {
        fs.mkdirSync(path.join(root, directory), { recursive: true });
        fs.writeFileSync(
          path.join(root, directory, "package.json"),
          `${JSON.stringify(manifest)}\n`,
        );
      }

      fs.writeFileSync(path.join(root, "package-lock.json"), `${JSON.stringify(lock)}\n`);

      normalizeOpenClawSignatureAlias(root);

      const normalizedLock = JSON.parse(
        fs.readFileSync(path.join(root, "package-lock.json"), "utf-8"),
      );
      const normalizedRequester = createRequire(import.meta.url)(
        path.join(root, requesterPath, "package.json"),
      );
      expect(fs.existsSync(path.join(root, aliasPath))).toBe(false);
      expect(fs.existsSync(path.join(root, actualPath, "package.json"))).toBe(true);
      expect(normalizedLock.packages[aliasPath]).toBeUndefined();
      expect(normalizedLock.packages[actualPath]).toMatchObject(aliasManifest);
      expect(normalizedLock.packages[requesterPath].dependencies).toEqual({
        "@nolyfill/domexception": "1.0.28",
      });
      expect(normalizedRequester.dependencies).toEqual({
        "@nolyfill/domexception": "1.0.28",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
