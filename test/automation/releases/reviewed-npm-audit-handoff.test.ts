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

describe("reviewed npm audit handoff", () => {
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

  it("passes producer output through the protected audit helper and rejects a forged report", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewed-audit-receipt-handoff-"));
    const packageJsonFile = path.join(root, "package.json");
    const packageLockFile = path.join(root, "package-lock.json");
    const rawReportFile = path.join(root, "report.json");
    const runtime = path.join(REPO_ROOT, "agents/openclaw/mcporter-runtime");
    const exceptionFile = path.join(REPO_ROOT, "ci/npm-audit-exceptions.json");
    const auditConfigFile = path.join(REPO_ROOT, "ci/reviewed-npm-audit.json");
    const packageJson = fs.readFileSync(path.join(runtime, "package.json"));
    const packageLock = fs.readFileSync(path.join(runtime, "package-lock.json"));
    const exceptionPolicy = fs.readFileSync(exceptionFile, "utf8");
    const npmVersion = JSON.parse(fs.readFileSync(auditConfigFile, "utf8")).npmVersion as string;
    const rawReport =
      '{"vulnerabilities":{},"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":0,"critical":0}}}\n';
    try {
      fs.writeFileSync(packageJsonFile, packageJson);
      fs.writeFileSync(packageLockFile, packageLock);
      fs.writeFileSync(rawReportFile, rawReport);
      fs.writeFileSync(
        path.join(root, "report.provenance.json"),
        JSON.stringify({ run: { startedAt: new Date().toISOString() } }),
      );
      const receiptFile = emitAuditReceipt({
        artifactDirectory: root,
        graphId: "mcporter-runtime",
        npmVersion,
        packageJsonFile,
        packageLockFile,
        preserveInputs: true,
        rawReportFile,
        registryOrigin: "https://registry.yarnpkg.com",
        result: {
          acceptedAdvisories: [],
          blockingThreshold: "high",
          exceptionPolicySha256: createHash("sha256").update(exceptionPolicy).digest("hex"),
          graph: "mcporter-runtime",
          reported: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
          schemaVersion: 1,
          status: "clean",
          unacceptedBlockingAdvisories: [],
        },
        threshold: "high",
      });

      const retainedPackageJson = path.join(root, "mcporter-runtime.package.json");
      const retainedPackageLock = path.join(root, "mcporter-runtime.package-lock.json");
      const transportRawReport = path.join(root, "mcporter-runtime.raw.json");
      const receiptVerifier = path.join(REPO_ROOT, "scripts", "lib", "npm-audit-receipt.mts");
      const verifierArgs = [
        "--experimental-strip-types",
        receiptVerifier,
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
        "mcporter-runtime",
        "--audit-config",
        auditConfigFile,
        "--registry",
        "https://registry.yarnpkg.com",
        "--threshold",
        "high",
        "--legacy-npmjs",
        "true",
      ];
      const nodeLog = path.join(root, "node.log");
      const stubBin = path.join(root, "bin");
      const helper = path.join(root, "verify-mcporter-audit.sh");
      fs.mkdirSync(stubBin);
      fs.writeFileSync(
        path.join(stubBin, "node"),
        '#!/usr/bin/env bash\nset -euo pipefail\nprintf \'%s\\n\' "$*" >>"$NEMOCLAW_TEST_NODE_LOG"\nexec "$NEMOCLAW_TEST_REAL_NODE" "$@"\n',
        { mode: 0o755 },
      );
      let helperSource = fs.readFileSync(
        path.join(REPO_ROOT, "scripts/lib/verify-mcporter-audit.sh"),
        "utf8",
      );
      for (const [source, staged] of [
        ["/run/secrets/nemoclaw-mcporter-audit-receipt", receiptFile],
        ["/run/secrets/nemoclaw-mcporter-audit-raw-report", transportRawReport],
        ["/run/nemoclaw-mcporter-audit-cache/reviewed-npm-audit", path.join(root, "no-seed")],
        ["/scripts/lib/npm-audit-receipt.mts", receiptVerifier],
        ["/usr/local/lib/nemoclaw/mcporter-runtime/package.json", retainedPackageJson],
        ["/usr/local/lib/nemoclaw/mcporter-runtime/package-lock.json", retainedPackageLock],
        ["/scripts/npm-audit-exceptions.json", exceptionFile],
        ["/scripts/reviewed-npm-audit.json", auditConfigFile],
      ] as const) {
        helperSource = helperSource.replaceAll(source, staged);
      }
      fs.writeFileSync(helper, helperSource, { mode: 0o755 });
      const runHelper = () =>
        spawnSync("bash", [helper], {
          encoding: "utf8",
          env: {
            ...process.env,
            NEMOCLAW_MCPORTER_AUDIT_RECEIPT_SHA256: createHash("sha256")
              .update(fs.readFileSync(receiptFile))
              .digest("hex"),
            NEMOCLAW_TEST_NODE_LOG: nodeLog,
            NEMOCLAW_TEST_REAL_NODE: process.execPath,
            PATH: `${stubBin}:${process.env.PATH ?? ""}`,
          },
        });

      fs.writeFileSync(transportRawReport, "{}\n");
      const rejected = runHelper();
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain("receipt rawResponseSha256 does not match");

      fs.writeFileSync(transportRawReport, rawReport);
      const accepted = runHelper();
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(fs.readFileSync(retainedPackageJson)).toEqual(packageJson);
      expect(fs.readFileSync(retainedPackageLock)).toEqual(packageLock);
      expect(fs.readFileSync(transportRawReport, "utf8")).toBe(rawReport);
      expect(fs.readFileSync(nodeLog, "utf8").trim().split("\n").at(-1)).toBe(
        verifierArgs.join(" "),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
