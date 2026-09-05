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
  readonly on?: {
    readonly pull_request?: { readonly paths?: readonly string[] };
    readonly push?: { readonly paths?: readonly string[] };
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
const TRUSTED_AUDIT_ACTION_SPARSE_CHECKOUTS = TRUSTED_AUDIT_SPARSE_CHECKOUTS.filter(
  ({ sparseCheckout }) => sparseCheckout.includes(".github/actions/ci-reviewed-npm-audit"),
);

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
  // source-shape-contract: security -- Image workflows must treat the shared reviewed npm bootstrap as a trigger so verifier drift cannot bypass qualification or publication
  it("routes bootstrap-only changes through image qualification and publication", () => {
    const bootstrapGlob = ".github/actions/setup-reviewed-npm/**";
    const managedImages = YAML.parse(
      fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/managed-images.yaml"), "utf8"),
    ) as Workflow;
    const baseImages = YAML.parse(
      fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/base-image.yaml"), "utf8"),
    ) as Workflow;

    expect(managedImages.on?.pull_request?.paths).toContain(bootstrapGlob);
    expect(baseImages.on?.push?.paths).toContain(bootstrapGlob);
  });

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

  it.each(TRUSTED_AUDIT_ACTION_SPARSE_CHECKOUTS)(
    "loads the audit bootstrap from the $name trusted sparse checkout",
    ({ sparseCheckout }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewed-audit-action-checkout-"));
      try {
        expect(sparseCheckout.split("\n").map((entry) => entry.trim())).toContain(
          ".github/actions/setup-reviewed-npm",
        );
        stageSparseCheckout(root, sparseCheckout);
        expect(
          fs
            .statSync(
              path.join(root, ".github/actions/setup-reviewed-npm/verify-and-install-npm.sh"),
            )
            .isFile(),
        ).toBe(true);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

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
