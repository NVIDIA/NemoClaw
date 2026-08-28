// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "../../..");
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
    const reportDir = path.join(targetRoot, "artifacts", "wechat-runtime-audit");
    const signatureReportPath = path.join(reportDir, "npm-audit-signatures.txt");
    const signatureCounterPath = path.join(targetRoot, "signature-attempt-count");
    const signatureDebugDir = path.join(reportDir, "npm-audit-signature-debug");
    return {
      ...result,
      provenance: fs.existsSync(provenancePath)
        ? (JSON.parse(fs.readFileSync(provenancePath, "utf8")) as Record<string, unknown>)
        : undefined,
      signatureAttemptCount: fs.existsSync(signatureCounterPath)
        ? Number(fs.readFileSync(signatureCounterPath, "utf8"))
        : 0,
      signatureDebugFiles: fs.existsSync(signatureDebugDir)
        ? fs.readdirSync(signatureDebugDir).sort()
        : [],
      signatureReport: fs.existsSync(signatureReportPath)
        ? fs.readFileSync(signatureReportPath, "utf8")
        : "",
    };
  } finally {
    fs.rmSync(targetRoot, { force: true, recursive: true });
  }
}

function installFakeAuditNpm(
  targetRoot: string,
  auditOutput: Record<string, unknown> | string,
  auditStatus: number,
  signatureAttempts: readonly { readonly output: string; readonly status: number }[] = [
    { output: "verified signatures", status: 0 },
  ],
): void {
  const binDir = path.join(targetRoot, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const npm = path.join(binDir, "npm");
  const packageLock = JSON.parse(
    fs.readFileSync(
      path.join(targetRoot, "agents", "openclaw", "wechat-runtime", "package-lock.json"),
      "utf8",
    ),
  );
  const expectedIntegrity =
    packageLock.packages["node_modules/@tencent-weixin/openclaw-weixin"].integrity;
  fs.writeFileSync(
    npm,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      `const auditReport = ${JSON.stringify(
        typeof auditOutput === "string" ? auditOutput : JSON.stringify(auditOutput),
      )};`,
      `const auditStatus = ${auditStatus};`,
      `const expectedIntegrity = ${JSON.stringify(expectedIntegrity)};`,
      `const signatureAttempts = ${JSON.stringify(signatureAttempts)};`,
      `const signatureCounterPath = ${JSON.stringify(path.join(targetRoot, "signature-attempt-count"))};`,
      "const args = process.argv.slice(2);",
      'if (args[0] === "--version") {',
      '  console.log("10.9.4");',
      "  process.exit(0);",
      "}",
      'if (args.includes("audit") && args.includes("signatures")) {',
      '  const attempt = fs.existsSync(signatureCounterPath) ? Number(fs.readFileSync(signatureCounterPath, "utf8")) + 1 : 1;',
      "  fs.writeFileSync(signatureCounterPath, String(attempt));",
      "  const selected = signatureAttempts[Math.min(attempt - 1, signatureAttempts.length - 1)];",
      '  const cacheIndex = args.indexOf("--cache");',
      "  if (cacheIndex >= 0) {",
      '    const logDir = path.join(args[cacheIndex + 1], "_logs");',
      "    fs.mkdirSync(logDir, { recursive: true });",
      '    fs.writeFileSync(path.join(logDir, \"signature-attempt-\" + attempt + \".log\"), selected.output + \"\\\\n\");',
      "  }",
      "  console.error(selected.output);",
      "  process.exit(selected.status);",
      "}",
      'if (args.includes("audit")) {',
      "  console.log(auditReport);",
      "  process.exit(auditStatus);",
      "}",
      'if (args[0] === "pack") {',
      '  const destination = args[args.indexOf("--pack-destination") + 1];',
      '  const filename = "wechat-runtime-test.tgz";',
      "  fs.mkdirSync(destination, { recursive: true });",
      '  fs.writeFileSync(path.join(destination, filename), "test archive");',
      "  console.log(JSON.stringify([{ filename, integrity: expectedIntegrity }]));",
      "  process.exit(0);",
      "}",
      "process.exit(0);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

describe("WeChat runtime audit and install-cache gates (#5896)", () => {
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
  ])(
    "records provenance and fails closed for %s",
    (_label, auditReport, auditStatus, expectedFailure) => {
      const result = runAuditValidation(({ targetRoot }) => {
        installFakeAuditNpm(targetRoot, auditReport, auditStatus);
      });

      expect(result.status).not.toBe(0);
      expect(result.provenance, result.stderr).toMatchObject({
        failure: expect.stringMatching(expectedFailure),
        rawReportPath: "npm-audit.json",
      });
    },
  );

  it("retries signature download failures and succeeds on the third attempt", () => {
    const result = runAuditValidation(({ targetRoot }) => {
      installFakeAuditNpm(
        targetRoot,
        {
          vulnerabilities: {},
          metadata: {
            vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
          },
        },
        0,
        [
          { output: "npm error Failed to download", status: 1 },
          { output: "npm error Failed to download", status: 1 },
          { output: "verified signatures", status: 0 },
        ],
      );
      fs.writeFileSync(path.join(targetRoot, "bin", "sleep"), "#!/bin/sh\nexit 0\n", {
        mode: 0o755,
      });
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.signatureAttemptCount, result.stderr).toBe(3);
    expect(result.signatureDebugFiles).toEqual([
      "signature-attempt-1.log",
      "signature-attempt-2.log",
    ]);
    expect(result.signatureReport).toContain("retrying transient signature download");
    expect(result.signatureReport).toContain("attempt=3 status=0");
  });

  it("does not retry an invalid signature result", () => {
    const result = runAuditValidation(({ targetRoot }) => {
      installFakeAuditNpm(
        targetRoot,
        {
          vulnerabilities: {},
          metadata: {
            vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
          },
        },
        0,
        [
          { output: "npm error Invalid registry signature", status: 1 },
          { output: "verified signatures", status: 0 },
        ],
      );
    });

    expect(result.status).not.toBe(0);
    expect(result.signatureAttemptCount, result.stderr).toBe(1);
    expect(result.signatureDebugFiles).toEqual(["signature-attempt-1.log"]);
    expect(result.signatureReport).not.toContain("retrying transient signature download");
  });
});
