// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readYaml } from "./helpers/e2e-workflow-contract";

type WorkflowStep = {
  readonly name?: string;
  readonly run?: string;
  readonly if?: string;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
  readonly env?: Record<string, string>;
};

type WorkflowJob = {
  readonly needs?: string | readonly string[];
  readonly steps?: readonly WorkflowStep[];
};

type Workflow = {
  readonly jobs: Record<string, WorkflowJob>;
};

const repoRoot = path.join(import.meta.dirname, "..");
const auditScript = path.join(
  repoRoot,
  ".github",
  "actions",
  "ci-wechat-runtime-audit",
  "audit.sh",
);

function runAuditValidation(
  mutate: (fixture: { readonly targetRoot: string; readonly runtimeDir: string }) => void,
) {
  const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wechat-audit-test-"));
  const runtimeDir = path.join(targetRoot, "agents", "openclaw", "wechat-runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  for (const filename of ["package.json", "package-lock.json"]) {
    fs.copyFileSync(
      path.join(repoRoot, "agents", "openclaw", "wechat-runtime", filename),
      path.join(runtimeDir, filename),
    );
  }

  try {
    mutate({ targetRoot, runtimeDir });
    const result = spawnSync("bash", [auditScript], {
      cwd: targetRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        NEMOCLAW_WECHAT_AUDIT_REPORT_DIR: "artifacts/wechat-runtime-audit",
        NEMOCLAW_WECHAT_AUDIT_TARGET_ROOT: targetRoot,
        PATH: `${path.join(targetRoot, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });
    const provenancePath = path.join(
      targetRoot,
      "artifacts",
      "wechat-runtime-audit",
      "npm-audit.provenance.json",
    );
    return {
      ...result,
      provenance: fs.existsSync(provenancePath)
        ? (JSON.parse(fs.readFileSync(provenancePath, "utf8")) as Record<string, unknown>)
        : undefined,
    };
  } finally {
    fs.rmSync(targetRoot, { force: true, recursive: true });
  }
}

function installFakeAuditNpm(
  targetRoot: string,
  auditOutput: Record<string, unknown> | string,
  auditStatus: number,
): void {
  const binDir = path.join(targetRoot, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const npm = path.join(binDir, "npm");
  fs.writeFileSync(
    npm,
    [
      "#!/usr/bin/env node",
      `const auditReport = ${JSON.stringify(
        typeof auditOutput === "string" ? auditOutput : JSON.stringify(auditOutput),
      )};`,
      `const auditStatus = ${auditStatus};`,
      "const args = process.argv.slice(2);",
      'if (args[0] === "--version") {',
      '  console.log("10.9.4");',
      "  process.exit(0);",
      "}",
      'if (args.includes("audit")) {',
      "  console.log(auditReport);",
      "  process.exit(auditStatus);",
      "}",
      "process.exit(0);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

function requiredStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === name);
  expect(step, `Missing workflow step: ${name}`).toBeDefined();
  return step as WorkflowStep;
}

describe("WeChat runtime audit and install-cache gates (#5896)", () => {
  // source-shape-contract: security -- Trusted PR and main workflows must enforce the reviewed WeChat runtime audit boundary
  it("makes the trusted audit required in PR and main workflows", () => {
    const pr = readYaml<Workflow>(".github/workflows/pr.yaml");
    const main = readYaml<Workflow>(".github/workflows/main.yaml");
    const prJob = pr.jobs["wechat-runtime-audit"];
    const mainJob = main.jobs["wechat-runtime-audit"];

    const trustedCheckout = requiredStep(prJob, "Checkout trusted WeChat runtime audit");
    expect(trustedCheckout.with).toMatchObject({
      ref: "${{ github.event.pull_request.base.sha }}",
      path: ".trusted-wechat-audit",
      "persist-credentials": false,
      "sparse-checkout-cone-mode": false,
    });
    expect(String(trustedCheckout.with?.["sparse-checkout"])).toContain(
      ".github/actions/ci-wechat-runtime-audit",
    );

    const bootstrapCheckout = requiredStep(prJob, "Checkout pinned bootstrap WeChat runtime audit");
    expect(bootstrapCheckout.if).toBe(
      "${{ steps.trusted-wechat-audit.outputs.available != 'true' && github.event.pull_request.number == 6739 && github.event.pull_request.head.repo.full_name == 'HOYALIM/NemoClaw' }}",
    );
    expect(bootstrapCheckout.with).toMatchObject({
      repository: "HOYALIM/NemoClaw",
      ref: "0d2256d71d5bbba3bcaaaa4d01714fa56f22d1e2",
      path: ".trusted-wechat-audit-bootstrap",
      "persist-credentials": false,
    });
    expect(requiredStep(prJob, "Audit locked WeChat runtime graph").uses).toBe(
      "./.trusted-wechat-audit/.github/actions/ci-wechat-runtime-audit",
    );
    expect(requiredStep(prJob, "Audit locked WeChat runtime graph (pinned bootstrap)").uses).toBe(
      "./.trusted-wechat-audit-bootstrap/.github/actions/ci-wechat-runtime-audit",
    );
    expect(requiredStep(mainJob, "Audit locked WeChat runtime graph").uses).toBe(
      "./.github/actions/ci-wechat-runtime-audit",
    );

    for (const [workflowName, workflow, job] of [
      ["pr", pr, prJob],
      ["main", main, mainJob],
    ] as const) {
      const upload = requiredStep(job, "Upload WeChat runtime audit evidence");
      expect(upload.if).toBe("${{ always() }}");
      expect(upload.uses).toBe("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
      expect(upload.with).toMatchObject({
        path: "artifacts/wechat-runtime-audit",
        "if-no-files-found": "error",
      });

      expect(workflow.jobs.checks.needs).toContain("wechat-runtime-audit");
      const gate = requiredStep(
        workflow.jobs.checks,
        workflowName === "pr" ? "Verify required PR checks" : "Verify required main checks",
      );
      expect(gate.env).toMatchObject({
        WECHAT_RUNTIME_AUDIT_RESULT: "${{ needs['wechat-runtime-audit'].result }}",
      });
      expect(gate.run).toContain(
        'require_success "wechat-runtime-audit" "$WECHAT_RUNTIME_AUDIT_RESULT"',
      );
    }
  });

  it("audits the installed graph and exercises the exact archive through a copied cache", () => {
    const script = fs.readFileSync(auditScript, "utf8");
    for (const fragment of [
      'npm --prefix "$runtime_dir" ci',
      "--ignore-scripts",
      "--omit=dev",
      "--legacy-peer-deps",
      "audit-level=low",
      "audit signatures",
      "npm-audit.json",
      "npm-audit-signatures.txt",
      'chmod -R a-w "$trusted_cache"',
      'cp -R "$trusted_cache"/. "$install_cache"/',
      'chmod -R u+rwX,go-w "$install_cache"',
      'npm pack "$wechat_tarball"',
      "--offline",
      'EXPECTED_INTEGRITY="$wechat_integrity"',
      "WeChat runtime package.json must contain exactly the reviewed plugin dependency",
      "WeChat runtime plugin lock entry must carry sha512 integrity",
      'npm_registry="https://registry.npmjs.org/"',
      '--userconfig "$trusted_npmrc"',
      '--registry "$npm_registry"',
      "requireRegistryUrl(record.resolved, location)",
    ]) {
      expect(script).toContain(fragment);
    }

    const action = fs.readFileSync(
      path.join(repoRoot, ".github", "actions", "ci-wechat-runtime-audit", "action.yaml"),
      "utf8",
    );
    expect(action).toContain('node-version: "22.19.0"');
    expect(action).toContain('cd "$RUNNER_TEMP"');
    expect(action).toContain("npm install --global npm@10.9.4");
    expect(action).toContain("--userconfig /dev/null");
    expect(action).toContain("--registry https://registry.npmjs.org/");
    expect(action).toContain('run: bash "$GITHUB_ACTION_PATH/audit.sh"');
  });

  it("rejects a target-controlled npm registry override", () => {
    const result = runAuditValidation(({ runtimeDir }) => {
      fs.writeFileSync(
        path.join(runtimeDir, ".npmrc"),
        "registry=https://registry.example.test/\n",
      );
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("refuses target-controlled npm config");
  });

  it("rejects an off-origin transitive package archive", () => {
    const result = runAuditValidation(({ targetRoot, runtimeDir }) => {
      const lockPath = path.join(runtimeDir, "package-lock.json");
      const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      lock.packages["node_modules/qrcode-terminal"].resolved =
        "https://registry.example.test/qrcode-terminal-0.12.0.tgz";
      fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
      const binDir = path.join(targetRoot, "bin");
      fs.mkdirSync(binDir);
      const npm = path.join(binDir, "npm");
      fs.writeFileSync(npm, "#!/bin/sh\necho npm-should-not-run >&2\nexit 99\n");
      fs.chmodSync(npm, 0o755);
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "locked package must resolve from the reviewed npm registry origin: node_modules/qrcode-terminal",
    );
    expect(result.stderr).not.toContain("npm-should-not-run");
  });

  it.each([
    ["malformed npm output", "{not-json", 1, /parseable JSON report/],
    [
      "parseable npm error JSON",
      { error: { code: "ECONNREFUSED", summary: "registry unreachable" } },
      1,
      /ECONNREFUSED/,
    ],
    ["missing vulnerability metadata", {}, 0, /complete vulnerability finding report/],
    [
      "an incomplete severity matrix",
      {
        metadata: {
          vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0 },
        },
      },
      0,
      /complete vulnerability finding report/,
    ],
  ])("records provenance and fails closed for %s", (_label, auditReport, auditStatus, expectedFailure) => {
    const result = runAuditValidation(({ targetRoot }) => {
      installFakeAuditNpm(targetRoot, auditReport, auditStatus);
    });

    expect(result.status).not.toBe(0);
    expect(result.provenance).toMatchObject({
      failure: expect.stringMatching(expectedFailure),
      rawReportPath: "npm-audit.json",
    });
  });

  it("keeps the image cache trusted and deletes the sandbox-writable copy", () => {
    const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
    for (const fragment of [
      "chown -R root:root /usr/local/lib/nemoclaw/wechat-runtime",
      "node --experimental-strip-types /scripts/lib/reviewed-npm-archive.mts",
      "--lockfile /usr/local/lib/nemoclaw/wechat-runtime/package-lock.json",
      "--cache /usr/local/share/nemoclaw/wechat-npm-cache",
      "--registry-origin https://registry.npmjs.org/",
      "trusted_cache=/usr/local/share/nemoclaw/wechat-npm-cache",
      'install_cache="$(mktemp -d /tmp/nemoclaw-wechat-npm-cache.XXXXXX)"',
      'cp -R "$trusted_cache"/. "$install_cache"/',
      'NEMOCLAW_WECHAT_NPM_INSTALL_CACHE="$install_cache"',
      'rm -rf "$install_cache"',
      'test ! -e "$install_cache"',
    ]) {
      expect(dockerfile).toContain(fragment);
    }
    const cacheVerification = dockerfile.indexOf(
      "--lockfile /usr/local/lib/nemoclaw/wechat-runtime/package-lock.json",
    );
    const cacheLockdown = dockerfile.indexOf(
      "chown -R root:root /usr/local/lib/nemoclaw/wechat-runtime",
      cacheVerification,
    );
    expect(cacheVerification).toBeGreaterThan(-1);
    expect(cacheLockdown).toBeGreaterThan(cacheVerification);
  });
});
