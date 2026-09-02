// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { cleanupPreparedRecoveryManifests } from "../../src/lib/actions/sandbox/rebuild-flow-test-fixtures";
import { type RebuildSandbox, snapshotEnv } from "./rebuild-flow-test-support";

export * from "./rebuild-flow-test-support";

const requireDist = createRequire(
  new URL("../../src/lib/actions/sandbox/rebuild.ts", import.meta.url),
);
const rebuildModulePath = "./rebuild.js";

// Warm the CommonJS source graph outside the first test's timeout. Each harness
// still reloads the entry module after installing its dependency spies.
requireDist(rebuildModulePath);
delete require.cache[requireDist.resolve(rebuildModulePath)];

// Cache stable dependency modules outside each test's timeout. The rebuild
// entry itself is still reloaded after these modules receive fresh spies.
export const agentDefs = requireDist("../../agent/defs.js");
export const agentOnboard = requireDist("../../agent/onboard.js");
export const agentRuntime = requireDist("../../agent/runtime.js");
export const agentForwardStop = requireDist("../../tunnel/agent-forward-stop.js");
export const buildContextFingerprint = requireDist(
  "../../adapters/fs/build-context-fingerprint.js",
);
export const destroy = requireDist("./destroy.js");
export const dockerImage = requireDist("../../adapters/docker/image.js");
export const dockerInspect = requireDist("../../adapters/docker/inspect.js");
export const gatewayDrift = requireDist("../../adapters/openshell/gateway-drift.js");
export const gatewayRuntime = requireDist("../../gateway-runtime-action.js");
export const gatewayState = requireDist("./gateway-state.js");
export const gatewayTeardownAuthority = requireDist(
  "../../onboard/gateway-teardown-authority.js",
) as typeof import("../../src/lib/onboard/gateway-teardown-authority");
export const hermesProviderAuth = requireDist("../../hermes-provider-auth.js");
export const mcpBridge = requireDist("./mcp-bridge.js");
export const messaging = requireDist("../../messaging/index.js");
export const messagingHostForwardLifecycle = requireDist("./messaging-host-forward-lifecycle.js");
export const nim = requireDist("../../inference/nim.js");
export const onboardCredentialEnv = requireDist("../../onboard/credential-env.js");
export const onboardSession = requireDist("../../state/onboard-session.js");
export const openshellRuntime = requireDist("../../adapters/openshell/runtime.js");
export const policies = requireDist("../../policy/index.js");
export const policyState = requireDist("../../adapters/openshell/policy-state.js");
export const policyGet = requireDist("./policy-get.js");
export const portableAgentLifecycle = requireDist(
  "../../onboard/experimental/portable-agent-lifecycle.js",
);
export const processRecovery = requireDist("./process-recovery.js");
export const { rebuildOnboardDependencies } = requireDist("./rebuild-onboard-dependencies.js");
export const rebuildCustomImagePreflight = requireDist("./rebuild-custom-image-preflight.js");
export const rebuildFlowHelpers = requireDist("./rebuild-flow-helpers.js");
export const rebuildInference = requireDist("./inference-invocation-probe.js");
export const rebuildManagedImage = requireDist("./rebuild-managed-image-preflight.js");
export const rebuildMessagingConflict = requireDist("./rebuild-messaging-conflict-preflight.js");
export const rebuildPreparedImageContext = requireDist("./rebuild-prepared-image-context.js");
export const rebuildRoutePreflight = requireDist("./rebuild-preflight-guards.js");
export const rebuildShields = requireDist("./rebuild-shields.js");
export const rebuildUsageNotice = requireDist("./rebuild-usage-notice.js");
export const registry = requireDist("../../state/registry.js");
export const registryPersistence = requireDist("../../state/registry/persistence.js");
export const resolve = requireDist("../../adapters/openshell/resolve.js");
export const sandboxList = requireDist("../../openshell-sandbox-list.js");
export const sandboxSession = requireDist("../../state/sandbox-session.js");
export const sandboxState = requireDist("../../state/sandbox.js");
export const sandboxVersion = requireDist("../../sandbox/version.js");
export const shields = requireDist("../../shields/index.js");
export const tempFiles = requireDist("../../onboard/temp-files.js");

export function purgeRebuildModule(): void {
  delete require.cache[requireDist.resolve(rebuildModulePath)];
}

export function loadRebuildSandbox(): RebuildSandbox {
  return requireDist(rebuildModulePath).rebuildSandbox;
}

export function sourceSandboxGateway(argv: string[], verb: string): string | null {
  const gatewayFlag = argv.indexOf("-g");
  return argv[0] === "sandbox" && argv[1] === verb && argv.at(-1) === "alpha" && gatewayFlag > 0
    ? (argv[gatewayFlag + 1] ?? null)
    : null;
}

export function captureResolvedRebuildFixture(
  argv: string[],
  deletedSourceGateways: ReadonlySet<string>,
) {
  const livePolicy = "version: 1\nnetwork_policies:\n  host_preserved: {}\n";
  if (argv[0] === "policy" && argv.includes("--output")) {
    const output = JSON.stringify({
      scope: "sandbox",
      sandbox: "alpha",
      status: "effective",
      policy_source: "sandbox",
      hash: "sha256:rebuild-policy",
      active_version: 1,
      policy: { version: 1, network_policies: { host_preserved: {} } },
    });
    return { status: 0, output, stdout: output, stderr: "" };
  }
  if (argv[0] === "policy") {
    const output = `Version: 1\nActive: 1\n---\n${livePolicy}`;
    return { status: 0, output, stdout: output, stderr: "" };
  }
  const probedGateway = sourceSandboxGateway(argv, "get");
  const liveSource = "Name: alpha\nId: sbx-alpha-source\nPhase: Ready\n";
  return probedGateway && !deletedSourceGateways.has(probedGateway)
    ? { status: 0, output: liveSource, stdout: liveSource, stderr: "" }
    : {
        status: 1,
        output: "",
        stdout: "",
        stderr: "Error: sandbox alpha not found",
      };
}

const harnessTempDirs: string[] = [];
type HarnessRebuildBackup = ReturnType<typeof sandboxState.listBackups>[number];
const harnessRebuildBackups: HarnessRebuildBackup[] = [];

export function registerHarnessRebuildBackup(backup: HarnessRebuildBackup): void {
  const existing = harnessRebuildBackups.findIndex(
    (entry) => entry.backupPath === backup.backupPath,
  );
  if (existing >= 0) harnessRebuildBackups.splice(existing, 1);
  harnessRebuildBackups.push(structuredClone(backup));
}

export function listHarnessRebuildBackups(): HarnessRebuildBackup[] {
  return structuredClone(harnessRebuildBackups);
}

export function createHarnessTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  harnessTempDirs.push(dir);
  return dir;
}

export type RebuildFlowTestHookOptions = {
  acceptThirdPartySoftware?: boolean;
};

export function installRebuildFlowTestHooks(options: RebuildFlowTestHookOptions = {}): void {
  const restoreRebuildFlowEnv = snapshotEnv([
    "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
    "NEMOCLAW_SANDBOX_NAME",
  ]);
  beforeEach(() => {
    harnessRebuildBackups.splice(0);
    delete process.env.NEMOCLAW_SANDBOX_NAME;
    if (options.acceptThirdPartySoftware) {
      process.env.NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE = "1";
    } else {
      delete process.env.NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE;
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
    purgeRebuildModule();
    for (const dir of harnessTempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    cleanupPreparedRecoveryManifests();
    restoreRebuildFlowEnv();
  });
}
