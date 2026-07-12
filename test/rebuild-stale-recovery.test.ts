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
import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
} from "./helpers/rebuild-flow-test-harness";

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

installRebuildFlowTestHooks();

/**
 * Build a temp HOME whose registry holds `my-assistant`, whose onboard session
 * matches it, and whose fake `openshell sandbox list` returns EMPTY — modelling
 * the stale state where the live gateway no longer knows the sandbox.
 */
function createStaleFixture({ failSandboxCreate = false }: { failSandboxCreate?: boolean } = {}) {
  const sandboxName = "my-assistant";
  const provider = "nvidia-prod";
  const credentialEnv = "NVIDIA_INFERENCE_API_KEY";
  const targetGatewayName = "nemoclaw";
  const targetGatewayPort = 8080;

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

  // Fake openshell. `sandbox list` returns empty while `gateway info`/`status`
  // report a healthy named gateway, modelling a genuinely stale sandbox.
  const healthyTargetStatus = `process.stdout.write("Server Status\\n\\n  Gateway: ${targetGatewayName}\\n  Server: http://127.0.0.1:${targetGatewayPort}\\n  Status: Connected\\n"); process.exit(0);`;
  fs.writeFileSync(
    path.join(tmpDir, "openshell"),
    `#!/usr/bin/env node
const a = process.argv.slice(2);
const requiredFeatures = "request-body-credential-rewrite websocket-credential-rewrite allow_all_known_mcp_methods";
if (a[0]==="-V" || a[0]==="--version")       { process.stdout.write("openshell 0.0.72\\n"); process.exit(0); }
if (a[0]==="sandbox" && a[1]==="list")       { process.stdout.write("\\n"); process.exit(0); }
if (a[0]==="sandbox" && a[1]==="delete")     { process.exit(0); }
if (a[0]==="sandbox" && a[1]==="create" && ${JSON.stringify(failSandboxCreate)}) { process.stderr.write("injected sandbox create failure\\n"); process.exit(1); }
if (a[0]==="sandbox" && a[1]==="get")        { process.stderr.write("Error:   × Not Found: sandbox not found\\n"); process.exit(1); }
if (a[0]==="status")                         { ${healthyTargetStatus} }
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

function readRegistry(fixture: { nemoclawDir: string }) {
  return JSON.parse(fs.readFileSync(path.join(fixture.nemoclawDir, "sandboxes.json"), "utf-8"));
}

describe("stale sandbox rebuild recovery (#4497)", () => {
  it("still backs up normally when the live sandbox IS present (control case)", async () => {
    const harness = createRebuildFlowHarness();

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");

    // Live sandbox present → normal backup path, not stale recovery.
    expect(output).toContain("Backing up sandbox state");
    expect(output).not.toContain("absent from the live OpenShell gateway");
    expect(harness.backupSandboxStateSpy).toHaveBeenCalledOnce();
  });

  it("recreates an absent sandbox from its preserved registry metadata", async () => {
    const harness = createRebuildFlowHarness({
      staleRecovery: true,
      onboard: () => undefined,
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");

    expect(output).toContain("absent from the live OpenShell gateway");
    expect(output).toContain("No live workspace state to back up");
    expect(output).toContain("Creating new sandbox with current image");
    expect(output).toContain("rebuilt successfully");
    expect(output).toContain("Recovered from a stale registry entry");
    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.restoreSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.prepareMcpBridgesForAbsentSandboxRebuildSpy).toHaveBeenCalledWith("alpha");
    expect(harness.onboardSpy).toHaveBeenCalledOnce();
    expect(harness.onboardSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        resume: true,
        nonInteractive: true,
        recreateSandbox: true,
        authoritativeResumeConfig: true,
        autoYes: true,
        controlUiPort: 18789,
        targetGatewayName: "nemoclaw",
        targetGatewayPort: 8080,
      }),
    );
    expect(harness.removeSandboxRegistryEntryWithReceiptSpy).toHaveBeenCalledOnce();
    expect(harness.restoreSandboxEntrySpy).not.toHaveBeenCalled();
    expect(harness.restoreSandboxEntryIfMissingSpy).not.toHaveBeenCalled();
  });

  it("does NOT destroy/recreate when a foreign gateway is active (multi-gateway guard)", async () => {
    // A different OpenShell gateway is active, so the sandbox is missing from
    // the active gateway's list — but it may still be live on the named
    // nemoclaw gateway. Rebuild must reconcile against the named gateway and
    // refuse to recreate from scratch, or it would destroy live workspace
    // state in multi-gateway setups (#4497 / #4645).
    const harness = createRebuildFlowHarness({
      sandboxListOutput: "",
      reconciledSandboxGatewayState: {
        state: "wrong_gateway_active",
        output: "Gateway: other-gw",
        activeGateway: "other-gw",
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Could not confirm live state");

    const output = harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n");

    // Must NOT take the destructive stale-recovery path.
    expect(output).not.toContain("No live workspace state to back up");
    expect(output).not.toContain("Deleting old sandbox");
    expect(output).not.toContain("Creating new sandbox with current image");
    // Must surface the wrong-gateway guidance and preserve the registry entry.
    expect(output).toContain("NOT been removed");
    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(harness.removeSandboxRegistryEntryWithReceiptSpy).not.toHaveBeenCalled();
    expect(harness.onboardSpy).not.toHaveBeenCalled();
  });

  it("does NOT stale-recover a sandbox recorded on a non-default per-port gateway", async () => {
    // The sandbox was created on a non-default gateway (#4645). It is absent
    // from the active (default) gateway's list, but its live workspace may be
    // intact on its own gateway. Rebuild must not recreate-from-scratch on the
    // wrong gateway; it must point the operator at the recorded gateway and
    // preserve the registry entry.
    const harness = createRebuildFlowHarness({
      sandboxEntry: { gatewayName: "nemoclaw-9000", gatewayPort: 9000 },
      sandboxListOutput: "",
      reconciledSandboxGatewayState: {
        state: "wrong_gateway_active",
        output: "Gateway: nemoclaw",
        activeGateway: "nemoclaw",
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Could not confirm live state");

    const output = harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n");

    expect(output).not.toContain("No live workspace state to back up");
    expect(output).not.toContain("Deleting old sandbox");
    expect(output).not.toContain("Creating new sandbox with current image");
    expect(output).toContain("openshell gateway select nemoclaw-9000");
    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(harness.removeSandboxRegistryEntryWithReceiptSpy).not.toHaveBeenCalled();
    expect(harness.onboardSpy).not.toHaveBeenCalled();
  });

  it("preserves stale-recovery metadata when the real CLI recreate fails", {
    timeout: 90_000,
  }, () => {
    // Stale recovery removes the registry entry before the recreate (the
    // recreate re-adds it on success). Inject a sandbox-create failure so the
    // recreate fails — the entry must be restored so the
    // recommended `rebuild --yes` stays retryable instead of failing at
    // dispatch with "not found in registry" (#4497).
    const fixture = createStaleFixture({ failSandboxCreate: true });
    const result = runRebuild(fixture);
    const output = (result.stderr || "") + (result.stdout || "");

    // The pre-fix backup dead-end must be gone: the CLI reports the stale state,
    // skips backup, and crosses the recreate boundary before failing.
    expect(output).not.toContain("Cannot back up state");
    expect(output).toContain("absent from the live OpenShell gateway");
    expect(output).toContain("No live workspace state to back up");
    expect(output).not.toContain("Backing up sandbox state");
    expect(output).toContain("Creating new sandbox with current image");
    expect(output).toContain("Recovery recreate failed");
    // The preserved entry must survive the failed recreate. Its obsolete image
    // tag is intentionally cleared so a leftover image remains eligible for GC.
    const registry = readRegistry(fixture);
    expect(registry.defaultSandbox).toBe(fixture.sandboxName);
    expect(registry.sandboxes[fixture.sandboxName].imageTag).toBe(null);
  });
});
