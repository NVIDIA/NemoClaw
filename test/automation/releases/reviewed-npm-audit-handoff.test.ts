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

  it("passes producer output through protected audit handoffs and rejects forged reports", () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "reviewed-audit-receipt-handoff-")),
    );
    const trustedRoot = path.join(root, "trusted");
    const targetRoot = path.join(root, "target");
    const runtime = path.join(targetRoot, "agents/openclaw/mcporter-runtime");
    const artifactDirectory = path.join(targetRoot, "artifacts/reviewed-npm-audit");
    const producerBin = path.join(root, "producer-bin");
    const exceptionFile = path.join(trustedRoot, "ci/npm-audit-exceptions.json");
    const auditConfigFile = path.join(trustedRoot, "ci/reviewed-npm-audit.json");
    const auditConfig = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "ci/reviewed-npm-audit.json"), "utf8"),
    );
    const npmVersion = auditConfig.npmVersion as string;
    const reviewedMcporter = auditConfig.lockedGraphs.find(
      ({ id }: { id: string }) => id === "mcporter-runtime",
    );
    const rawReport =
      '{"vulnerabilities":{},"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":0,"critical":0}}}\n';
    try {
      fs.mkdirSync(runtime, { recursive: true });
      fs.mkdirSync(path.join(trustedRoot, "ci"), { recursive: true });
      fs.mkdirSync(producerBin);
      fs.cpSync(path.join(REPO_ROOT, "scripts"), path.join(trustedRoot, "scripts"), {
        recursive: true,
      });
      fs.cpSync(path.join(REPO_ROOT, "agents/openclaw/mcporter-runtime"), runtime, {
        recursive: true,
      });
      fs.mkdirSync(path.join(targetRoot, "ci"), { recursive: true });
      fs.mkdirSync(path.join(targetRoot, "scripts", "lib"), { recursive: true });
      fs.writeFileSync(path.join(targetRoot, "ci", "reviewed-npm-audit.json"), "{}\n");
      fs.writeFileSync(
        path.join(targetRoot, "scripts", "audit-reviewed-npm-graph.mts"),
        "throw new Error('candidate producer executed');\n",
      );
      fs.writeFileSync(
        path.join(targetRoot, "scripts", "lib", "npm-audit-receipt.mts"),
        "throw new Error('candidate verifier executed');\n",
      );
      fs.copyFileSync(path.join(REPO_ROOT, "ci/npm-audit-exceptions.json"), exceptionFile);
      fs.copyFileSync(path.join(REPO_ROOT, "ci/reviewed-npm-audit.json"), auditConfigFile);
      fs.writeFileSync(
        path.join(producerBin, "npm"),
        `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") console.log(process.env.NEMOCLAW_TEST_NPM_VERSION);
else if (args[0] === "config") console.log("https://registry.npmjs.org/");
else if (args[0] === "view") console.log(args.includes("dist.tarball") ? process.env.NEMOCLAW_TEST_TARBALL : process.env.NEMOCLAW_TEST_INTEGRITY);
else if (args[0] === "audit" && args[1] !== "signatures") process.stdout.write(process.env.NEMOCLAW_TEST_AUDIT_OUTPUT);
else if (args[0] === "ci") {
  const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!location) continue;
    fs.mkdirSync(location, { recursive: true });
    fs.writeFileSync(location + "/package.json", JSON.stringify({
      name: location.slice(location.lastIndexOf("node_modules/") + 13),
      version: entry.version,
      dependencies: entry.dependencies,
      peerDependencies: entry.peerDependencies,
      peerDependenciesMeta: entry.peerDependenciesMeta,
    }));
  }
}
`,
        { mode: 0o755 },
      );
      const producer = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          path.join(trustedRoot, "scripts/audit-reviewed-npm-graph.mts"),
        ],
        {
          cwd: trustedRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            NEMOCLAW_REVIEWED_NPM_AUDIT_LOCKED_GRAPH: "mcporter-runtime",
            NEMOCLAW_REVIEWED_NPM_AUDIT_REPORT_DIR: "artifacts/reviewed-npm-audit",
            NEMOCLAW_REVIEWED_NPM_AUDIT_TARGET_ROOT: targetRoot,
            NEMOCLAW_TEST_AUDIT_OUTPUT: rawReport,
            NEMOCLAW_TEST_INTEGRITY: reviewedMcporter.integrity,
            NEMOCLAW_TEST_NPM_VERSION: npmVersion,
            NEMOCLAW_TEST_TARBALL: reviewedMcporter.tarballUrl,
            PATH: `${producerBin}:${process.env.PATH ?? ""}`,
          },
        },
      );
      expect(producer.status, producer.stderr).toBe(0);

      const receiptFile = path.join(artifactDirectory, "mcporter-runtime.receipt.json");
      const retainedPackageJson = path.join(runtime, "package.json");
      const retainedPackageLock = path.join(runtime, "package-lock.json");
      const transportRawReport = path.join(artifactDirectory, "mcporter-runtime.raw.json");
      const receiptVerifier = path.join(trustedRoot, "scripts", "lib", "npm-audit-receipt.mts");
      const retainedReport = path.join(root, "retained-report.json");
      const retainedResult = path.join(root, "retained-result.json");
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
        "--result",
        retainedResult,
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
        .replaceAll(
          "/run/nemoclaw-mcporter-audit-cache/reviewed-npm-audit",
          path.join(root, "no-seed"),
        )
        .replaceAll("/scripts/lib/npm-audit-receipt.mts", receiptVerifier)
        .replaceAll("/usr/local/lib/nemoclaw/mcporter-runtime/package.json", retainedPackageJson)
        .replaceAll(
          "/usr/local/lib/nemoclaw/mcporter-runtime/package-lock.json",
          retainedPackageLock,
        )
        .replaceAll("/scripts/npm-audit-exceptions.json", exceptionFile)
        .replaceAll("/scripts/reviewed-npm-audit.json", auditConfigFile);
      fs.writeFileSync(helper, helperSource, { mode: 0o755 });
      const runHelper = () =>
        spawnSync("bash", [helper], {
          encoding: "utf8",
          env: {
            ...process.env,
            NEMOCLAW_MCPORTER_AUDIT_RECEIPT_SHA256: createHash("sha256")
              .update(fs.readFileSync(receiptFile))
              .digest("hex"),
            NEMOCLAW_MCPORTER_AUDIT_REPORT_PATH: retainedReport,
            NEMOCLAW_MCPORTER_AUDIT_RESULT_PATH: retainedResult,
            NEMOCLAW_TEST_NODE_LOG: nodeLog,
            NEMOCLAW_TEST_REAL_NODE: process.execPath,
            PATH: `${stubBin}:${process.env.PATH ?? ""}`,
          },
        });

      fs.writeFileSync(transportRawReport, "{}\n");
      const rejected = runHelper();
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain("receipt rawResponseSha256 does not match");
      expect(fs.existsSync(retainedReport)).toBe(false);
      expect(fs.existsSync(retainedResult)).toBe(false);

      fs.writeFileSync(transportRawReport, rawReport);
      const accepted = runHelper();
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(fs.readFileSync(transportRawReport, "utf8")).toBe(rawReport);
      expect(fs.readFileSync(retainedReport, "utf8")).toBe(rawReport);
      expect(JSON.parse(fs.readFileSync(retainedResult, "utf8"))).toMatchObject({
        graph: "mcporter-runtime",
        status: "clean",
      });
      expect(fs.readFileSync(nodeLog, "utf8").trim().split("\n").at(-1)).toBe(
        verifierArgs.join(" "),
      );

      const directHelper = path.join(root, "verify-mcporter-direct-audit.sh");
      fs.writeFileSync(
        directHelper,
        helperSource
          .replaceAll(receiptFile, path.join(root, "missing-direct-receipt"))
          .replaceAll(transportRawReport, path.join(root, "missing-direct-report")),
        { mode: 0o755 },
      );
      const direct = spawnSync("bash", [directHelper], {
        encoding: "utf8",
        env: {
          ...process.env,
          NEMOCLAW_MCPORTER_AUDIT_RECEIPT_SHA256: "",
          NEMOCLAW_MCPORTER_AUDIT_REPORT_PATH: retainedReport,
          NEMOCLAW_MCPORTER_AUDIT_RESULT_PATH: retainedResult,
          NEMOCLAW_TEST_NODE_LOG: nodeLog,
          PATH: `${stubBin}:${process.env.PATH ?? ""}`,
        },
      });
      expect(direct.status, direct.stderr).toBe(0);
      expect(fs.readFileSync(nodeLog, "utf8").trim().split("\n").at(-1)).toContain(
        `--report ${retainedReport} --result ${retainedResult}`,
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
          .replaceAll(path.join(root, "no-seed"), seedEvidence),
        { mode: 0o755 },
      );
      const rejectedSeed = spawnSync("bash", [seedHelper], {
        encoding: "utf8",
        env: { ...process.env, NEMOCLAW_MCPORTER_AUDIT_RECEIPT_SHA256: "" },
      });
      expect(rejectedSeed.status).not.toBe(0);
      expect(rejectedSeed.stderr).toContain("build-context mcporter audit evidence is not trusted");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
