// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-sandbox proof that the installed `state-dir-guard.py` preserves file
 * content and extended attributes across its fresh-inode copy-replace, and
 * that a POSIX ACL's *effective* access (entry permission masked by
 * `ACL_MASK`) never exceeds the guard's declared policy for a transition --
 * closing the coverage gap left by PR #5874 (advisor findings PRA-19/PRA-T5)
 * where only source-level fakes exercised this path.
 *
 * The ACL is written and read directly through `os.setxattr`/`os.getxattr`
 * against the kernel's documented `system.posix_acl_access` wire format (see
 * test/e2e/lib/state-dir-guard-xattr-acl.py), so this does not require the
 * `acl` userspace package in either production Dockerfile.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { type SandboxClient, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  requireDockerAvailable,
  requireXattrAclCapability,
} from "./state-dir-guard-xattr-acl-helpers.ts";

const CONFIG_DIR = "/sandbox/.openclaw";
const WORKSPACE_ROOT = `${CONFIG_DIR}/workspace`;
const CREDENTIALS_ROOT = `${CONFIG_DIR}/credentials`;
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-state-dir-guard-xattr-acl";
const GATEWAY_NAME = process.env.OPENSHELL_GATEWAY ?? "nemoclaw";
const HELPER_PY_PATH = path.join(import.meta.dirname, "..", "lib", "state-dir-guard-xattr-acl.py");
const HELPER_CONTAINER_PATH = "/tmp/nemoclaw-e2e-xattr-acl.py";
// "nobody"-class uid: guaranteed not to collide with root, sandbox, or gateway.
const ACL_EXTRA_UID = 65534;

const TEST_TIMEOUT_MS = 30 * 60_000;
const INSTALL_TIMEOUT_MS = 25 * 60_000;
const COMMAND_TIMEOUT_MS = 120_000;

validateSandboxName(SANDBOX_NAME);

function commandEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    OPENSHELL_GATEWAY: GATEWAY_NAME,
    ...extra,
  };
}

function onboardEnv(fakeBaseUrl: string): NodeJS.ProcessEnv {
  return commandEnv({
    COMPATIBLE_API_KEY: "dummy",
    NEMOCLAW_PROVIDER: "custom",
    NEMOCLAW_ENDPOINT_URL: fakeBaseUrl,
    NEMOCLAW_MODEL: "test-model",
    NEMOCLAW_POLICY_MODE: "skip",
    NEMOCLAW_DASHBOARD_PORT: "",
    CHAT_UI_URL: "",
    NEMOCLAW_RECREATE_SANDBOX: "1",
  });
}

async function runNemoclaw(
  host: HostCliClient,
  args: string[],
  artifactName: string,
): Promise<ShellProbeResult> {
  return host.command("nemoclaw", args, {
    artifactName,
    env: commandEnv(),
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
}

async function docker(
  host: HostCliClient,
  args: string[],
  artifactName: string,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<ShellProbeResult> {
  return host.command("docker", args, {
    artifactName,
    env: commandEnv(),
    timeoutMs,
  });
}

async function installedShellCommand(
  host: HostCliClient,
  script: string,
  options: { artifactName: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<ShellProbeResult> {
  return host.command("bash", ["-lc", script], {
    artifactName: options.artifactName,
    env: options.env ?? commandEnv(),
    timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
  });
}

async function findSandboxContainer(host: HostCliClient): Promise<string> {
  const result = await docker(
    host,
    ["ps", "--filter", `name=openshell-${SANDBOX_NAME}`, "-q"],
    "find-sandbox-container",
    30_000,
  );
  expect(result.exitCode, resultText(result)).toBe(0);
  const containerId = result.stdout.trim().split(/\s+/).filter(Boolean)[0] ?? "";
  expect(containerId, `could not find openshell container for ${SANDBOX_NAME}`).not.toBe("");
  return containerId;
}

async function cleanupSandbox(host: HostCliClient, sandbox: SandboxClient): Promise<void> {
  await runNemoclaw(host, [SANDBOX_NAME, "destroy", "--yes"], "cleanup-nemoclaw-destroy").catch(
    () => undefined,
  );
  await sandbox
    .openshell(["sandbox", "delete", SANDBOX_NAME], {
      artifactName: "cleanup-openshell-sandbox-delete",
      env: commandEnv(),
      timeoutMs: 60_000,
    })
    .catch(() => undefined);
  await sandbox
    .openshell(["gateway", "destroy", "-g", GATEWAY_NAME], {
      artifactName: "cleanup-openshell-gateway-destroy",
      env: commandEnv(),
      timeoutMs: 60_000,
    })
    .catch(() => undefined);
  fs.rmSync(path.join(os.homedir(), ".nemoclaw", "state", `shields-${SANDBOX_NAME}.json`), {
    force: true,
  });
  fs.rmSync(path.join(os.homedir(), ".nemoclaw", "state", `shields-timer-${SANDBOX_NAME}.json`), {
    force: true,
  });
  fs.rmSync(path.join(os.homedir(), ".nemoclaw", "onboard.lock"), { force: true });
}

interface CapabilityProbeResult {
  xattr: boolean;
  acl: boolean;
}

interface AclEntry {
  tag: number;
  perm: number;
  id: number;
}

interface FixtureReport {
  path: string;
  inode: number;
  uid: number;
  gid: number;
  ownerName: string | null;
  groupName: string | null;
  mode: string;
  sha256: string;
  marker: string | null;
  aclEntries: AclEntry[] | null;
  effectivePermForExtraUid: number | null;
}

const ACL_USER_TAG = 0x02;

function modeToNumber(mode: string): number {
  return Number.parseInt(mode.replace(/^0o/, ""), 8);
}

function findAclUserEntry(entries: AclEntry[] | null, uid: number): AclEntry | undefined {
  return (entries ?? []).find((entry) => entry.tag === ACL_USER_TAG && entry.id === uid);
}

async function runHelper(
  host: HostCliClient,
  containerId: string,
  args: string[],
  artifactName: string,
): Promise<ShellProbeResult> {
  return docker(
    host,
    ["exec", "-u", "0", containerId, "python3", HELPER_CONTAINER_PATH, ...args],
    artifactName,
  );
}

async function seedFixture(
  host: HostCliClient,
  containerId: string,
  root: string,
  marker: string,
  artifactName: string,
): Promise<{ path: string; inode: number; sha256: string }> {
  const result = await runHelper(
    host,
    containerId,
    ["seed", "--root", root, "--marker", marker, "--acl-extra-uid", String(ACL_EXTRA_UID)],
    artifactName,
  );
  expect(result.exitCode, resultText(result)).toBe(0);
  return JSON.parse(result.stdout.trim());
}

async function verifyFixture(
  host: HostCliClient,
  containerId: string,
  targetPath: string,
  artifactName: string,
): Promise<FixtureReport> {
  const result = await runHelper(
    host,
    containerId,
    ["verify", "--path", targetPath, "--acl-extra-uid", String(ACL_EXTRA_UID)],
    artifactName,
  );
  expect(result.exitCode, resultText(result)).toBe(0);
  return JSON.parse(result.stdout.trim());
}

test("state-dir-guard xattr/ACL: shields up/down preserve content and clamp effective ACL access (#6059)", {
  timeout: TEST_TIMEOUT_MS,
}, async ({ artifacts, cleanup, host, sandbox, skip }) => {
  await artifacts.target.declare({
    id: "state-dir-guard-xattr-acl",
    boundary: "live-sandbox-state-dir-guard-xattr-acl",
    contracts: [
      "filesystem xattr/ACL capability is detected and recorded explicitly, not silently skipped",
      "shields up replaces high-risk and confidentiality state files with a fresh inode",
      "content and a user xattr marker survive the fresh-inode copy verbatim",
      "a POSIX ACL's raw named-user entry survives the copy verbatim",
      "the ACL's effective access for that named user never exceeds the transition's policy mode",
      "shields down (unlock) re-widens effective access but only to the unlock policy's cap",
    ],
  });

  const dockerInfo = await docker(host, ["info"], "prereq-docker-info", 30_000);
  requireDockerAvailable(
    dockerInfo,
    () => resultText(dockerInfo),
    "state-dir-guard xattr/ACL live E2E",
    skip,
  );

  const fake = await startFakeOpenAiCompatibleServer({});
  cleanup.add("close state-dir-guard xattr/ACL fake inference endpoint", async () => {
    await artifacts.writeJson("fake-openai-compatible-requests.json", fake.requests());
    await fake.close();
  });

  await cleanupSandbox(host, sandbox);
  cleanup.add(`destroy state-dir-guard-xattr-acl sandbox ${SANDBOX_NAME}`, async () => {
    await cleanupSandbox(host, sandbox);
  });

  const install = await installedShellCommand(
    host,
    `cd ${JSON.stringify(REPO_ROOT)} && bash install.sh --non-interactive --fresh`,
    {
      artifactName: "phase-1-install",
      env: onboardEnv(fake.baseUrl),
      timeoutMs: INSTALL_TIMEOUT_MS,
    },
  );
  expect(install.exitCode, resultText(install)).toBe(0);

  const containerId = await findSandboxContainer(host);

  const copyHelper = await docker(
    host,
    ["cp", HELPER_PY_PATH, `${containerId}:${HELPER_CONTAINER_PATH}`],
    "phase-2-copy-xattr-acl-helper",
    30_000,
  );
  expect(copyHelper.exitCode, resultText(copyHelper)).toBe(0);

  const capabilityProbe = await runHelper(
    host,
    containerId,
    ["capability-probe", "--dir", CONFIG_DIR],
    "phase-2-capability-probe",
  );
  expect(capabilityProbe.exitCode, resultText(capabilityProbe)).toBe(0);
  const capability: CapabilityProbeResult = JSON.parse(capabilityProbe.stdout.trim());
  await artifacts.writeJson("phase-2-xattr-acl-capability-result.json", capability);
  requireXattrAclCapability(capability, skip);

  const mkCredentials = await docker(
    host,
    ["exec", "-u", "0", containerId, "mkdir", "-p", CREDENTIALS_ROOT],
    "phase-2-mkdir-credentials-root",
    15_000,
  );
  expect(mkCredentials.exitCode, resultText(mkCredentials)).toBe(0);

  const marker = `e2e-${process.pid}-${Date.now()}`;
  const workspaceSeed = await seedFixture(
    host,
    containerId,
    WORKSPACE_ROOT,
    `${marker}-workspace`,
    "phase-3-seed-workspace-fixture",
  );
  const credentialsSeed = await seedFixture(
    host,
    containerId,
    CREDENTIALS_ROOT,
    `${marker}-credentials`,
    "phase-3-seed-credentials-fixture",
  );

  const shieldsUp = await runNemoclaw(host, [SANDBOX_NAME, "shields", "up"], "phase-4-shields-up");
  expect(shieldsUp.exitCode, resultText(shieldsUp)).toBe(0);
  expect(resultText(shieldsUp)).toContain("Lockdown active");

  const workspaceLocked = await verifyFixture(
    host,
    containerId,
    workspaceSeed.path,
    "phase-4-verify-workspace-locked",
  );
  expect(workspaceLocked.sha256).toBe(workspaceSeed.sha256);
  expect(workspaceLocked.marker).toBe(`${marker}-workspace`);
  expect(workspaceLocked.inode).not.toBe(workspaceSeed.inode);
  expect(workspaceLocked.uid).toBe(0);
  // High-risk lock's expected owner is root:sandbox (see _expected_ids in
  // state-dir-guard.py: policy != "confidentiality" -> root_uid, sandbox_gid).
  expect(workspaceLocked.ownerName).toBe("root");
  expect(workspaceLocked.groupName).toBe("sandbox");
  // The guard's high-risk lock mode is `old_mode & ~0o022`. The seed helper
  // keeps the ACL's owner/mask/other perms execute-bit-free, so the kernel's
  // ACL-resync leaves old_mode at 0o666 and this clamps to 0o644.
  expect(modeToNumber(workspaceLocked.mode)).toBe(0o644);
  expect(workspaceLocked.effectivePermForExtraUid).toBe(0o4);
  const workspaceLockedAclUser = findAclUserEntry(workspaceLocked.aclEntries, ACL_EXTRA_UID);
  expect(workspaceLockedAclUser?.perm, "raw ACL entry must survive the copy verbatim").toBe(0o7);

  const credentialsLocked = await verifyFixture(
    host,
    containerId,
    credentialsSeed.path,
    "phase-4-verify-credentials-locked",
  );
  expect(credentialsLocked.sha256).toBe(credentialsSeed.sha256);
  expect(credentialsLocked.marker).toBe(`${marker}-credentials`);
  expect(credentialsLocked.inode).not.toBe(credentialsSeed.inode);
  expect(credentialsLocked.uid).toBe(0);
  expect(credentialsLocked.gid).toBe(0);
  // Confidentiality lock's expected owner is root:root (see _expected_ids:
  // policy == "confidentiality" -> root_uid, root_gid).
  expect(credentialsLocked.ownerName).toBe("root");
  expect(credentialsLocked.groupName).toBe("root");
  // Confidentiality lock mode is `old_mode & 0o700`; old_mode is 0o666, so
  // the result is 0o600.
  expect(modeToNumber(credentialsLocked.mode)).toBe(0o600);
  expect(credentialsLocked.effectivePermForExtraUid).toBe(0);
  const credentialsLockedAclUser = findAclUserEntry(credentialsLocked.aclEntries, ACL_EXTRA_UID);
  expect(credentialsLockedAclUser?.perm, "raw ACL entry must survive the copy verbatim").toBe(0o7);

  const shieldsDown = await runNemoclaw(
    host,
    [
      SANDBOX_NAME,
      "shields",
      "down",
      "--timeout",
      "5m",
      "--reason",
      "state-dir-guard xattr/ACL E2E",
    ],
    "phase-5-shields-down",
  );
  expect(shieldsDown.exitCode, resultText(shieldsDown)).toBe(0);
  expect(resultText(shieldsDown)).toContain("Config unlocked");

  const workspaceUnlocked = await verifyFixture(
    host,
    containerId,
    workspaceSeed.path,
    "phase-5-verify-workspace-unlocked",
  );
  expect(workspaceUnlocked.sha256).toBe(workspaceSeed.sha256);
  expect(workspaceUnlocked.marker).toBe(`${marker}-workspace`);
  // Unlike lock, `_unlock_file` in state-dir-guard.py updates ownership/mode
  // in place (fchown/fchmod on the already-open fd) rather than doing a
  // fresh-inode copy-replace, so the inode from the locked state persists.
  expect(workspaceUnlocked.inode).toBe(workspaceLocked.inode);
  // Unlock's expected owner is always sandbox:sandbox regardless of policy
  // (see _expected_ids: action == "unlock" -> sandbox_uid, sandbox_gid).
  expect(workspaceUnlocked.ownerName).toBe("sandbox");
  expect(workspaceUnlocked.groupName).toBe("sandbox");
  // Unlock mode is `(old_mode & 0o700) | 0o060 | (0o010 if old_mode & 0o111)`;
  // old_mode is the 0o644 locked mode above, which carries no execute bits,
  // so the result is 0o660.
  expect(modeToNumber(workspaceUnlocked.mode)).toBe(0o660);
  expect(
    workspaceUnlocked.effectivePermForExtraUid,
    "unlock must not restore the ACL entry's full raw permission",
  ).toBe(0o6);
  const workspaceUnlockedAclUser = findAclUserEntry(workspaceUnlocked.aclEntries, ACL_EXTRA_UID);
  expect(workspaceUnlockedAclUser?.perm).toBe(0o7);

  const credentialsUnlocked = await verifyFixture(
    host,
    containerId,
    credentialsSeed.path,
    "phase-5-verify-credentials-unlocked",
  );
  expect(credentialsUnlocked.sha256).toBe(credentialsSeed.sha256);
  expect(credentialsUnlocked.marker).toBe(`${marker}-credentials`);
  // Unlock is an in-place fchown/fchmod (see comment above), so the inode
  // from the locked state persists.
  expect(credentialsUnlocked.inode).toBe(credentialsLocked.inode);
  // Unlock's expected owner is always sandbox:sandbox regardless of policy
  // (see _expected_ids: action == "unlock" -> sandbox_uid, sandbox_gid).
  expect(credentialsUnlocked.ownerName).toBe("sandbox");
  expect(credentialsUnlocked.groupName).toBe("sandbox");
  // Unlock mode is `(old_mode & 0o700) | 0o060 | (0o010 if old_mode & 0o111)`;
  // old_mode is the 0o600 locked mode above, which carries no execute bits,
  // so the result is 0o660, same as the workspace fixture.
  expect(modeToNumber(credentialsUnlocked.mode)).toBe(0o660);
  expect(
    credentialsUnlocked.effectivePermForExtraUid,
    "unlock must not restore the ACL entry's full raw permission",
  ).toBe(0o6);
  const credentialsUnlockedAclUser = findAclUserEntry(
    credentialsUnlocked.aclEntries,
    ACL_EXTRA_UID,
  );
  expect(credentialsUnlockedAclUser?.perm, "raw ACL entry must survive the copy verbatim").toBe(
    0o7,
  );

  await artifacts.target.complete({
    id: "state-dir-guard-xattr-acl",
    sandboxName: SANDBOX_NAME,
    assertions: {
      capabilityDetected: true,
      workspaceLockClampsAcl: true,
      credentialsLockClampsAcl: true,
      unlockCapsRatherThanRestoresAcl: true,
      lockReplacesWithFreshInode: true,
      unlockPreservesLockedInode: true,
    },
  });
});
