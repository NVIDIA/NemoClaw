// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { emitAuditReceipt } from "../../../scripts/audit-reviewed-npm-graph.mts";

const REPO_ROOT = path.join(import.meta.dirname, "../../..");
const TRUSTED_WORKFLOWS = [
  "e2e.yaml",
  "managed-images.yaml",
  "openshell-sdk-package-pr.yaml",
  "pr.yaml",
];

type Workflow = {
  readonly jobs?: Readonly<
    Record<
      string,
      {
        readonly steps?: readonly {
          readonly with?: Readonly<Record<string, unknown>>;
        }[];
      }
    >
  >;
};

type CompositeAction = {
  readonly runs?: {
    readonly steps?: readonly {
      readonly name?: string;
      readonly run?: string;
    }[];
  };
};

const TRUSTED_AUDIT_SPARSE_CHECKOUTS = TRUSTED_WORKFLOWS.flatMap((workflowFile) => {
  const workflow = YAML.parse(
    fs.readFileSync(path.join(REPO_ROOT, ".github", "workflows", workflowFile), "utf8"),
  ) as Workflow;
  return Object.values(workflow.jobs ?? {}).flatMap((job, jobIndex) =>
    (job.steps ?? [])
      .map((step) => step.with?.["sparse-checkout"])
      .filter(
        (sparseCheckout): sparseCheckout is string =>
          typeof sparseCheckout === "string" &&
          sparseCheckout.includes("scripts/audit-reviewed-npm-graph.mts"),
      )
      .map((sparseCheckout, checkoutIndex) => ({
        name: `${workflowFile}-${jobIndex}-${checkoutIndex}`,
        sparseCheckout,
      })),
  );
});
const TRUSTED_AUDIT_ACTION_CHECKOUTS = TRUSTED_AUDIT_SPARSE_CHECKOUTS.filter(({ sparseCheckout }) =>
  sparseCheckout.includes(".github/actions/ci-reviewed-npm-audit"),
);
const REVIEWED_NPM_ACTION = YAML.parse(
  fs.readFileSync(
    path.join(REPO_ROOT, ".github", "actions", "ci-reviewed-npm-audit", "action.yaml"),
    "utf8",
  ),
) as CompositeAction;
const reviewedNpmBootstrapCommand = REVIEWED_NPM_ACTION.runs?.steps?.find(
  (step) => step.name === "Download and verify production npm",
)?.run;
const reviewedNpmAuditCommand = REVIEWED_NPM_ACTION.runs?.steps?.find(
  (step) => step.name === "Materialize and audit production dependency graphs",
)?.run;
const FIRST_TRUSTED_AUDIT_ACTION_CHECKOUT = TRUSTED_AUDIT_ACTION_CHECKOUTS[0];
assert.ok(
  FIRST_TRUSTED_AUDIT_ACTION_CHECKOUT,
  "No trusted audit checkout includes the npm audit action",
);
const REVIEWED_NPM_BOOTSTRAP_COMMAND =
  typeof reviewedNpmBootstrapCommand === "string"
    ? reviewedNpmBootstrapCommand
    : assert.fail("The npm audit action does not define the production npm bootstrap command");
const REVIEWED_NPM_AUDIT_COMMAND =
  typeof reviewedNpmAuditCommand === "string"
    ? reviewedNpmAuditCommand
    : assert.fail("The npm audit action does not define the production npm audit command");

function stageSparseCheckout(root: string, sparseCheckout: string): void {
  sparseCheckout
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const destination = path.join(root, entry);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.cpSync(path.join(REPO_ROOT, entry), destination, { recursive: true });
    });
}

function runTrustedBootstrapHandoff(
  sparseCheckout: string,
  mutateCheckout: (root: string) => void = () => {},
  activateInstalledNpm = true,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewed-audit-bootstrap-handoff-"));
  const bin = path.join(root, "bin");
  const installedBin = path.join(root, "installed-bin");
  const activeNpm = path.join(bin, "npm");
  const bootstrapNpm = path.join(root, "bootstrap-npm");
  const installedNpm = path.join(installedBin, "npm");
  const archive = Buffer.from("verified archive\n");
  const archiveFile = path.join(root, "fixture.tgz");
  const installMarker = path.join(root, "install-called");
  const npmLog = path.join(root, "npm.log");
  const reportDirectory = path.join(root, "artifacts", "reviewed-npm-audit");
  stageSparseCheckout(root, sparseCheckout);
  mutateCheckout(root);
  fs.mkdirSync(bin);
  fs.mkdirSync(installedBin);
  fs.writeFileSync(archiveFile, archive);
  fs.writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "reviewed-npm-handoff-fixture", version: "1.0.0" })}\n`,
  );
  fs.writeFileSync(
    path.join(root, "package-lock.json"),
    `${JSON.stringify({
      lockfileVersion: 3,
      name: "reviewed-npm-handoff-fixture",
      packages: { "": { name: "reviewed-npm-handoff-fixture", version: "1.0.0" } },
      requires: true,
      version: "1.0.0",
    })}\n`,
  );
  fs.writeFileSync(
    path.join(root, "ci", "reviewed-npm-audit.json"),
    `${JSON.stringify({
      archiveGraphId: "reviewed-archive-graph",
      archivePackages: [],
      archiveTarVersion: "7.5.21",
      artifactDirectory: "artifacts/reviewed-npm-audit",
      exceptionFile: "ci/npm-audit-exceptions.json",
      lockedGraphs: [],
      nodeVersion: process.version.slice(1),
      npmArchiveSha256: createHash("sha256").update(archive).digest("hex"),
      npmIntegrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
      npmVersion: "12.0.2",
      registryOrigin: "https://registry.npmjs.org",
      schemaVersion: 2,
      severityThreshold: "high",
      sourceNestedShrinkwrapPackages: [],
      sourceRegistryPackage: {
        artifactName: "unused-1.0.0.tgz",
        integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
        label: "unused fixture package",
        packageSpec: "unused@1.0.0",
        tarballUrl: "https://registry.npmjs.org/unused/-/unused-1.0.0.tgz",
      },
      sourceRegistryPackagesWithoutIntegrity: [],
    })}\n`,
  );
  fs.writeFileSync(
    activeNpm,
    `#!/usr/bin/env bash
set -euo pipefail
printf 'bootstrap:%s\\n' "$*" >> "$NEMOCLAW_TEST_NPM_LOG"
case "$1" in
  --version)
    printf '9.9.9\\n'
    ;;
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
    cp "$NEMOCLAW_TEST_ARCHIVE_FILE" "$download_dir/npm-12.0.2.tgz"
    ;;
  install)
    [ "\${2:-}" = "--global" ]
    : > "$NEMOCLAW_TEST_INSTALL_MARKER"
    if [ "$NEMOCLAW_TEST_ACTIVATE_INSTALLED_NPM" = "true" ]; then
      mv "$NEMOCLAW_TEST_ACTIVE_NPM" "$NEMOCLAW_TEST_BOOTSTRAP_NPM"
      ln -s "$NEMOCLAW_TEST_INSTALLED_NPM" "$NEMOCLAW_TEST_ACTIVE_NPM"
    fi
    ;;
  *)
    exit 2
    ;;
esac
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    installedNpm,
    `#!/usr/bin/env bash
set -euo pipefail
printf 'installed:%s\\n' "$*" >> "$NEMOCLAW_TEST_NPM_LOG"
case "$1" in
  --version)
    printf '12.0.2\\n'
    ;;
  install)
    printf '%s\\n' '{"name":"nemoclaw-reviewed-production-graph","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"nemoclaw-reviewed-production-graph","version":"1.0.0"}}}' > package-lock.json
    ;;
  ci)
    ;;
  audit)
    if [ "\${2:-}" != "signatures" ]; then
      printf '%s\\n' '{"vulnerabilities":{},"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":0,"critical":0}}}'
    fi
    ;;
  *)
    exit 2
    ;;
esac
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "tar"),
    `#!/usr/bin/env bash
set -euo pipefail
[ "$1" = "-xOf" ]
[ "$3" = "package/package.json" ]
printf '{"version":"12.0.2"}\\n'
`,
    { mode: 0o755 },
  );
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GITHUB_ACTION_PATH: path.join(root, ".github", "actions", "ci-reviewed-npm-audit"),
    NEMOCLAW_REVIEWED_NPM_AUDIT_REPORT_DIR: path.relative(root, reportDirectory),
    NEMOCLAW_REVIEWED_NPM_AUDIT_TARGET_ROOT: root,
    NEMOCLAW_TEST_ACTIVE_NPM: activeNpm,
    NEMOCLAW_TEST_ACTIVATE_INSTALLED_NPM: String(activateInstalledNpm),
    NEMOCLAW_TEST_ARCHIVE_FILE: archiveFile,
    NEMOCLAW_TEST_BOOTSTRAP_NPM: bootstrapNpm,
    NEMOCLAW_TEST_INSTALLED_NPM: installedNpm,
    NEMOCLAW_TEST_INSTALL_MARKER: installMarker,
    NEMOCLAW_TEST_NPM_LOG: npmLog,
    NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
    NPM_CONFIG_USERCONFIG: "/dev/null",
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    RUNNER_TEMP: root,
  };
  delete environment.NEMOCLAW_NPM_AUDIT_CACHE_FILE;
  delete environment.NEMOCLAW_REVIEWED_NPM_AUDIT_CACHE_DIR;
  const bootstrapResult = spawnSync("bash", ["-c", REVIEWED_NPM_BOOTSTRAP_COMMAND], {
    cwd: root,
    encoding: "utf8",
    env: environment,
  });
  const auditResult =
    bootstrapResult.status === 0
      ? spawnSync("bash", ["-c", REVIEWED_NPM_AUDIT_COMMAND], {
          cwd: root,
          encoding: "utf8",
          env: environment,
        })
      : undefined;
  return {
    auditResult,
    bootstrapResult,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    installCalled: fs.existsSync(installMarker),
    npmInvocations: fs.existsSync(npmLog) ? fs.readFileSync(npmLog, "utf8").trim().split("\n") : [],
    reportFiles: fs.existsSync(reportDirectory) ? fs.readdirSync(reportDirectory) : [],
  };
}

describe("npm audit handoff", () => {
  it.each(TRUSTED_AUDIT_SPARSE_CHECKOUTS)(
    "loads the audit producer from the $name trusted sparse checkout",
    ({ sparseCheckout }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewed-audit-sparse-checkout-"));
      try {
        stageSparseCheckout(root, sparseCheckout);
        const auditProducer = path.join(root, "scripts", "audit-reviewed-npm-graph.mts");
        const result = spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "--eval",
            "await import(process.argv[1])",
            pathToFileURL(auditProducer).href,
          ],
          { encoding: "utf8" },
        );

        expect(result.status, result.stderr).toBe(0);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each(TRUSTED_AUDIT_ACTION_CHECKOUTS)(
    "installs and audits with the reviewed npm from the $name trusted sparse checkout",
    ({ sparseCheckout }) => {
      const fixture = runTrustedBootstrapHandoff(sparseCheckout);
      try {
        expect(fixture.bootstrapResult.status, fixture.bootstrapResult.stderr).toBe(0);
        expect(fixture.auditResult?.status, fixture.auditResult?.stderr).toBe(0);
        expect(fixture.installCalled).toBe(true);
        expect(fixture.npmInvocations[0]).toMatch(/^bootstrap:pack npm@12\.0\.2 /u);
        expect(fixture.npmInvocations[1]).toMatch(/^bootstrap:install --global .* --offline$/u);
        expect(
          fixture.npmInvocations.slice(2).every((entry) => entry.startsWith("installed:")),
        ).toBe(true);
        expect(fixture.npmInvocations).toContain("installed:--version");
        expect(
          fixture.npmInvocations.some((entry) => /^installed:audit .*--json$/u.test(entry)),
        ).toBe(true);
        expect(
          fixture.npmInvocations.some((entry) => /^installed:audit signatures /u.test(entry)),
        ).toBe(true);
        expect(fixture.reportFiles).toContain("nemoclaw-cli.receipt.json");
        expect(fixture.reportFiles).toContain("reviewed-archive-graph.receipt.json");
      } finally {
        fixture.cleanup();
      }
    },
  );

  it("fails before installation when the trusted checkout omits the reviewed npm bootstrap", () => {
    const fixture = runTrustedBootstrapHandoff(
      FIRST_TRUSTED_AUDIT_ACTION_CHECKOUT.sparseCheckout,
      (root) =>
        fs.rmSync(
          path.join(
            root,
            ".github",
            "actions",
            "ci-reviewed-npm-audit",
            "verify-and-install-npm.sh",
          ),
          { force: true },
        ),
    );
    try {
      expect(fixture.bootstrapResult.status).not.toBe(0);
      expect(fixture.auditResult).toBeUndefined();
      expect(fixture.installCalled).toBe(false);
      expect(fixture.npmInvocations).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects the audit before accepting results when installation leaves an older npm selected (#8253)", () => {
    const fixture = runTrustedBootstrapHandoff(
      FIRST_TRUSTED_AUDIT_ACTION_CHECKOUT.sparseCheckout,
      () => {},
      false,
    );
    try {
      expect(fixture.bootstrapResult.status, fixture.bootstrapResult.stderr).toBe(0);
      expect(fixture.auditResult?.status).toBe(1);
      expect(fixture.auditResult?.stderr).toContain(
        "npm audit requires npm 12.0.2; running npm 9.9.9",
      );
      expect(fixture.npmInvocations).toContain("bootstrap:--version");
      expect(fixture.npmInvocations.some((entry) => entry.startsWith("installed:"))).toBe(false);
      expect(fixture.reportFiles).not.toContain("nemoclaw-cli.receipt.json");
      expect(fixture.reportFiles).not.toContain("source-graph-policy.json");
    } finally {
      fixture.cleanup();
    }
  });

  it("passes producer output to the Docker receipt verifier and rejects an npm mismatch", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewed-audit-receipt-handoff-"));
    const packageJsonFile = path.join(root, "package.json");
    const packageLockFile = path.join(root, "package-lock.json");
    const rawReportFile = path.join(root, "report.json");
    const exceptionFile = path.join(root, "exceptions.json");
    const auditConfigFile = path.join(root, "reviewed-npm-audit.json");
    const resultFile = path.join(root, "policy.json");
    const packageJson = Buffer.from("temporary manifest\n");
    const packageLock = Buffer.from("temporary lock\n");
    const exceptionPolicy = '{"schemaVersion":1,"exceptions":[]}\n';
    const rawReport =
      '{"vulnerabilities":{},"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":0,"critical":0}}}\n';
    try {
      fs.writeFileSync(packageJsonFile, packageJson);
      fs.writeFileSync(packageLockFile, packageLock);
      fs.writeFileSync(rawReportFile, rawReport);
      fs.writeFileSync(exceptionFile, exceptionPolicy);
      fs.writeFileSync(
        auditConfigFile,
        JSON.stringify({
          npmArchiveSha256: "0".repeat(64),
          npmIntegrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
          npmVersion: "10.9.4",
        }),
      );
      fs.writeFileSync(
        path.join(root, "report.provenance.json"),
        JSON.stringify({ run: { startedAt: new Date().toISOString() } }),
      );
      const receiptFile = emitAuditReceipt({
        artifactDirectory: root,
        graphId: "temporary-graph",
        reviewedNpmIdentity: {
          npmArchiveSha256: "0".repeat(64),
          npmIntegrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
          npmVersion: "10.9.4",
        },
        packageJsonFile,
        packageLockFile,
        preserveInputs: true,
        rawReportFile,
        registryOrigin: "https://registry.yarnpkg.com",
        result: {
          acceptedAdvisories: [],
          blockingThreshold: "high",
          exceptionPolicySha256: createHash("sha256").update(exceptionPolicy).digest("hex"),
          graph: "temporary-graph",
          reported: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
          schemaVersion: 1,
          status: "clean",
          unacceptedBlockingAdvisories: [],
        },
        threshold: "high",
      });

      const retainedPackageJson = path.join(root, "temporary-graph.package.json");
      const retainedPackageLock = path.join(root, "temporary-graph.package-lock.json");
      const transportRawReport = path.join(root, "temporary-graph.raw.json");
      const verifierArgs = [
        path.join(REPO_ROOT, "scripts", "lib", "npm-audit-receipt.mts"),
        "--receipt",
        receiptFile,
        "--package-json",
        retainedPackageJson,
        "--package-lock",
        retainedPackageLock,
        "--raw-report",
        transportRawReport,
        "--exceptions",
        exceptionFile,
        "--graph",
        "temporary-graph",
        "--audit-config",
        auditConfigFile,
        "--registry",
        "https://registry.yarnpkg.com",
        "--threshold",
        "high",
        "--result",
        resultFile,
      ];
      const accepted = spawnSync(process.execPath, verifierArgs, { encoding: "utf8" });
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(fs.readFileSync(retainedPackageJson)).toEqual(packageJson);
      expect(fs.readFileSync(retainedPackageLock)).toEqual(packageLock);
      expect(fs.readFileSync(transportRawReport, "utf8")).toBe(rawReport);
      expect(JSON.parse(fs.readFileSync(resultFile, "utf8"))).toMatchObject({
        graph: "temporary-graph",
        status: "clean",
      });

      fs.rmSync(resultFile);
      fs.writeFileSync(
        auditConfigFile,
        JSON.stringify({
          npmArchiveSha256: "0".repeat(64),
          npmIntegrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
          npmVersion: "11.18.0",
        }),
      );
      const rejected = spawnSync(process.execPath, verifierArgs, { encoding: "utf8" });
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain(
        "receipt identity does not match expected graph and reviewed npm",
      );
      expect(fs.existsSync(resultFile)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
