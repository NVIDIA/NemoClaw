// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readYaml, type WorkflowStep } from "./helpers/e2e-workflow-contract";

const ROOT = path.resolve(import.meta.dirname, "..");
const E2E_WORKFLOW = path.join(ROOT, ".github", "workflows", "e2e.yaml");
const CHECK_SCRIPT = path.join(ROOT, "scripts", "checks", "check-cloudflared-update.sh");
const FULL_SHA_ACTION = /@[0-9a-f]{40}$/iu;

type CloudflaredUpdateWorkflow = {
  on?: {
    schedule?: Array<{ cron?: string }>;
    workflow_dispatch?: Record<string, never>;
  };
  permissions?: Record<string, string>;
  jobs?: Record<
    string,
    {
      permissions?: Record<string, string>;
      steps?: WorkflowStep[];
    }
  >;
};

function pinValues(source: string, name: string): string[] {
  return [...source.matchAll(new RegExp(`^\\s*${name}:\\s*"([^"]+)"`, "gmu"))].map(
    (match) => match[1],
  );
}

function writePinFixture(file: string, version: string, sha256: string): void {
  fs.writeFileSync(
    file,
    ["one", "two", "three"]
      .map(
        (job) =>
          `  ${job}:\n    env:\n      CLOUDFLARED_VERSION: "${version}"\n      CLOUDFLARED_DEB_SHA256: "${sha256}"`,
      )
      .join("\n"),
  );
}

function runFixtureCheck(options: { pinnedVersion: string; latestVersion: string }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cloudflared-update-"));
  const workflowPath = path.join(tempDir, "e2e.yaml");
  const releasePath = path.join(tempDir, "release.json");
  const assetPath = path.join(tempDir, "cloudflared-linux-amd64.deb");
  const curlPath = path.join(tempDir, "curl");
  const callLogPath = path.join(tempDir, "curl-calls.txt");
  const asset = Buffer.from("fixture cloudflared linux-amd64 package\n", "utf8");
  const latestSha = crypto.createHash("sha256").update(asset).digest("hex");
  const pinnedSha = options.pinnedVersion === options.latestVersion ? latestSha : "0".repeat(64);
  const apiUrl = "https://api.example.invalid/cloudflared/latest";
  const downloadBase = "https://downloads.example.invalid/cloudflared";
  const assetUrl = `${downloadBase}/${options.latestVersion}/cloudflared-linux-amd64.deb`;

  writePinFixture(workflowPath, options.pinnedVersion, pinnedSha);
  fs.writeFileSync(assetPath, asset);
  fs.writeFileSync(
    releasePath,
    JSON.stringify({
      tag_name: options.latestVersion,
      assets: [{ name: "cloudflared-linux-amd64.deb", browser_download_url: assetUrl }],
    }),
  );
  fs.writeFileSync(
    curlPath,
    `#!/usr/bin/env bash
set -euo pipefail
output=""
url=""
while (( $# > 0 )); do
  case "$1" in
    --output|-o) output="$2"; shift 2 ;;
    --header) shift 2 ;;
    --retry|--retry-delay) shift 2 ;;
    --fail|--silent|--show-error|--location|--retry-all-errors) shift ;;
    *) url="$1"; shift ;;
  esac
done
printf '%s\n' "$url" >> "$FAKE_CALL_LOG"
case "$url" in
  "$FAKE_API_URL") cp "$FAKE_RELEASE_JSON" "$output" ;;
  "$FAKE_ASSET_URL") cp "$FAKE_ASSET" "$output" ;;
  *) printf 'unexpected URL: %s\\n' "$url" >&2; exit 2 ;;
esac
`,
    { mode: 0o755 },
  );

  const result = spawnSync("bash", [CHECK_SCRIPT], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      CLOUDFLARED_CURL_BIN: curlPath,
      CLOUDFLARED_DOWNLOAD_BASE_URL: downloadBase,
      CLOUDFLARED_E2E_WORKFLOW: workflowPath,
      CLOUDFLARED_RELEASE_API_URL: apiUrl,
      FAKE_API_URL: apiUrl,
      FAKE_ASSET: assetPath,
      FAKE_ASSET_URL: assetUrl,
      FAKE_CALL_LOG: callLogPath,
      FAKE_RELEASE_JSON: releasePath,
      RUNNER_TEMP: tempDir,
    },
  });

  return { apiUrl, assetUrl, callLogPath, result, latestSha, tempDir };
}

describe("cloudflared update-check workflow contract", () => {
  const workflow = readYaml<CloudflaredUpdateWorkflow>(
    ".github/workflows/cloudflared-update-check.yaml",
  );
  const e2e = fs.readFileSync(E2E_WORKFLOW, "utf8");

  it("runs weekly and manually with read-only permissions and a credential-free checkout", () => {
    expect(workflow.on?.schedule).toEqual([{ cron: "23 13 * * 1" }]);
    expect(workflow.on?.workflow_dispatch).toEqual({});
    expect(workflow.permissions).toEqual({ contents: "read" });

    const job = workflow.jobs?.["check-cloudflared"];
    const checkout = job?.steps?.find((step) => step.uses?.startsWith("actions/checkout@"));
    const check = job?.steps?.find(
      (step) => step.name === "Compare reviewed pin with the latest upstream release",
    );
    expect(job?.permissions).toBeUndefined();
    expect(checkout?.uses).toMatch(FULL_SHA_ACTION);
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    expect(check?.run).toBe("bash scripts/checks/check-cloudflared-update.sh");
  });

  it("extracts exactly three identical reviewed version and SHA256 pins", () => {
    const versions = pinValues(e2e, "CLOUDFLARED_VERSION");
    const hashes = pinValues(e2e, "CLOUDFLARED_DEB_SHA256");
    expect(versions).toHaveLength(3);
    expect(hashes).toHaveLength(3);
    expect(new Set(versions).size).toBe(1);
    expect(new Set(hashes).size).toBe(1);
    expect(versions[0]).toMatch(/^[0-9]{4}\.[0-9]{1,2}\.[0-9]+$/u);
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("queries the upstream latest release and verifies its exact linux-amd64 asset", () => {
    const fixture = runFixtureCheck({ pinnedVersion: "2026.7.1", latestVersion: "2026.7.1" });
    try {
      expect(fixture.result.status, fixture.result.stderr).toBe(0);
      expect(fs.readFileSync(fixture.callLogPath, "utf8").trim().split("\n")).toEqual([
        fixture.apiUrl,
        fixture.assetUrl,
      ]);
    } finally {
      fs.rmSync(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it("passes only when the latest release asset matches the reviewed SHA256", () => {
    const fixture = runFixtureCheck({ pinnedVersion: "2026.7.1", latestVersion: "2026.7.1" });
    try {
      expect(fixture.result.status, fixture.result.stderr).toBe(0);
      expect(fixture.result.stdout).toContain("cloudflared pin is current");
      expect(fixture.result.stdout).toContain(fixture.latestSha);
      expect(fixture.result.stdout).toContain("OK");
    } finally {
      fs.rmSync(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it("fails an outdated pin with the latest version, hash, and all update locations", () => {
    const fixture = runFixtureCheck({ pinnedVersion: "2026.6.1", latestVersion: "2026.7.1" });
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain("cloudflared update required");
      expect(fixture.result.stderr).toContain("Pinned version: 2026.6.1");
      expect(fixture.result.stderr).toContain("Latest version: 2026.7.1");
      expect(fixture.result.stderr).toContain(
        `Latest linux-amd64.deb SHA256: ${fixture.latestSha}`,
      );
      expect(fixture.result.stderr).toContain("CLOUDFLARED_VERSION lines:");
      expect(fixture.result.stderr).toContain("CLOUDFLARED_DEB_SHA256 lines:");
      expect(fixture.result.stderr).toContain("Set all three version/SHA256 pairs");
    } finally {
      fs.rmSync(fixture.tempDir, { recursive: true, force: true });
    }
  });
});
