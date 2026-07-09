// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildConfig } from "../scripts/generate-openclaw-config.mts";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const OPENCLAW_AUDIT_TIMEOUT_MS = 120_000;
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
  suppressedFindings: AuditFinding[];
}

function reviewedOpenClawVersion(): string {
  const dockerfile = fs.readFileSync(path.join(REPO_ROOT, "Dockerfile"), "utf-8");
  const version = dockerfile.match(/^ARG OPENCLAW_VERSION=([^\s]+)/m)?.[1];
  if (!version) throw new Error("Dockerfile is missing ARG OPENCLAW_VERSION");
  return version;
}

function runOpenClawAudit(chatUiUrl: string): AuditResult {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-audit-"));
  const home = path.join(tmp, "home");
  const configDir = path.join(home, ".openclaw");
  const cache = process.env.NEMOCLAW_REAL_OPENCLAW_AUDIT_NPM_CACHE || path.join(tmp, "npm-cache");
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(configDir, "openclaw.json"),
    JSON.stringify(buildConfig({ ...BASE_ENV, CHAT_UI_URL: chatUiUrl })),
    { mode: 0o600 },
  );

  try {
    const version = reviewedOpenClawVersion();
    const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home, NPM_CONFIG_CACHE: cache };
    for (const key of Object.keys(childEnv)) {
      if (key.startsWith("VITEST") || key === "NODE_ENV") delete childEnv[key];
    }
    const audit = spawnSync(
      "npm",
      [
        "exec",
        "--yes",
        `--package=openclaw@${version}`,
        "--",
        "openclaw",
        "security",
        "audit",
        "--json",
      ],
      {
        encoding: "utf-8",
        env: childEnv,
        maxBuffer: 10 * 1024 * 1024,
        timeout: OPENCLAW_AUDIT_TIMEOUT_MS,
      },
    );
    if (audit.error || audit.status !== 0 || !audit.stdout.trim()) {
      throw new Error(
        `OpenClaw audit failed: ${audit.error?.message || audit.stderr || audit.stdout || "empty output"}`,
      );
    }
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

describe.skipIf(process.env.NEMOCLAW_REAL_OPENCLAW_AUDIT_HARNESS !== "1")(
  "OpenClaw managed security audit consumer contract",
  () => {
    it(
      "suppresses only exact managed findings while preserving active risks (#6024)",
      () => {
        const loopback = runOpenClawAudit("http://127.0.0.1:18789");
        const suppressedDirect = loopback.suppressedFindings.find(
          (finding) => finding.checkId === "gateway.control_ui.insecure_auth",
        );
        expect(suppressedDirect).toMatchObject({
          severity: "warn",
          remediation: expect.stringContaining("HTTPS"),
          suppression: { reason: expect.stringContaining("loopback HTTP CHAT_UI_URL") },
        });
        expect(
          findingForFlag(loopback.suppressedFindings, "gateway.controlUi.allowInsecureAuth=true"),
        ).toMatchObject({
          severity: "warn",
          remediation: expect.any(String),
          suppression: { reason: expect.stringContaining("loopback HTTP CHAT_UI_URL") },
        });
        expect(
          loopback.findings.some((finding) => finding.checkId === "gateway.loopback_no_auth"),
        ).toBe(true);

        const remote = runOpenClawAudit("http://remote.example:18789");
        expect(
          remote.findings.some((finding) => finding.checkId === "gateway.control_ui.insecure_auth"),
        ).toBe(true);
        expect(
          findingForFlag(remote.findings, "gateway.controlUi.allowInsecureAuth=true"),
        ).toBeDefined();
        expect(
          remote.suppressedFindings.some(
            (finding) => finding.checkId === "gateway.control_ui.device_auth_disabled",
          ),
        ).toBe(true);
      },
      OPENCLAW_AUDIT_TIMEOUT_MS,
    );
  },
);
