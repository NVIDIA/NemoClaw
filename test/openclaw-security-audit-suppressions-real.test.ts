// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildConfig } from "../scripts/generate-openclaw-config.mts";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const OPENCLAW_AUDIT_TIMEOUT_MS = 120_000;
const OPENCLAW_AUDIT_SUITE_TIMEOUT_MS = OPENCLAW_AUDIT_TIMEOUT_MS * 7;
const BASE_ENV: Record<string, string> = {
  NEMOCLAW_MODEL: "test-model",
  NEMOCLAW_PROVIDER_KEY: "test-provider",
  NEMOCLAW_PRIMARY_MODEL_REF: "test-provider/test-model",
  NEMOCLAW_INFERENCE_BASE_URL: "http://127.0.0.1:8000/v1",
  NEMOCLAW_INFERENCE_API: "openai-completions",
};

interface AuditFinding {
  checkId: string;
  severity: string;
  detail: string;
  remediation?: string;
  suppression?: { reason?: string };
}

interface AuditResult {
  findings: AuditFinding[];
  suppressedFindings?: AuditFinding[];
}

interface ReviewedOpenClawPackage {
  integrity: string;
  tarball: string;
  version: string;
}

function reviewedOpenClawPackage(): ReviewedOpenClawPackage {
  const dockerfile = fs.readFileSync(path.join(REPO_ROOT, "Dockerfile"), "utf-8");
  const version = dockerfile.match(/^ARG OPENCLAW_VERSION=([^\s]+)/m)?.[1];
  assert.ok(version, "Dockerfile is missing ARG OPENCLAW_VERSION");
  const pinKey = version.replaceAll(".", "_");
  const integrity = dockerfile.match(
    new RegExp(`^ARG OPENCLAW_${pinKey}_INTEGRITY=([^\\s]+)`, "m"),
  )?.[1];
  const tarball = dockerfile.match(
    new RegExp(`^ARG OPENCLAW_${pinKey}_TARBALL=([^\\s]+)`, "m"),
  )?.[1];
  assert.ok(integrity, `Dockerfile is missing the OpenClaw ${version} integrity pin`);
  assert.ok(tarball, `Dockerfile is missing the OpenClaw ${version} tarball pin`);
  return { integrity, tarball, version };
}

function installReviewedOpenClaw(workspace: string): string {
  const reviewed = reviewedOpenClawPackage();
  const runtime = path.join(workspace, "runtime");
  const childEnv: NodeJS.ProcessEnv = {
    HOME: path.join(workspace, "npm-home"),
    NPM_CONFIG_CACHE: path.join(workspace, "npm-cache"),
    NPM_CONFIG_FETCH_RETRIES: "3",
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT: "10000",
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT: "60000",
    PATH: process.env.PATH,
  };
  const packed = spawnSync(
    "npm",
    ["pack", reviewed.tarball, "--pack-destination", workspace, "--json"],
    {
      encoding: "utf-8",
      env: childEnv,
      maxBuffer: 10 * 1024 * 1024,
      timeout: OPENCLAW_AUDIT_TIMEOUT_MS,
    },
  );
  const packFailure = packed.error?.message || packed.stderr || packed.stdout || "empty output";
  assert.equal(packed.error, undefined, `OpenClaw npm pack failed: ${packFailure}`);
  assert.equal(packed.status, 0, `OpenClaw npm pack failed: ${packFailure}`);
  assert.ok(packed.stdout.trim(), `OpenClaw npm pack failed: ${packFailure}`);
  const packResult = JSON.parse(packed.stdout)[0] as { filename?: string; integrity?: string };
  assert.equal(packResult.integrity, reviewed.integrity, "OpenClaw tarball integrity mismatch");
  assert.ok(packResult.filename, "OpenClaw npm pack omitted the archive filename");
  assert.equal(path.basename(packResult.filename), packResult.filename, "Unsafe npm pack filename");
  const archive = path.resolve(workspace, packResult.filename);
  assert.ok(
    archive.startsWith(`${path.resolve(workspace)}${path.sep}`),
    "OpenClaw archive escaped workspace",
  );
  const installed = spawnSync(
    "npm",
    ["install", "--prefix", runtime, "--ignore-scripts", "--no-audit", "--no-fund", archive],
    {
      encoding: "utf-8",
      env: childEnv,
      maxBuffer: 10 * 1024 * 1024,
      timeout: OPENCLAW_AUDIT_TIMEOUT_MS,
    },
  );
  const installFailure =
    installed.error?.message || installed.stderr || installed.stdout || "empty output";
  assert.equal(installed.error, undefined, `OpenClaw install failed: ${installFailure}`);
  assert.equal(installed.status, 0, `OpenClaw install failed: ${installFailure}`);
  const binary = path.join(runtime, "node_modules", ".bin", "openclaw");
  assert.ok(fs.existsSync(binary), "Reviewed OpenClaw install omitted its CLI binary");
  return binary;
}

function runOpenClawAudit(
  binary: string,
  chatUiUrl: string,
  overrides: Record<string, string> = {},
): AuditResult {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-audit-"));
  try {
    const home = path.join(tmp, "home");
    const configDir = path.join(home, ".openclaw");
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(configDir, "openclaw.json"),
      JSON.stringify(buildConfig({ ...BASE_ENV, CHAT_UI_URL: chatUiUrl, ...overrides })),
      { mode: 0o600 },
    );
    const audit = spawnSync(binary, ["security", "audit", "--json"], {
      encoding: "utf-8",
      env: { HOME: home, PATH: process.env.PATH },
      maxBuffer: 10 * 1024 * 1024,
      timeout: OPENCLAW_AUDIT_TIMEOUT_MS,
    });
    const auditFailure = audit.error?.message || audit.stderr || audit.stdout || "empty output";
    assert.equal(audit.error, undefined, `OpenClaw audit failed: ${auditFailure}`);
    assert.equal(audit.status, 0, `OpenClaw audit failed: ${auditFailure}`);
    assert.ok(audit.stdout.trim(), `OpenClaw audit failed: ${auditFailure}`);
    return JSON.parse(audit.stdout) as AuditResult;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function findingForFlag(findings: AuditFinding[], flag: string): AuditFinding | undefined {
  return findings.find(
    (finding) =>
      finding.checkId === "config.insecure_or_dangerous_flags" && finding.detail.includes(flag),
  );
}

function managedAuthFindings(findings: AuditFinding[]): AuditFinding[] {
  return findings.filter(
    (finding) =>
      finding.checkId === "gateway.control_ui.insecure_auth" ||
      finding.checkId === "gateway.control_ui.device_auth_disabled" ||
      findingForFlag([finding], "gateway.controlUi.allowInsecureAuth=true") !== undefined ||
      findingForFlag([finding], "gateway.controlUi.dangerouslyDisableDeviceAuth=true") !==
        undefined,
  );
}

describe.skipIf(process.env.NEMOCLAW_REAL_OPENCLAW_AUDIT_HARNESS !== "1")(
  "OpenClaw managed security audit consumer contract",
  () => {
    it(
      "pins exact OpenClaw checkIds while suppressing only managed findings (#6024)",
      () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-audit-suite-"));
        try {
          const binary = installReviewedOpenClaw(workspace);
          const loopback = runOpenClawAudit(binary, "http://127.0.0.1:18789");
          const loopbackSuppressions = loopback.suppressedFindings ?? [];
          const suppressedDirect = loopbackSuppressions.find(
            (finding) => finding.checkId === "gateway.control_ui.insecure_auth",
          );
          expect(suppressedDirect).toMatchObject({
            severity: "warn",
            remediation: expect.stringContaining("HTTPS"),
            suppression: { reason: expect.stringContaining("loopback HTTP CHAT_UI_URL") },
          });
          expect(
            findingForFlag(loopbackSuppressions, "gateway.controlUi.allowInsecureAuth=true"),
          ).toMatchObject({
            severity: "warn",
            remediation: expect.any(String),
            suppression: { reason: expect.stringContaining("loopback HTTP CHAT_UI_URL") },
          });
          expect(
            loopback.findings.some((finding) => finding.checkId === "gateway.loopback_no_auth"),
          ).toBe(true);

          const remoteOnboard = runOpenClawAudit(binary, "http://remote.example:18789", {
            NEMOCLAW_DISABLE_DEVICE_AUTH: "1",
          });
          expect(
            remoteOnboard.findings.some(
              (finding) => finding.checkId === "gateway.control_ui.insecure_auth",
            ),
          ).toBe(true);
          expect(
            findingForFlag(remoteOnboard.findings, "gateway.controlUi.allowInsecureAuth=true"),
          ).toBeDefined();
          expect(
            remoteOnboard.findings.some(
              (finding) => finding.checkId === "gateway.control_ui.device_auth_disabled",
            ),
          ).toBe(true);
          expect(
            findingForFlag(
              remoteOnboard.findings,
              "gateway.controlUi.dangerouslyDisableDeviceAuth=true",
            ),
          ).toBeDefined();
          expect(managedAuthFindings(remoteOnboard.findings)).toHaveLength(4);
          expect(remoteOnboard.suppressedFindings ?? []).toHaveLength(0);

          const remoteWithoutOptOut = runOpenClawAudit(binary, "http://remote.example:18789");
          expect(managedAuthFindings(remoteWithoutOptOut.findings)).toHaveLength(4);
          expect(remoteWithoutOptOut.suppressedFindings ?? []).toHaveLength(0);

          const remoteHttpsOnboard = runOpenClawAudit(binary, "https://remote.example:18789", {
            NEMOCLAW_DISABLE_DEVICE_AUTH: "1",
          });
          expect(managedAuthFindings(remoteHttpsOnboard.findings)).toHaveLength(2);
          expect(
            remoteHttpsOnboard.findings.some(
              (finding) => finding.checkId === "gateway.control_ui.device_auth_disabled",
            ),
          ).toBe(true);
          expect(
            findingForFlag(
              remoteHttpsOnboard.findings,
              "gateway.controlUi.dangerouslyDisableDeviceAuth=true",
            ),
          ).toBeDefined();
          expect(
            remoteHttpsOnboard.findings.some(
              (finding) => finding.checkId === "gateway.control_ui.insecure_auth",
            ),
          ).toBe(false);
          expect(remoteHttpsOnboard.suppressedFindings ?? []).toHaveLength(0);

          const remoteBindOnboard = runOpenClawAudit(binary, "http://127.0.0.1:18789", {
            NEMOCLAW_DASHBOARD_BIND: "0.0.0.0",
          });
          expect(managedAuthFindings(remoteBindOnboard.findings)).toHaveLength(4);
          expect(
            remoteBindOnboard.findings.some(
              (finding) => finding.checkId === "gateway.control_ui.insecure_auth",
            ),
          ).toBe(true);
          expect(
            remoteBindOnboard.findings.some(
              (finding) => finding.checkId === "gateway.control_ui.device_auth_disabled",
            ),
          ).toBe(true);
          expect(
            findingForFlag(remoteBindOnboard.findings, "gateway.controlUi.allowInsecureAuth=true"),
          ).toBeDefined();
          expect(
            findingForFlag(
              remoteBindOnboard.findings,
              "gateway.controlUi.dangerouslyDisableDeviceAuth=true",
            ),
          ).toBeDefined();
          expect(
            findingForFlag(
              remoteBindOnboard.findings,
              "gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true",
            ),
          ).toBeDefined();
          expect(remoteBindOnboard.suppressedFindings ?? []).toHaveLength(0);

          const explicitOptOut = runOpenClawAudit(binary, "https://127.0.0.1:18789", {
            NEMOCLAW_DISABLE_DEVICE_AUTH: "1",
            NEMOCLAW_DEVICE_AUTH_OPT_OUT_SOURCE: "operator",
          });
          expect(
            explicitOptOut.findings.find(
              (finding) => finding.checkId === "gateway.control_ui.device_auth_disabled",
            ),
          ).toMatchObject({
            severity: "critical",
            remediation: expect.any(String),
          });
          expect(
            findingForFlag(
              explicitOptOut.findings,
              "gateway.controlUi.dangerouslyDisableDeviceAuth=true",
            ),
          ).toBeDefined();
          expect(explicitOptOut.suppressedFindings ?? []).toHaveLength(0);
        } finally {
          fs.rmSync(workspace, { recursive: true, force: true });
        }
      },
      OPENCLAW_AUDIT_SUITE_TIMEOUT_MS,
    );
  },
);
