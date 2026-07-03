// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression for issue #4497 (reopened): stale sandbox rebuild recovery.
 *
 * Reporter workflow:
 *   1. A sandbox is registered locally but its live OpenShell/Docker state has
 *      diverged (stuck/stale provision, container reaped) — it no longer shows
 *      up in `openshell sandbox list`.
 *   2. `status` prints a `rebuild --yes` recovery hint.
 *   3. `connect` runs and (after PR #4647) preserves the registry entry.
 *   4. The user runs the recommended `rebuild --yes`.
 *
 * The first fix (PR #4647) stopped `connect` from deleting the registry entry,
 * but `rebuild` still aborted at the backup step with
 * "Sandbox '<name>' is not running. Cannot back up state." whenever the live
 * sandbox was absent — which is precisely the stale-recovery state. That left
 * the recommended recovery path dead-ended.
 *
 * This suite asserts that `rebuild --yes` now treats a registered-but-not-live
 * sandbox as a recovery rebuild: it skips the (impossible) backup, reports the
 * stale state, and proceeds to recreate from the preserved registry metadata.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const NODE_BIN = path.dirname(process.execPath);
const tmpFixtures: string[] = [];

afterEach(() => {
  for (const dir of tmpFixtures.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
});

/**
 * Build a temp HOME whose registry holds `my-assistant`, whose onboard session
 * matches it, and whose fake `openshell sandbox list` returns EMPTY — modelling
 * the stale state where the live gateway no longer knows the sandbox.
 */
function createStaleFixture(
  opts: {
    liveListIncludesSandbox?: boolean;
    foreignGatewayActive?: boolean;
    gatewayName?: string | null;
  } = {},
) {
  const {
    liveListIncludesSandbox = false,
    foreignGatewayActive = false,
    gatewayName = null,
  } = opts;
  const sandboxName = "my-assistant";
  const provider = "nvidia-prod";
  const credentialEnv = "NVIDIA_INFERENCE_API_KEY";
  const targetGatewayName = gatewayName ?? "nemoclaw";
  const targetGatewayPort = targetGatewayName === "nemoclaw-9000" ? 9000 : 8080;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-4497-"));
  tmpFixtures.push(tmpDir);
  const nemoclawDir = path.join(tmpDir, ".nemoclaw");
  fs.mkdirSync(nemoclawDir, { recursive: true, mode: 0o700 });

  fs.writeFileSync(
    path.join(nemoclawDir, "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: sandboxName,
      sandboxes: {
        [sandboxName]: {
          name: sandboxName,
          model: "meta/llama-3.3-70b-instruct",
          provider,
          gpuEnabled: false,
          sandboxGpuMode: "0",
          gatewayName: targetGatewayName,
          gatewayPort: targetGatewayPort,
          dashboardPort: 28789,
          fromDockerfile: null,
          policies: [],
          agent: null,
        },
      },
    }),
    { mode: 0o600 },
  );

  fs.writeFileSync(
    path.join(nemoclawDir, "onboard-session.json"),
    JSON.stringify({
      version: 1,
      sessionId: "s",
      resumable: true,
      status: "complete",
      mode: "interactive",
      startedAt: "2026-01-01",
      updatedAt: "2026-01-01",
      lastStepStarted: null,
      lastCompletedStep: "policies",
      failure: null,
      agent: null,
      sandboxName,
      provider,
      model: "meta/llama-3.3-70b-instruct",
      endpointUrl: null,
      credentialEnv,
      hermesAuthMethod: null,
      preferredInferenceApi: null,
      nimContainer: null,
      webSearchConfig: null,
      policyPresets: [],
      messagingPlan: null,
      metadata: { gatewayName: targetGatewayName, fromDockerfile: null },
      steps: {},
    }),
    { mode: 0o600 },
  );

  // Provider credential present so the rebuild preflight passes and we reach
  // the liveness check that this regression targets.
  fs.writeFileSync(
    path.join(nemoclawDir, "credentials.json"),
    JSON.stringify({ [credentialEnv]: "nvapi-test-key-for-rebuild" }),
    { mode: 0o600 },
  );

  // Fake openshell. `sandbox list` returns empty (stale) unless the test asks
  // for the live-present control case. `gateway info`/`status` report a healthy
  // named gateway so the rebuild does not bail on gateway recovery first.
  const listBody = liveListIncludesSandbox
    ? `process.stdout.write("${sandboxName}\\n"); process.exit(0);`
    : `process.stdout.write("\\n"); process.exit(0);`;
  // The authoritative target preflights run before liveness reconciliation.
  // Report the recorded target as healthy until `sandbox list` is queried,
  // then expose the drift that these guard tests are specifically exercising.
  const healthyTargetStatus = `process.stdout.write("Server Status\\n\\n  Gateway: ${targetGatewayName}\\n  Server: http://127.0.0.1:${targetGatewayPort}\\n  Status: Connected\\n"); process.exit(0);`;
  const lateDriftStatus = foreignGatewayActive
    ? `process.stdout.write("Server Status\\n\\n  Gateway: other-gw\\n  Server: http://127.0.0.1:9090\\n  Status: Connected\\n"); process.exit(0);`
    : gatewayName
      ? `process.stdout.write("Server Status\\n\\n  Gateway: nemoclaw\\n  Server: http://127.0.0.1:8080\\n  Status: Connected\\n"); process.exit(0);`
      : healthyTargetStatus;
  const livenessProbeMarker = path.join(tmpDir, "sandbox-list-probed");
  fs.writeFileSync(
    path.join(tmpDir, "openshell"),
    `#!/usr/bin/env node
const fs = require("fs");
const a = process.argv.slice(2);
const requiredFeatures = "request-body-credential-rewrite websocket-credential-rewrite allow_all_known_mcp_methods";
const livenessProbeMarker = ${JSON.stringify(livenessProbeMarker)};
if (a[0]==="-V" || a[0]==="--version")       { process.stdout.write("openshell 0.0.72\\n"); process.exit(0); }
if (a[0]==="sandbox" && a[1]==="list")       { fs.writeFileSync(livenessProbeMarker, "1"); ${listBody} }
if (a[0]==="sandbox" && a[1]==="delete")     { process.exit(0); }
if (a[0]==="sandbox" && a[1]==="get")        { process.stderr.write("Error:   × Not Found: sandbox not found\\n"); process.exit(1); }
if (a[0]==="status")                         { if (fs.existsSync(livenessProbeMarker)) { ${lateDriftStatus} } ${healthyTargetStatus} }
if (a[0]==="gateway" && a[1]==="info")       { process.stdout.write("Gateway Info\\n\\nGateway: ${targetGatewayName}\\nGateway endpoint: https://127.0.0.1:${targetGatewayPort}/\\n"); process.exit(0); }
if (a[0]==="gateway" && a[1]==="select")     { process.exit(0); }
if (a[0]==="gateway")                        { process.stdout.write("${targetGatewayName}\\n"); process.exit(0); }
if (a[0]==="inference" && a[1]==="get")      { process.stdout.write("Gateway inference:\\n  Provider: ${provider}\\n  Model: meta/llama-3.3-70b-instruct\\n"); process.exit(0); }
if (a[0]==="provider" && a[1]==="get")       { process.exit(0); }
process.exit(0);
`,
    { mode: 0o755 },
  );
  for (const component of ["openshell-gateway", "openshell-sandbox"]) {
    fs.writeFileSync(
      path.join(tmpDir, component),
      `#!/usr/bin/env node
const requiredFeatures = "request-body-credential-rewrite websocket-credential-rewrite allow_all_known_mcp_methods";
if (process.argv[2] === "-V" || process.argv[2] === "--version") process.stdout.write("${component} 0.0.72\\n");
process.exit(0);
`,
      { mode: 0o755 },
    );
  }

  // Fake docker — recreate path may shell out; succeed on common probes.
  fs.writeFileSync(
    path.join(tmpDir, "docker"),
    `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0]==="info") {
  process.stdout.write(JSON.stringify({ServerVersion:"27.0.0", OperatingSystem:"Docker Engine", NCPU:8, MemTotal:17179869184}) + "\\n");
  process.exit(0);
}
if (a[0]==="build") { process.exit(0); }
if (a[0]==="image" && a[1]==="inspect") {
  const formatIndex = a.indexOf("--format");
  const format = formatIndex >= 0 ? a[formatIndex + 1] : "";
  if (format === "{{.Id}}") process.stdout.write("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n");
  if (format === "{{json .RepoDigests}}") process.stdout.write("[]\\n");
  process.exit(0);
}
if (a[0]==="tag" || a[0]==="rmi") { process.exit(0); }
if (a[0]==="run") {
  if (a.includes("nslookup")) process.stdout.write("Server: 127.0.0.11\\n** server can't find nemoclaw.invalid: NXDOMAIN\\n");
  else if (a.includes("/usr/bin/ldd")) process.stdout.write("ldd (GNU libc) 2.41\\n");
  process.exit(0);
}
if (a[0]==="inspect") { process.stdout.write("true\\n"); process.exit(0); }
if (a[0]==="ps") { process.exit(0); }
process.exit(0);
`,
    { mode: 0o755 },
  );

  return { tmpDir, nemoclawDir, sandboxName };
}

function runRebuild(fixture: { tmpDir: string; sandboxName: string }) {
  return spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "bin", "nemoclaw.js"), fixture.sandboxName, "rebuild", "--yes"],
    {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: {
        HOME: fixture.tmpDir,
        PATH: fixture.tmpDir + ":" + NODE_BIN + ":/usr/bin:/bin",
        NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
        NEMOCLAW_SKIP_HOST_DNS_PREFLIGHT: "1",
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_NO_CONNECT_HINT: "1",
        NO_COLOR: "1",
      },
      timeout: 60_000,
    },
  );
}

function registryHasSandbox(fixture: { nemoclawDir: string; sandboxName: string }): boolean {
  const regPath = path.join(fixture.nemoclawDir, "sandboxes.json");
  if (!fs.existsSync(regPath)) return false;
  try {
    const reg = JSON.parse(fs.readFileSync(regPath, "utf-8"));
    return Boolean(reg.sandboxes?.[fixture.sandboxName]);
  } catch {
    return false;
  }
}

describe("stale sandbox rebuild recovery (#4497)", () => {
  it("does NOT abort with 'Cannot back up state' when the live sandbox is gone", {
    timeout: 90_000,
  }, () => {
    const f = createStaleFixture({ liveListIncludesSandbox: false });
    const result = runRebuild(f);
    const output = (result.stderr || "") + (result.stdout || "");

    // The pre-fix dead-end must be gone.
    expect(output).not.toContain("Cannot back up state");
    expect(output).not.toContain("is not running. Cannot back up state");
  });

  it("reports the stale state and recreates from preserved registry metadata", {
    timeout: 90_000,
  }, () => {
    const f = createStaleFixture({ liveListIncludesSandbox: false });
    const result = runRebuild(f);
    const output = (result.stderr || "") + (result.stdout || "");

    // Surfaces the recovery state to the operator.
    expect(output).toContain("absent from the live OpenShell gateway");
    expect(output).toContain("No live workspace state to back up");
    // Skips the (impossible) backup step entirely.
    expect(output).not.toContain("Backing up sandbox state");
    // Proceeds to recreate — this line is printed right before onboard() runs,
    // proving the rebuild crossed the backup gate that previously blocked it.
    expect(output).toContain("Creating new sandbox with current image");
  });

  it("still backs up normally when the live sandbox IS present (control case)", {
    timeout: 90_000,
  }, () => {
    const f = createStaleFixture({ liveListIncludesSandbox: true });
    const result = runRebuild(f);
    const output = (result.stderr || "") + (result.stdout || "");

    // Live sandbox present → normal backup path, not stale recovery.
    expect(output).toContain("Backing up sandbox state");
    expect(output).not.toContain("absent from the live OpenShell gateway");
  });

  it("does NOT destroy/recreate when a foreign gateway is active (multi-gateway guard)", {
    timeout: 90_000,
  }, () => {
    // A different OpenShell gateway is active, so the sandbox is missing from
    // the active gateway's list — but it may still be live on the named
    // nemoclaw gateway. Rebuild must reconcile against the named gateway and
    // refuse to recreate from scratch, or it would destroy live workspace
    // state in multi-gateway setups (#4497 / #4645).
    const f = createStaleFixture({ foreignGatewayActive: true });
    const result = runRebuild(f);
    const output = (result.stderr || "") + (result.stdout || "");

    // Must NOT take the destructive stale-recovery path.
    expect(output).not.toContain("No live workspace state to back up");
    expect(output).not.toContain("Deleting old sandbox");
    expect(output).not.toContain("Creating new sandbox with current image");
    // Must surface the wrong-gateway guidance and preserve the registry entry.
    expect(output).toContain("NOT been removed");
    expect(registryHasSandbox(f)).toBe(true);
  });

  it("does NOT stale-recover a sandbox recorded on a non-default per-port gateway", {
    timeout: 90_000,
  }, () => {
    // The sandbox was created on a non-default gateway (#4645). It is absent
    // from the active (default) gateway's list, but its live workspace may be
    // intact on its own gateway. Rebuild must not recreate-from-scratch on the
    // wrong gateway; it must point the operator at the recorded gateway and
    // preserve the registry entry.
    const f = createStaleFixture({ gatewayName: "nemoclaw-9000" });
    const result = runRebuild(f);
    const output = (result.stderr || "") + (result.stdout || "");

    expect(output).not.toContain("No live workspace state to back up");
    expect(output).not.toContain("Deleting old sandbox");
    expect(output).not.toContain("Creating new sandbox with current image");
    expect(output).toContain("openshell gateway select nemoclaw-9000");
    expect(registryHasSandbox(f)).toBe(true);
  });

  it("preserves the registry entry when the recovery recreate fails", { timeout: 90_000 }, () => {
    // Stale recovery removes the registry entry before the recreate (the
    // recreate re-adds it on success). The fixture's onboard --resume cannot
    // complete, so the recreate fails — the entry must be restored so the
    // recommended `rebuild --yes` stays retryable instead of failing at
    // dispatch with "not found in registry" (#4497).
    const f = createStaleFixture({ liveListIncludesSandbox: false });
    const result = runRebuild(f);
    const output = (result.stderr || "") + (result.stdout || "");

    // Proof we took the stale-recovery path and the recreate did not succeed.
    expect(output).toContain("No live workspace state to back up");
    expect(output).toContain("Recovery recreate failed");
    // The preserved entry must survive the failed recreate, and the full
    // registry snapshot (including defaultSandbox) must be restored verbatim.
    expect(registryHasSandbox(f)).toBe(true);
    const reg = JSON.parse(fs.readFileSync(path.join(f.nemoclawDir, "sandboxes.json"), "utf-8"));
    expect(reg.defaultSandbox).toBe(f.sandboxName);
  });
});
