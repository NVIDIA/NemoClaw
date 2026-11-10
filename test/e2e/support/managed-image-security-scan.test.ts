// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  candidateReference,
  scanPassed,
} from "../../../.github/scripts/managed-image-scan-results.mts";

const root = resolve(import.meta.dirname, "../../..");
const digest = `sha256:${"a".repeat(64)}`;
const workloadDigest = `sha256:${"b".repeat(64)}`;
const env = {
  AGENT: "openclaw",
  ARCH: "amd64",
  PLATFORM: "linux/amd64",
  IMAGE: "ghcr.io/nvidia/nemoclaw/openclaw-sandbox",
  GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
  GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_SHA: "c".repeat(40),
  GITHUB_RUN_ID: "42",
  GITHUB_RUN_ATTEMPT: "2",
};
function candidate() {
  return {
    contractVersion: 2,
    phase: "candidate",
    agent: env.AGENT,
    platform: env.PLATFORM,
    image: env.IMAGE,
    digest,
    reference: `${env.IMAGE}@${digest}`,
    source: { repository: env.GITHUB_REPOSITORY, revision: env.GITHUB_SHA, ref: env.GITHUB_REF },
    run: { id: 42, attempt: 1 },
    publicationEvidence: {
      workloadDescriptor: {
        digest: workloadDigest,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        platform: { os: "linux", architecture: "amd64" },
      },
    },
  };
}

describe("Managed image scan evidence", () => {
  it("scans the workload digest retained by a successful producer attempt", () => {
    expect(candidateReference(candidate(), env)).toBe(`${env.IMAGE}@${workloadDigest}`);
  });
  it.each([
    { GITHUB_RUN_ID: "43" },
    { GITHUB_RUN_ATTEMPT: "0" },
    { GITHUB_SHA: "d".repeat(40) },
    { GITHUB_REF: "refs/tags/v1" },
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_REPOSITORY: "someone/NemoClaw" },
    { PLATFORM: "linux/arm64" },
    { IMAGE: "ghcr.io/other/image" },
    { AGENT: "hermes" },
  ])("rejects a candidate outside the publication identity: %j", (override) => {
    expect(() => candidateReference(candidate(), { ...env, ...override })).toThrow();
  });
  it("rejects a mutable workload reference", () => {
    const value = candidate();
    value.publicationEvidence.workloadDescriptor.digest = "latest";
    expect(() => candidateReference(value, env)).toThrow();
  });
  it.each(["SUSPICIOUS", "MALICIOUS", "FAILED", "PENDING", ""])(
    "blocks malware status %s even with a zero exit code",
    (status) => {
      expect(scanPassed("malware", 0, JSON.stringify({ data: { status, report: [] } }))).toBe(
        false,
      );
    },
  );
  it("requires both a clean malware report and a successful scanner process", () => {
    const clean = JSON.stringify({ data: { status: "CLEAN", report: [] } });
    expect(scanPassed("malware", 0, clean)).toBe(true);
    expect(() => scanPassed("malware", 0, '{"data":{"status":"CLEAN"}}')).toThrow();
  });
  it.each([1, 2, 4, 5, 6, 137])("blocks malware process exit %s despite a clean report", (code) => {
    expect(
      scanPassed("malware", code, JSON.stringify({ data: { status: "CLEAN", report: [] } })),
    ).toBe(false);
  });
  it.each([1, 2, 183, 137])("blocks secret scanner process exit %s", (code) => {
    expect(scanPassed("secrets", code, "")).toBe(false);
  });
  it("blocks Critical vulnerabilities and malformed findings", () => {
    const report = (severity: string) =>
      JSON.stringify({ matches: [{ vulnerability: { severity } }] });
    expect(scanPassed("vulnerabilities", 0, report("Critical"))).toBe(false);
    expect(scanPassed("vulnerabilities", 0, report("High"))).toBe(true);
    expect(scanPassed("vulnerabilities", 1, report("High"))).toBe(false);
    expect(() => scanPassed("vulnerabilities", 0, "{}")).toThrow();
  });
  it("blocks verified secrets and scanner failures while preserving allowlisted results", () => {
    const finding = JSON.stringify({ Verified: true, Raw: "must-not-be-published" });
    expect(scanPassed("secrets", 0, finding)).toBe(false);
    expect(scanPassed("secrets", 185, finding)).toBe(false);
    expect(scanPassed("secrets", 189, finding)).toBe(true);
    expect(scanPassed("secrets", 185, '{"Verified":false}')).toBe(true);
    expect(scanPassed("secrets", 0, "")).toBe(true);
    expect(() => scanPassed("secrets", 0, "{bad-json-secret}")).toThrow();
  });
});

describe("Managed image security gate", () => {
  const workflow = parse(readFileSync(join(root, ".github/workflows/managed-images.yaml"), "utf8"));
  const base = parse(readFileSync(join(root, ".github/workflows/base-image.yaml"), "utf8"));
  // source-shape-contract: security -- The promotion expression must deny incomplete selected scans before any mutable alias can move.
  it.each([
    [true, "success", true],
    [true, "failure", false],
    [true, "cancelled", false],
    [true, "skipped", false],
    [false, "success", false],
    [false, "failure", false],
    [false, "cancelled", false],
    [false, "skipped", true],
  ])(
    "evaluates promotion with scans selected %s and scan result %s",
    (requested, result, allowed) => {
      const expression = workflow.jobs.promote.if
        .replace(/\$\{\{|\}\}/gu, "")
        .replace(/needs\.([a-z-]+)/gu, 'needs["$1"]');
      const needs = {
        "publication-identity": { result: "success" },
        "build-and-validate": { result: "success" },
        "security-scan-managed-images": { result },
      };
      const gate = new Function("cancelled", "inputs", "needs", `return (${expression});`);
      expect(gate(() => false, { run_security_scans: requested }, needs)).toBe(allowed);
      expect(gate(() => true, { run_security_scans: requested }, needs)).toBe(false);
    },
  );
  // source-shape-contract: security -- Every published agent and architecture must enter the optional scan gate through the same inventory.
  it("keeps scans optional and reuses the complete publication inventory", () => {
    expect(base.on.workflow_dispatch.inputs.run_security_scans.default).toBe(false);
    expect(workflow.on.workflow_call.inputs.run_security_scans.default).toBe(false);
    expect(workflow.jobs["security-scan-managed-images"].strategy.matrix).toEqual(
      workflow.jobs["build-and-validate"].strategy.matrix,
    );
    expect(workflow.jobs["security-scan-managed-images"].strategy.matrix.include).toHaveLength(6);
    expect(workflow.jobs.promote.needs).toContain("security-scan-managed-images");
  });
  it.each([0, 5])(
    "runs container scans and removes private reports (malware exit %s)",
    (malwareExit) => {
      const temporary = mkdtempSync(join(tmpdir(), "managed-scan-test-"));
      try {
        const bin = join(temporary, "bin");
        const scan = join(temporary, "scan");
        mkdirSync(bin);
        mkdirSync(scan);
        const contract = join(temporary, "contract.json");
        writeFileSync(contract, JSON.stringify(candidate()));
        writeFileSync(
          join(bin, "docker"),
          `#!/bin/sh
case "$1" in
  image) printf '%s' '${workloadDigest}' ;;
  pull|save|rm|ps|create) exit 0 ;;
  run)
    case "$*" in
      *grype-image*) printf '%s' '{"matches":[]}' ;;
      *secret-image*) printf '%s' '{"Verified":false,"Raw":"private-marker"}' ;;
      *) exit 99 ;;
    esac ;;
  start) printf '%s' 'private-marker'; exit ${malwareExit} ;;
  cp) printf '%s' '{"data":{"status":"CLEAN","report":[]}}' > "$3" ;;
  *) exit 99 ;;
esac
`,
          { mode: 0o700 },
        );
        const summary = join(temporary, "summary.md");
        const result = spawnSync("bash", [join(root, ".github/scripts/scan-managed-image.sh")], {
          encoding: "utf8",
          env: {
            ...env,
            PATH: `${bin}:${process.env.PATH}`,
            HOME: temporary,
            GITHUB_WORKSPACE: root,
            GITHUB_STEP_SUMMARY: summary,
            SCAN_ROOT: scan,
            CONTRACT: contract,
            GRYPE_IMAGE: "grype-image",
            PULSE_SECRET_IMAGE: "secret-image",
            PULSE_MALWARE_IMAGE: "malware-image",
            NSPECT_ID: "NSPECT-TEST-1234",
          },
        });
        expect(result.status, result.stderr).toBe(malwareExit === 0 ? 0 : 1);
        const report = readFileSync(summary, "utf8");
        expect(report).toContain(`| malware | ${malwareExit === 0 ? "PASS" : "FAIL"} |`);
        expect(report + result.stdout + result.stderr).not.toContain("private-marker");
        expect(() => readFileSync(join(scan, "secrets.jsonl"))).toThrow();
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    },
  );
});
