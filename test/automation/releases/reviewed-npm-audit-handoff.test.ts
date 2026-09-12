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
import { prepareReviewedNpmBootstrap } from "../../support/reviewed-npm-bootstrap";

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
          readonly name?: string;
          readonly run?: string;
          readonly uses?: string;
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
const REVIEWED_NPM_BOOTSTRAP_COMMAND =
  typeof reviewedNpmBootstrapCommand === "string"
    ? reviewedNpmBootstrapCommand
    : assert.fail("The npm audit action does not define the production npm bootstrap command");

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
    "runs the reviewed npm bootstrap from the $name trusted sparse checkout (#8253)",
    ({ sparseCheckout }) => {
      const fixture = prepareReviewedNpmBootstrap({
        command: REVIEWED_NPM_BOOTSTRAP_COMMAND,
        configFile: (root) => path.join(root, "ci", "reviewed-npm-audit.json"),
        environment: (root) => ({
          GITHUB_ACTION_PATH: path.join(root, ".github", "actions", "ci-reviewed-npm-audit"),
        }),
        prepare: (root) => stageSparseCheckout(root, sparseCheckout),
      });
      const result = spawnSync("bash", fixture.args, fixture.spawnOptions);
      try {
        expect(result.status, result.stderr).toBe(0);
      } finally {
        fixture.cleanup();
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

  it("keeps protected audit acceptance under trusted policy and rejects forged transport", () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "reviewed-audit-receipt-handoff-")),
    );
    const trustedRoot = path.join(root, "trusted");
    const targetRoot = path.join(root, "target");
    const runtime = path.join(targetRoot, "agents/openclaw/mcporter-runtime");
    const artifactDirectory = path.join(targetRoot, "artifacts/reviewed-npm-audit");
    const exceptionFile = path.join(trustedRoot, "ci/npm-audit-exceptions.json");
    const auditConfigFile = path.join(trustedRoot, "ci/reviewed-npm-audit.json");
    const auditConfig = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "ci/reviewed-npm-audit.json"), "utf8"),
    );
    const reviewedNpmIdentity = {
      npmArchiveSha256: auditConfig.npmArchiveSha256 as string,
      npmIntegrity: auditConfig.npmIntegrity as string,
      npmVersion: auditConfig.npmVersion as string,
    };
    const acceptedAdvisory = "GHSA-aaaa-bbbb-cccc";
    const rawReport = `${JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {
        "vulnerable-package": {
          effects: [],
          isDirect: true,
          name: "vulnerable-package",
          nodes: ["node_modules/vulnerable-package"],
          severity: "high",
          via: [
            {
              dependency: "vulnerable-package",
              name: "vulnerable-package",
              range: "<=1.0.0",
              severity: "high",
              source: 123456,
              title: "test advisory",
              url: `https://github.com/advisories/${acceptedAdvisory}`,
            },
          ],
        },
      },
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 },
      },
    })}\n`;
    try {
      fs.mkdirSync(runtime, { recursive: true });
      fs.mkdirSync(path.join(trustedRoot, "ci"), { recursive: true });
      fs.cpSync(path.join(REPO_ROOT, "scripts"), path.join(trustedRoot, "scripts"), {
        recursive: true,
      });
      fs.cpSync(path.join(REPO_ROOT, "agents/openclaw/mcporter-runtime"), runtime, {
        recursive: true,
      });
      fs.mkdirSync(path.join(runtime, "node_modules", "vulnerable-package"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(runtime, "node_modules", "vulnerable-package", "package.json"),
        '{"name":"vulnerable-package","version":"1.0.0"}\n',
      );
      fs.mkdirSync(path.join(targetRoot, "ci"), { recursive: true });
      fs.mkdirSync(path.join(targetRoot, "scripts", "lib"), { recursive: true });
      fs.writeFileSync(path.join(targetRoot, "ci", "reviewed-npm-audit.json"), "{}\n");
      fs.writeFileSync(
        path.join(targetRoot, "ci", "npm-audit-exceptions.json"),
        '{"schemaVersion":1,"exceptions":[]}\n',
      );
      fs.writeFileSync(
        path.join(targetRoot, "scripts", "audit-reviewed-npm-graph.mts"),
        "throw new Error('candidate producer executed');\n",
      );
      fs.writeFileSync(
        path.join(targetRoot, "scripts", "lib", "npm-audit-receipt.mts"),
        "throw new Error('candidate verifier executed');\n",
      );
      fs.writeFileSync(
        exceptionFile,
        `${JSON.stringify({
          schemaVersion: 1,
          exceptions: [
            {
              advisory: acceptedAdvisory,
              compensatingControls: ["The vulnerable input is rejected before use."],
              decision: "temporary-risk-acceptance",
              expires: "2026-09-16",
              graph: "mcporter-runtime",
              installedVersion: "1.0.0",
              owner: "security-maintainers",
              package: "vulnerable-package",
              rationale: "The fix is in validation.",
              severity: "high",
              trackingIssue: "https://github.com/NVIDIA/NemoClaw/issues/11088",
            },
          ],
        })}\n`,
      );
      fs.copyFileSync(path.join(REPO_ROOT, "ci/reviewed-npm-audit.json"), auditConfigFile);
      fs.mkdirSync(artifactDirectory, { recursive: true });
      const rawReportFile = path.join(artifactDirectory, "audit.json");
      fs.writeFileSync(rawReportFile, rawReport);
      fs.writeFileSync(
        path.join(artifactDirectory, "audit.provenance.json"),
        JSON.stringify({ run: { startedAt: new Date().toISOString() } }),
      );
      emitAuditReceipt({
        artifactDirectory,
        graphId: "mcporter-runtime",
        packageJsonFile: path.join(runtime, "package.json"),
        packageLockFile: path.join(runtime, "package-lock.json"),
        rawReportFile,
        registryOrigin: "https://registry.yarnpkg.com",
        reviewedNpmIdentity,
        result: {
          acceptedAdvisories: [acceptedAdvisory],
          blockingThreshold: "high",
          exceptionPolicySha256: createHash("sha256")
            .update(fs.readFileSync(exceptionFile))
            .digest("hex"),
          graph: "mcporter-runtime",
          reported: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 },
          schemaVersion: 1,
          status: "accepted-exceptions",
          unacceptedBlockingAdvisories: [],
        },
        threshold: "high",
      });

      const receiptFile = path.join(artifactDirectory, "mcporter-runtime.receipt.json");
      const retainedPackageJson = path.join(runtime, "package.json");
      const retainedPackageLock = path.join(runtime, "package-lock.json");
      const transportRawReport = path.join(artifactDirectory, "mcporter-runtime.raw.json");
      const trustedPolicyResult = path.join(root, "trusted-policy-result.json");
      const receiptVerifier = path.join(trustedRoot, "scripts", "lib", "npm-audit-receipt.mts");
      const retainedReport = path.join(root, "retained-report.json");
      const retainedResult = path.join(root, "retained-result.json");
      const verifierArgs = [
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
        "--legacy-audit",
        "true",
        "--result",
        trustedPolicyResult,
      ];
      const nodeLog = path.join(root, "node.log");
      const stubBin = path.join(root, "bin");
      const helper = path.join(root, "verify-mcporter-audit.sh");
      fs.mkdirSync(stubBin);
      fs.writeFileSync(
        path.join(stubBin, "node"),
        '#!/usr/bin/env bash\nset -euo pipefail\nprintf \'%s\\n\' "$*" >>"$NEMOCLAW_TEST_NODE_LOG"\n[[ "$*" != *"/scripts/lib/reviewed-npm-audit.mts"* ]] || exit 0\nexec "$NEMOCLAW_TEST_REAL_NODE" "$@"\n',
        { mode: 0o755 },
      );
      let helperSource = fs.readFileSync(
        path.join(REPO_ROOT, "scripts/lib/verify-mcporter-audit.sh"),
        "utf8",
      );
      helperSource = helperSource
        .replaceAll("/run/secrets/nemoclaw-mcporter-audit-receipt", receiptFile)
        .replaceAll("/run/secrets/nemoclaw-mcporter-audit-raw-report", transportRawReport)
        .replaceAll("/run/secrets/nemoclaw-mcporter-audit-policy-result", trustedPolicyResult)
        .replaceAll(
          "/run/nemoclaw-mcporter-audit-cache/reviewed-npm-audit",
          path.join(root, "no-seed"),
        );
      fs.writeFileSync(helper, helperSource, { mode: 0o755 });
      const correctReceiptSha256 = createHash("sha256")
        .update(fs.readFileSync(receiptFile))
        .digest("hex");
      const policyResultSha256 = () =>
        createHash("sha256").update(fs.readFileSync(trustedPolicyResult)).digest("hex");
      const runHelper = (
        receiptSha256 = correctReceiptSha256,
        trustedPolicyResultSha256 = policyResultSha256(),
        helperFile = helper,
      ) =>
        spawnSync("bash", [helperFile], {
          encoding: "utf8",
          env: {
            ...process.env,
            NEMOCLAW_MCPORTER_AUDIT_RECEIPT_SHA256: receiptSha256,
            NEMOCLAW_MCPORTER_AUDIT_POLICY_RESULT_SHA256: trustedPolicyResultSha256,
            NEMOCLAW_MCPORTER_AUDIT_REPORT_PATH: retainedReport,
            NEMOCLAW_MCPORTER_AUDIT_RESULT_PATH: retainedResult,
            NEMOCLAW_TEST_NODE_LOG: nodeLog,
            NEMOCLAW_TEST_REAL_NODE: process.execPath,
            PATH: `${stubBin}:${process.env.PATH ?? ""}`,
          },
        });

      fs.writeFileSync(transportRawReport, "{}\n");
      const rejectedByTrustedPolicy = spawnSync(process.execPath, verifierArgs, {
        encoding: "utf8",
      });
      expect(rejectedByTrustedPolicy.status).not.toBe(0);
      expect(rejectedByTrustedPolicy.stderr).toContain("receipt rawResponseSha256 does not match");
      expect(fs.existsSync(trustedPolicyResult)).toBe(false);

      fs.writeFileSync(transportRawReport, rawReport);
      const acceptedByTrustedPolicy = spawnSync(process.execPath, verifierArgs, {
        encoding: "utf8",
      });
      expect(acceptedByTrustedPolicy.status, acceptedByTrustedPolicy.stderr).toBe(0);
      expect(JSON.parse(fs.readFileSync(trustedPolicyResult, "utf8"))).toMatchObject({
        acceptedAdvisories: [acceptedAdvisory],
        graph: "mcporter-runtime",
        status: "accepted-exceptions",
      });

      const wrongHash = "0".repeat(64);
      expect(wrongHash).not.toBe(correctReceiptSha256);
      const rejectedTransport = runHelper(wrongHash);
      expect(rejectedTransport.status).not.toBe(0);
      expect(rejectedTransport.stderr).toContain("receipt hash does not match");
      expect(fs.existsSync(retainedReport)).toBe(false);
      expect(fs.existsSync(retainedResult)).toBe(false);
      expect(fs.existsSync(nodeLog)).toBe(false);

      const verifiedPolicyResultSha256 = policyResultSha256();
      const forgedPolicyResult = path.join(root, "forged-policy-result.json");
      const forgedPolicyHelper = path.join(root, "verify-forged-mcporter-audit.sh");
      fs.writeFileSync(forgedPolicyResult, '{"graph":"mcporter-runtime","status":"failed"}\n');
      fs.writeFileSync(
        forgedPolicyHelper,
        helperSource.replaceAll(trustedPolicyResult, forgedPolicyResult),
        { mode: 0o755 },
      );
      const rejectedPolicyResult = runHelper(
        correctReceiptSha256,
        verifiedPolicyResultSha256,
        forgedPolicyHelper,
      );
      expect(rejectedPolicyResult.status).not.toBe(0);
      expect(rejectedPolicyResult.stderr).toContain("policy result hash does not match");
      expect(fs.existsSync(retainedReport)).toBe(false);
      expect(fs.existsSync(retainedResult)).toBe(false);
      expect(fs.existsSync(nodeLog)).toBe(false);

      const forgedRawReport = path.join(root, "forged-raw-report.json");
      const forgedRawHelper = path.join(root, "verify-forged-mcporter-raw-report.sh");
      fs.writeFileSync(forgedRawReport, "{}\n");
      fs.writeFileSync(
        forgedRawHelper,
        helperSource.replaceAll(transportRawReport, forgedRawReport),
        { mode: 0o755 },
      );
      const rejectedRawReport = runHelper(
        correctReceiptSha256,
        verifiedPolicyResultSha256,
        forgedRawHelper,
      );
      expect(rejectedRawReport.status).not.toBe(0);
      expect(rejectedRawReport.stderr).toContain("raw report does not match the verified receipt");
      expect(fs.existsSync(retainedReport)).toBe(false);
      expect(fs.existsSync(retainedResult)).toBe(false);
      expect(fs.existsSync(nodeLog)).toBe(false);

      const malformedReceipt = path.join(root, "malformed-receipt.json");
      const malformedReceiptHelper = path.join(root, "verify-malformed-mcporter-receipt.sh");
      fs.writeFileSync(
        malformedReceipt,
        `not-json "rawResponseSha256":"${createHash("sha256").update(rawReport).digest("hex")}"\n`,
      );
      fs.writeFileSync(
        malformedReceiptHelper,
        helperSource.replaceAll(receiptFile, malformedReceipt),
        { mode: 0o755 },
      );
      const malformedReceiptSha256 = createHash("sha256")
        .update(fs.readFileSync(malformedReceipt))
        .digest("hex");
      const rejectedMalformedReceipt = runHelper(
        malformedReceiptSha256,
        verifiedPolicyResultSha256,
        malformedReceiptHelper,
      );
      expect(rejectedMalformedReceipt.status).not.toBe(0);
      expect(rejectedMalformedReceipt.stderr).toContain(
        "receipt does not declare a raw response SHA-256",
      );
      expect(fs.existsSync(retainedReport)).toBe(false);
      expect(fs.existsSync(retainedResult)).toBe(false);
      expect(fs.existsSync(nodeLog)).toBe(false);

      const accepted = runHelper();
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(fs.readFileSync(transportRawReport, "utf8")).toBe(rawReport);
      expect(fs.readFileSync(retainedReport, "utf8")).toBe(rawReport);
      expect(fs.readFileSync(retainedResult, "utf8")).toBe(
        fs.readFileSync(trustedPolicyResult, "utf8"),
      );
      expect(fs.existsSync(nodeLog)).toBe(false);
      const directHelper = path.join(root, "verify-mcporter-direct-audit.sh");
      fs.writeFileSync(
        directHelper,
        helperSource
          .replaceAll(receiptFile, path.join(root, "missing-direct-receipt"))
          .replaceAll(transportRawReport, path.join(root, "missing-direct-report"))
          .replaceAll(trustedPolicyResult, path.join(root, "missing-direct-policy-result")),
        { mode: 0o755 },
      );
      const direct = spawnSync("bash", [directHelper], {
        encoding: "utf8",
        env: {
          ...process.env,
          NEMOCLAW_MCPORTER_AUDIT_RECEIPT_SHA256: "",
          NEMOCLAW_MCPORTER_AUDIT_POLICY_RESULT_SHA256: "",
          NEMOCLAW_MCPORTER_AUDIT_REPORT_PATH: retainedReport,
          NEMOCLAW_MCPORTER_AUDIT_RESULT_PATH: retainedResult,
          NEMOCLAW_TEST_NODE_LOG: nodeLog,
          PATH: `${stubBin}:${process.env.PATH ?? ""}`,
        },
      });
      expect(direct.status, direct.stderr).toBe(0);
      expect(fs.readFileSync(nodeLog, "utf8").trim().split("\n").at(-1)).toBe(
        `/scripts/lib/reviewed-npm-audit.mts --directory /usr/local/lib/nemoclaw/mcporter-runtime --exceptions /scripts/npm-audit-exceptions.json --graph mcporter-runtime --threshold high --report ${retainedReport} --result ${retainedResult}`,
      );

      const seedEvidence = path.join(root, "seed", "reviewed-npm-audit");
      const seedHelper = path.join(root, "verify-mcporter-seed-audit.sh");
      fs.mkdirSync(seedEvidence, { recursive: true });
      fs.copyFileSync(receiptFile, path.join(seedEvidence, "mcporter-runtime.receipt.json"));
      fs.writeFileSync(path.join(seedEvidence, "mcporter-runtime.raw.json"), rawReport);
      fs.writeFileSync(
        path.join(seedEvidence, "mcporter-runtime.receipt.sha256"),
        `${createHash("sha256").update(fs.readFileSync(receiptFile)).digest("hex")}\n`,
      );
      fs.writeFileSync(
        seedHelper,
        helperSource
          .replaceAll(receiptFile, path.join(root, "missing-secret-receipt"))
          .replaceAll(transportRawReport, path.join(root, "missing-secret-report"))
          .replaceAll(trustedPolicyResult, path.join(root, "missing-secret-policy-result"))
          .replaceAll(path.join(root, "no-seed"), seedEvidence),
        { mode: 0o755 },
      );
      const rejectedSeed = spawnSync("bash", [seedHelper], {
        encoding: "utf8",
        env: {
          ...process.env,
          NEMOCLAW_MCPORTER_AUDIT_RECEIPT_SHA256: "",
          NEMOCLAW_MCPORTER_AUDIT_POLICY_RESULT_SHA256: "",
        },
      });
      expect(rejectedSeed.status).not.toBe(0);
      expect(rejectedSeed.stderr).toContain("build-context mcporter audit evidence is not trusted");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
