// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
const REVIEWED_NPM_BOOTSTRAP_COMMAND = REVIEWED_NPM_ACTION.runs?.steps?.find(
  (step) => step.name === "Download and verify production npm",
)?.run;

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
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewed-audit-bootstrap-handoff-"));
  const bin = path.join(root, "bin");
  const archive = Buffer.from("verified archive\n");
  const archiveFile = path.join(root, "fixture.tgz");
  const installMarker = path.join(root, "install-called");
  const npmLog = path.join(root, "npm.log");
  stageSparseCheckout(root, sparseCheckout);
  mutateCheckout(root);
  fs.mkdirSync(bin);
  fs.writeFileSync(archiveFile, archive);
  fs.writeFileSync(
    path.join(root, "ci", "reviewed-npm-audit.json"),
    `${JSON.stringify({
      npmArchiveSha256: createHash("sha256").update(archive).digest("hex"),
      npmIntegrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
      npmVersion: "12.0.2",
    })}\n`,
  );
  fs.writeFileSync(
    path.join(bin, "npm"),
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
    cp "$NEMOCLAW_TEST_ARCHIVE_FILE" "$download_dir/npm-12.0.2.tgz"
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
  const result = spawnSync("bash", ["-c", REVIEWED_NPM_BOOTSTRAP_COMMAND ?? "exit 99"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_ACTION_PATH: path.join(root, ".github", "actions", "ci-reviewed-npm-audit"),
      NEMOCLAW_TEST_ARCHIVE_FILE: archiveFile,
      NEMOCLAW_TEST_INSTALL_MARKER: installMarker,
      NEMOCLAW_TEST_NPM_LOG: npmLog,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      RUNNER_TEMP: root,
    },
  });
  return {
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    installCalled: fs.existsSync(installMarker),
    npmInvocations: fs.existsSync(npmLog) ? fs.readFileSync(npmLog, "utf8").trim().split("\n") : [],
    result,
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
            "--experimental-strip-types",
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
    "executes the reviewed npm bootstrap from the $name trusted sparse checkout",
    ({ sparseCheckout }) => {
      const fixture = runTrustedBootstrapHandoff(sparseCheckout);
      try {
        expect(fixture.result.status, fixture.result.stderr).toBe(0);
        expect(fixture.installCalled).toBe(true);
        expect(fixture.npmInvocations).toHaveLength(2);
        expect(fixture.npmInvocations[1]).toMatch(/install --global .* --offline$/u);
      } finally {
        fixture.cleanup();
      }
    },
  );

  it("fails before installation when the trusted checkout omits the reviewed npm bootstrap", () => {
    const fixture = runTrustedBootstrapHandoff(
      TRUSTED_AUDIT_ACTION_CHECKOUTS[0]?.sparseCheckout ?? "",
      (root) =>
        fs.rmSync(path.join(root, ".github", "actions", "setup-reviewed-npm"), {
          recursive: true,
          force: true,
        }),
    );
    try {
      expect(fixture.result.status).not.toBe(0);
      expect(fixture.installCalled).toBe(false);
      expect(fixture.npmInvocations).toEqual([]);
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
        npmVersion: "10.9.4",
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
        "--experimental-strip-types",
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
      expect(rejected.stderr).toContain("receipt identity does not match expected graph and npm");
      expect(fs.existsSync(resultFile)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
