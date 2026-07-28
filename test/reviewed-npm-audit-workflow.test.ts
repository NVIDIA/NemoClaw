// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeOpenClawSignatureAlias } from "../scripts/audit-reviewed-npm-graph.mts";
import { readYaml } from "./helpers/e2e-workflow-contract";

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

const REPO_ROOT = path.join(import.meta.dirname, "..");
const BOOTSTRAP_SHA = "0c7dd29394d2c4db660c4d09f3654c0789e200d0";
// Removal condition: delete the PR-6830 fork bootstrap after this PR merges and
// the base branch contains the schema-v2 reviewed npm audit action.
const BOOTSTRAP_IF =
  "${{ steps.trusted-reviewed-npm-audit.outputs.available != 'true' && github.event.pull_request.number == 6830 && github.event.pull_request.head.repo.full_name == 'HOYALIM/NemoClaw' }}";
const REJECT_UNAVAILABLE_IF =
  "${{ steps.trusted-reviewed-npm-audit.outputs.available != 'true' && (github.event.pull_request.number != 6830 || github.event.pull_request.head.repo.full_name != 'HOYALIM/NemoClaw') }}";
const DOMEXCEPTION_INTEGRITY =
  "sha512-tlc/FcYIv5i8RYsl2iDil4A0gOihaas1R5jPcIC4Zw3GhjKsVilw90aHcVlhZPTBLGBzd379S+VcnsDjd9ChiA==";

function requiredStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === name);
  expect(step, `Missing workflow step: ${name}`).toBeDefined();
  return step as WorkflowStep;
}

describe("trusted reviewed npm audit workflow (#5896)", () => {
  // source-shape-contract: security -- PR dependency audit code must come from the base SHA or the one-time signed bootstrap
  it("runs PR audits from trusted code and keeps the main audit on the checked-in action", () => {
    const pr = readYaml<Workflow>(".github/workflows/pr.yaml");
    const main = readYaml<Workflow>(".github/workflows/main.yaml");
    const prJob = pr.jobs["reviewed-npm-audit"];
    const mainJob = main.jobs["reviewed-npm-audit"];

    const trustedCheckout = requiredStep(prJob, "Checkout trusted reviewed npm audit");
    expect(trustedCheckout.with).toMatchObject({
      ref: "${{ github.event.pull_request.base.sha }}",
      path: ".trusted-reviewed-npm-audit",
      "persist-credentials": false,
      "sparse-checkout-cone-mode": false,
    });
    const sparseCheckout = String(trustedCheckout.with?.["sparse-checkout"]);
    expect(sparseCheckout).toContain(".github/actions/ci-reviewed-npm-audit");
    expect(sparseCheckout).toContain("ci/npm-audit-exceptions.json");
    expect(sparseCheckout).toContain("ci/reviewed-npm-audit.json");
    expect(sparseCheckout).toContain("scripts/audit-reviewed-npm-graph.mts");
    expect(sparseCheckout).toContain("scripts/lib/openclaw-npm-remediation.mts");
    expect(sparseCheckout).toContain("scripts/lib/reviewed-npm-archive.mts");
    expect(sparseCheckout).toContain("scripts/lib/reviewed-npm-audit.mts");

    const detection = requiredStep(prJob, "Detect trusted reviewed npm audit schema");
    expect(detection.id).toBe("trusted-reviewed-npm-audit");
    expect(detection.run).toContain("resolveTrustedAuditConfigPath(TRUSTED_REPO_ROOT)");
    expect(detection.run).toContain(".trusted-reviewed-npm-audit/ci/npm-audit-exceptions.json");
    expect(detection.run).toContain(".trusted-reviewed-npm-audit/ci/reviewed-npm-audit.json");
    expect(detection.run).toContain(
      ".trusted-reviewed-npm-audit/scripts/lib/openclaw-npm-remediation.mts",
    );
    expect(detection.run).toContain(
      ".trusted-reviewed-npm-audit/scripts/lib/reviewed-npm-audit.mts",
    );

    const bootstrap = requiredStep(prJob, "Checkout pinned bootstrap reviewed npm audit");
    expect(bootstrap.if).toBe(BOOTSTRAP_IF);
    expect(bootstrap.with).toMatchObject({
      repository: "HOYALIM/NemoClaw",
      ref: BOOTSTRAP_SHA,
      path: ".trusted-reviewed-npm-audit-bootstrap",
      "persist-credentials": false,
    });
    const bootstrapSparseCheckout = String(bootstrap.with?.["sparse-checkout"]);
    expect(bootstrapSparseCheckout).toContain("ci/npm-audit-exceptions.json");
    expect(bootstrapSparseCheckout).toContain("scripts/lib/openclaw-npm-remediation.mts");
    expect(bootstrapSparseCheckout).toContain("scripts/lib/reviewed-npm-audit.mts");
    const rejectUnavailable = requiredStep(prJob, "Reject unavailable trusted reviewed npm audit");
    expect(rejectUnavailable.if).toBe(REJECT_UNAVAILABLE_IF);
    expect(rejectUnavailable.run).toContain("exit 1");
    expect(requiredStep(prJob, "Audit reviewed production npm graphs")).toMatchObject({
      if: "${{ steps.trusted-reviewed-npm-audit.outputs.available == 'true' }}",
      uses: "./.trusted-reviewed-npm-audit/.github/actions/ci-reviewed-npm-audit",
      with: {
        "target-root": "${{ github.workspace }}",
        "report-dir": "artifacts/reviewed-npm-audit",
      },
    });
    expect(
      requiredStep(prJob, "Audit reviewed production npm graphs (pinned bootstrap)"),
    ).toMatchObject({
      if: BOOTSTRAP_IF,
      uses: "./.trusted-reviewed-npm-audit-bootstrap/.github/actions/ci-reviewed-npm-audit",
    });
    expect(requiredStep(mainJob, "Audit reviewed production npm graphs")).toMatchObject({
      uses: "./.github/actions/ci-reviewed-npm-audit",
      with: {
        "target-root": "${{ github.workspace }}",
        "report-dir": "artifacts/reviewed-npm-audit",
      },
    });
  });

  // source-shape-contract: security -- The trusted composite action must execute only its bundled driver while treating the PR checkout as explicit data
  it("executes the trusted driver and helper against explicit target inputs", () => {
    const action = fs.readFileSync(
      path.join(REPO_ROOT, ".github", "actions", "ci-reviewed-npm-audit", "action.yaml"),
      "utf8",
    );
    const driver = fs.readFileSync(
      path.join(REPO_ROOT, "scripts", "audit-reviewed-npm-graph.mts"),
      "utf8",
    );
    const helper = fs.readFileSync(
      path.join(REPO_ROOT, "scripts", "lib", "reviewed-npm-audit.mts"),
      "utf8",
    );

    expect(action).toContain('node-version: "22.23.1"');
    expect(action).toContain("npm install --global npm@10.9.4");
    expect(action).toContain("NEMOCLAW_REVIEWED_NPM_AUDIT_TARGET_ROOT");
    expect(action).toContain("NEMOCLAW_REVIEWED_NPM_AUDIT_REPORT_DIR");
    expect(action).toContain(
      'node --experimental-strip-types "$GITHUB_ACTION_PATH/../../../scripts/audit-reviewed-npm-graph.mts"',
    );
    expect(action).not.toContain("run: node --experimental-strip-types scripts/");
    expect(driver).toContain("resolveTrustedAuditConfigPath(TRUSTED_REPO_ROOT)");
    expect(helper).toContain("const NPM_AUDIT_ATTEMPT_TIMEOUT_MS = 45_000");
    expect(helper).toContain("timeout: NPM_AUDIT_ATTEMPT_TIMEOUT_MS");
    expect(driver).not.toContain('resolveTargetPath(\n  "ci/reviewed-npm-audit.json"');
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
