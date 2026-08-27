// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildAutoPairApprovalScript,
  parseAutoPairApprovalReceipt,
  readAutoPairApprovalPolicyModule,
} from "./auto-pair-approval";

const SUMMARY_MARKER = "__NEMOCLAW_AUTO_PAIR_APPROVED__";

describe("auto-pair approval pass behaviour (#4616)", () => {
  const pyIt =
    spawnSync("sh", ["-c", "command -v python3"], { stdio: "ignore" }).status === 0 ? it : it.skip;
  const pyIt25s = (name: string, test: () => void) => pyIt(name, test, 25_000);

  pyIt25s("approves only one exact local clone pairing transition on a shared gateway", () => {
    const policy = readAutoPairApprovalPolicyModule();
    expect(policy).toBeTruthy();
    const testPolicy = `${policy}
class _NemoClawTestTime:
    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds

approval_time = _NemoClawTestTime()
`;
    const policyB64 = Buffer.from(testPolicy, "utf-8").toString("base64");
    const script = buildAutoPairApprovalScript(policyB64, {
      emitSummary: true,
      emitReceipt: true,
      localDeviceOnly: true,
      budget: { maxApprovals: 1 },
    });
    const timeoutScript = buildAutoPairApprovalScript(policyB64, {
      emitSummary: true,
      emitReceipt: true,
      localDeviceOnly: true,
      budget: {
        maxApprovals: 1,
        approveTimeoutS: 0.25,
      },
    });
    const tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-restored-clone-pair-")),
    );
    try {
      const stateDir = path.join(tmpDir, "openclaw-state");
      const identityDir = path.join(stateDir, "identity");
      const devicesDir = path.join(stateDir, "devices");
      const primaryStateDir = path.join(tmpDir, "primary-openclaw-state");
      const primaryIdentityDir = path.join(primaryStateDir, "identity");
      const primaryDevicesDir = path.join(primaryStateDir, "devices");
      const cloneAuthFile = path.join(identityDir, "device-auth.json");
      const primaryAuthFile = path.join(primaryIdentityDir, "device-auth.json");
      const approvalsFile = path.join(tmpDir, "approvals.log");
      const approveCallsFile = path.join(tmpDir, "approve-calls.log");
      const approveCheckFile = path.join(tmpDir, "approve-check.log");
      const approveEnvFile = path.join(tmpDir, "approve-env.log");
      const listEnvFile = path.join(tmpDir, "list-env.log");
      fs.mkdirSync(identityDir, { recursive: true });
      fs.mkdirSync(devicesDir, { recursive: true });
      fs.mkdirSync(primaryIdentityDir, { recursive: true });
      fs.mkdirSync(primaryDevicesDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, ".env"), "NEMOCLAW_TEST_STATE=clone\n");
      fs.writeFileSync(path.join(primaryStateDir, ".env"), "NEMOCLAW_TEST_STATE=primary\n");
      const publicKey = "y3vjb9p8tAecivI1l5f1Hdc9QdZJSt3BmLkJMM7wZD8";
      const deviceId = "04a4c561c730435e9f6a2e38d2e7b929bcbec2ea1c37d3dd053f3341ecce4e47";
      fs.writeFileSync(
        path.join(identityDir, "device.json"),
        JSON.stringify({
          deviceId,
          publicKeyPem:
            "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAy3vjb9p8tAecivI1l5f1Hdc9QdZJSt3BmLkJMM7wZD8=\n-----END PUBLIC KEY-----\n",
        }),
      );
      fs.writeFileSync(
        path.join(tmpDir, "openclaw"),
        `#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
const canonicalFd = (name) => {
  const raw = process.env[name] || "";
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 3 ? value : null;
};
const readPinnedJson = (name) => {
  const fd = canonicalFd(name);
  if (fd === null) throw new Error("missing pinned clone descriptor");
  return JSON.parse(fs.readFileSync(fd, "utf8"));
};
if (args[0] === "devices" && args[1] === "list") {
  fs.appendFileSync(
    ${JSON.stringify(listEnvFile)},
    [
      process.env.OPENCLAW_STATE_DIR || "unset",
      process.env.NEMOCLAW_PRIMARY_STATE_DIR || "unset",
    ].join(":") + "\\n",
  );
  process.stderr.write("raw list output must stay private\\n");
  process.exit(1);
}
if (args[0] === "devices" && args[1] === "approve") {
  fs.appendFileSync(${JSON.stringify(approveCallsFile)}, "called\\n");
  if (process.env.NEMOCLAW_APPROVE_FAIL === "1") {
    process.stderr.write("raw approval output must stay private\\n");
    process.exit(1);
  }
  const forced = process.env.NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING === "1";
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  const expectedCloneStateDir = process.env.NEMOCLAW_TEST_CLONE_STATE_DIR;
  const cloneStateBackup = process.env.NEMOCLAW_TEST_CLONE_STATE_BACKUP;
  const cloneStatePath =
    expectedCloneStateDir &&
    fs.lstatSync(expectedCloneStateDir).isSymbolicLink() &&
    cloneStateBackup &&
    fs.existsSync(cloneStateBackup)
      ? cloneStateBackup
      : expectedCloneStateDir;
  const forcedStateMatch = forced ? /^\\/proc\\/self\\/fd\\/([1-9][0-9]*)$/.exec(stateDir || "") : null;
  const forcedStateFd = forcedStateMatch ? Number(forcedStateMatch[1]) : null;
  const forcedStateStat = forcedStateFd === null ? null : fs.fstatSync(forcedStateFd);
  const expectedStateStat = cloneStatePath ? fs.statSync(cloneStatePath) : null;
  const forcedStatePinned = Boolean(
    forcedStateFd !== null &&
      forcedStateFd >= 3 &&
      forcedStateStat?.isDirectory() &&
      forcedStateStat.dev === expectedStateStat?.dev &&
      forcedStateStat.ino === expectedStateStat?.ino
  );
  const pending = forced
    ? readPinnedJson("NEMOCLAW_OPENCLAW_PENDING_FD")
    : JSON.parse(fs.readFileSync(cloneStatePath + "/devices/pending.json", "utf8"));
  const paired = forced
    ? readPinnedJson("NEMOCLAW_OPENCLAW_PAIRED_FD")
    : JSON.parse(fs.readFileSync(cloneStatePath + "/devices/paired.json", "utf8"));
  const pinnedIdentity = forced
    ? readPinnedJson("NEMOCLAW_OPENCLAW_IDENTITY_FD")
    : null;
  const request = pending[args[2]];
  const pairedDevice = request && paired[request.deviceId];
  const pairedOperator = pairedDevice && pairedDevice.tokens && pairedDevice.tokens.operator;
  const hasPairedBaseline = Boolean(pairedOperator);
  let clientAuth;
  try {
    clientAuth = JSON.parse(fs.readFileSync(cloneStatePath + "/identity/device-auth.json", "utf8"));
  } catch {}
  const storedOperator = clientAuth && clientAuth.tokens && clientAuth.tokens.operator;
  const clientAuthMatches = Boolean(
    storedOperator &&
      storedOperator.token === pairedOperator?.token &&
      JSON.stringify(storedOperator.scopes) === JSON.stringify(pairedOperator.scopes),
  );
  const exactPairingBaseline = Boolean(
    pairedOperator &&
      JSON.stringify(pairedOperator.scopes) === JSON.stringify(["operator.pairing"]) &&
      JSON.stringify(pairedDevice.scopes) === JSON.stringify(["operator.pairing"]) &&
      JSON.stringify(pairedDevice.approvedScopes) === JSON.stringify(["operator.pairing"]),
  );
  const boundedWriteUpgrade = Boolean(
    request &&
      (request.isRepair === true || request.isRepair === false) &&
      Array.isArray(request.scopes) &&
      request.scopes.includes("operator.write"),
  );
  const runtimeTokenOnly =
    !process.env.OPENCLAW_GATEWAY_URL &&
    !process.env.OPENCLAW_GATEWAY_PORT &&
    process.env.OPENCLAW_GATEWAY_TOKEN === "secret-token" &&
    !process.env.NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING &&
    !process.env.NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING;
  const pairedTokenOnly =
    process.env.OPENCLAW_GATEWAY_URL === "ws://127.0.0.1:18789" &&
    process.env.NEMOCLAW_OPENCLAW_PINNED_GATEWAY_URL ===
      process.env.OPENCLAW_GATEWAY_URL &&
    !process.env.OPENCLAW_GATEWAY_PORT &&
    !process.env.OPENCLAW_GATEWAY_PASSWORD &&
    !process.env.OPENCLAW_GATEWAY_TOKEN &&
    !process.env.NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING &&
    Boolean(pairedOperator?.token) &&
    forced &&
    process.env.NODE_DISABLE_COMPILE_CACHE === "1" &&
    process.env.OPENCLAW_NO_RESPAWN === "1" &&
    pinnedIdentity?.deviceId === process.env.NEMOCLAW_OPENCLAW_EXPECTED_DEVICE_ID &&
    pinnedIdentity?.deviceId === request?.deviceId &&
    forcedStatePinned &&
    !process.env.NEMOCLAW_OPENCLAW_STATE_DIR_FD &&
    !process.env.NEMOCLAW_OPENCLAW_DEVICES_DIR_FD &&
    !process.env.NEMOCLAW_OPENCLAW_IDENTITY_DIR_FD;
  const storedDeviceOnly =
    !process.env.OPENCLAW_GATEWAY_URL &&
    !process.env.OPENCLAW_GATEWAY_PORT &&
    !process.env.OPENCLAW_GATEWAY_TOKEN &&
    !process.env.NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING &&
    !process.env.NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING;
  const expectedAuthMode = hasPairedBaseline
    ? exactPairingBaseline && boundedWriteUpgrade
      ? pairedTokenOnly
      : clientAuthMatches
        ? storedDeviceOnly
        : pairedTokenOnly
    : runtimeTokenOnly;
  if (!expectedAuthMode) {
    const fixedFailure = !forced
      ? "ordinary-auth"
      : process.env.OPENCLAW_GATEWAY_URL !== "ws://127.0.0.1:18789"
        ? "loopback-url"
        : process.env.NEMOCLAW_OPENCLAW_PINNED_GATEWAY_URL !== process.env.OPENCLAW_GATEWAY_URL
          ? "pinned-url"
          : process.env.OPENCLAW_GATEWAY_PORT ||
              process.env.OPENCLAW_GATEWAY_PASSWORD ||
              process.env.OPENCLAW_GATEWAY_TOKEN
            ? "unsafe-transport"
              : process.env.NODE_DISABLE_COMPILE_CACHE !== "1"
                ? "compile-cache"
                : process.env.OPENCLAW_NO_RESPAWN !== "1"
                  ? "respawn"
                : pinnedIdentity?.deviceId !== process.env.NEMOCLAW_OPENCLAW_EXPECTED_DEVICE_ID
                  ? "expected-identity"
                  : pinnedIdentity?.deviceId !== request?.deviceId
                    ? "request-identity"
                    : "descriptor-context";
    fs.writeFileSync(${JSON.stringify(approveCheckFile)}, fixedFailure + "\\n");
    process.stderr.write("raw clone auth-mode mismatch must stay private\\n");
    process.exit(1);
  }
  fs.appendFileSync(${JSON.stringify(approvalsFile)}, args[2] + "\\n");
  fs.appendFileSync(
    ${JSON.stringify(approveEnvFile)},
    [
      process.env.OPENCLAW_GATEWAY_URL || "unset",
      process.env.OPENCLAW_GATEWAY_PORT || "unset",
      runtimeTokenOnly
        ? "runtime-token"
        : pairedTokenOnly
          ? "clone-paired-token"
          : "stored-device-auth",
      forced ? "forced" : "ordinary",
      forced
        ? forcedStatePinned
          ? "clone-state-fd"
          : "unexpected-forced-state"
        : process.env.OPENCLAW_STATE_DIR || "unset",
      process.env.NEMOCLAW_PRIMARY_STATE_DIR || "unset",
    ].join(":") + "\\n",
  );
  if (pairedTokenOnly) {
    const pinnedDevicesDir = cloneStatePath + "/devices";
    delete pending[args[2]];
    paired[request.deviceId] = {
      ...pairedDevice,
      scopes: request.scopes,
      approvedScopes: request.scopes,
      tokens: {
        operator: {
          token: "rotated-clone-device-token",
          role: "operator",
          scopes:
            process.env.NEMOCLAW_APPROVE_WATCHER_RACE_INVALID === "1"
              ? ["operator.pairing", "operator.write"]
              : ["operator.pairing", "operator.read", "operator.write"],
        },
      },
    };
    fs.writeFileSync(pinnedDevicesDir + "/pending.json", JSON.stringify(pending));
    fs.writeFileSync(pinnedDevicesDir + "/paired.json", JSON.stringify(paired));
    if (process.env.NEMOCLAW_APPROVE_WATCHER_RACE === "1") {
      process.stderr.write("raw concurrent approval output must stay private\\n");
      process.exit(1);
    }
  }
  if (process.env.NEMOCLAW_APPROVE_TIMEOUT_AFTER_COMMIT === "1") {
    process.stderr.write("raw timed-out approval output must stay private\\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
  }
  process.stdout.write("{}\\n");
  process.exit(0);
}
process.exit(2);
`,
        { mode: 0o755 },
      );
      const devicesRaceBackup = path.join(stateDir, "devices-before-race");
      const transientRaceMarker = path.join(tmpDir, "transient-devices-race.marker");
      const transientRacePolicy = `${testPolicy}
import os as _nemoclaw_test_os
_nemoclaw_test_original_open = _nemoclaw_test_os.open
_nemoclaw_test_raced = False

def _nemoclaw_test_race_open(path_value, flags, mode=0o777, *, dir_fd=None):
    global _nemoclaw_test_raced
    path_text = _nemoclaw_test_os.fspath(path_value)
    should_race = (
        not _nemoclaw_test_raced
        and _nemoclaw_test_os.environ.get('NEMOCLAW_TEST_TRANSIENT_DEVICES_RACE') == '1'
        and (
            (dir_fd is None and path_text == ${JSON.stringify(path.join(devicesDir, "pending.json"))})
            or (dir_fd is not None and path_text == 'pending.json')
        )
    )
    if not should_race:
        return _nemoclaw_test_original_open(path_value, flags, mode, dir_fd=dir_fd)
    _nemoclaw_test_raced = True
    _nemoclaw_test_os.rename(
        ${JSON.stringify(devicesDir)},
        ${JSON.stringify(devicesRaceBackup)},
    )
    _nemoclaw_test_os.symlink(
        ${JSON.stringify(primaryDevicesDir)},
        ${JSON.stringify(devicesDir)},
    )
    marker_fd = _nemoclaw_test_original_open(
        ${JSON.stringify(transientRaceMarker)},
        _nemoclaw_test_os.O_WRONLY | _nemoclaw_test_os.O_CREAT | _nemoclaw_test_os.O_TRUNC,
        0o600,
    )
    _nemoclaw_test_os.close(marker_fd)
    try:
        return _nemoclaw_test_original_open(path_value, flags, mode, dir_fd=dir_fd)
    finally:
        _nemoclaw_test_os.unlink(${JSON.stringify(devicesDir)})
        _nemoclaw_test_os.rename(
            ${JSON.stringify(devicesRaceBackup)},
            ${JSON.stringify(devicesDir)},
        )

_nemoclaw_test_os.open = _nemoclaw_test_race_open
`;
      const transientDevicesRaceScript = buildAutoPairApprovalScript(
        Buffer.from(transientRacePolicy, "utf-8").toString("base64"),
        {
          emitSummary: true,
          emitReceipt: true,
          localDeviceOnly: true,
          budget: { maxApprovals: 1 },
        },
      );
      const stateRaceBackup = path.join(tmpDir, "clone-state-before-child");
      const childRaceMarker = path.join(tmpDir, "child-entry-state-race.marker");
      const childEntryRacePolicy = `${testPolicy}
import os as _nemoclaw_test_os
import subprocess as _nemoclaw_test_subprocess
_nemoclaw_test_original_run = _nemoclaw_test_subprocess.run
_nemoclaw_test_child_raced = False

def _nemoclaw_test_race_child(*args, **kwargs):
    global _nemoclaw_test_child_raced
    command = args[0] if args else kwargs.get('args', [])
    should_race = (
        not _nemoclaw_test_child_raced
        and _nemoclaw_test_os.environ.get('NEMOCLAW_TEST_CHILD_ENTRY_RACE') == '1'
        and isinstance(command, list)
        and command[1:3] == ['devices', 'approve']
    )
    if not should_race:
        return _nemoclaw_test_original_run(*args, **kwargs)
    _nemoclaw_test_child_raced = True
    _nemoclaw_test_os.rename(
        ${JSON.stringify(stateDir)},
        ${JSON.stringify(stateRaceBackup)},
    )
    _nemoclaw_test_os.symlink(
        ${JSON.stringify(primaryStateDir)},
        ${JSON.stringify(stateDir)},
    )
    marker_fd = _nemoclaw_test_os.open(
        ${JSON.stringify(childRaceMarker)},
        _nemoclaw_test_os.O_WRONLY | _nemoclaw_test_os.O_CREAT | _nemoclaw_test_os.O_TRUNC,
        0o600,
    )
    _nemoclaw_test_os.close(marker_fd)
    try:
        return _nemoclaw_test_original_run(*args, **kwargs)
    finally:
        _nemoclaw_test_os.unlink(${JSON.stringify(stateDir)})
        _nemoclaw_test_os.rename(
            ${JSON.stringify(stateRaceBackup)},
            ${JSON.stringify(stateDir)},
        )

_nemoclaw_test_subprocess.run = _nemoclaw_test_race_child
`;
      const childEntryRaceScript = buildAutoPairApprovalScript(
        Buffer.from(childEntryRacePolicy, "utf-8").toString("base64"),
        {
          emitSummary: true,
          emitReceipt: true,
          localDeviceOnly: true,
          budget: { maxApprovals: 1 },
        },
      );
      const persistentRaceNeedle =
        "    fd = os.open(entry_name, clone_file_flags, dir_fd=directory_fd)";
      const persistentDevicesRaceScript = script.replace(
        persistentRaceNeedle,
        `    if (
        os.environ.get('NEMOCLAW_TEST_PERSISTENT_DEVICES_RACE') == '1'
        and directory_name == 'devices'
    ):
        os.rename(${JSON.stringify(devicesDir)}, ${JSON.stringify(devicesRaceBackup)})
        os.symlink(${JSON.stringify(primaryDevicesDir)}, ${JSON.stringify(devicesDir)})
${persistentRaceNeedle}`,
      );
      expect(persistentDevicesRaceScript.includes("NEMOCLAW_TEST_PERSISTENT_DEVICES_RACE")).toBe(
        true,
      );
      const transientPendingPublicationNeedle = `    fd = os.open(entry_name, clone_file_flags, dir_fd=directory_fd)
    try:
        validate_clone_json_descriptor(fd)`;
      const transientPendingPublicationScript = script.replace(
        transientPendingPublicationNeedle,
        `    fd = os.open(entry_name, clone_file_flags, dir_fd=directory_fd)
    try:
        serialized_pending = os.environ.pop('NEMOCLAW_TEST_TRANSIENT_PENDING_JSON', '')
        if serialized_pending and directory_name == 'devices' and entry_name == 'pending.json':
            with open(${JSON.stringify(path.join(devicesDir, "pending.json"))}, 'w', encoding='utf-8') as handle:
                handle.write(serialized_pending)
            raise json.JSONDecodeError('transient pending publication', '', 0)
        validate_clone_json_descriptor(fd)`,
      );
      expect(transientPendingPublicationScript).toContain("transient pending publication");
      const rotatedPendingPublicationNeedle = `        with os.fdopen(os.dup(fd), encoding='utf-8') as handle:
            parsed = json.load(handle)
        validate_clone_json_descriptor(fd)`;
      const rotatedPendingPublicationScript = script.replace(
        rotatedPendingPublicationNeedle,
        `        with os.fdopen(os.dup(fd), encoding='utf-8') as handle:
            parsed = json.load(handle)
        serialized_pending = os.environ.pop('NEMOCLAW_TEST_ROTATED_PENDING_JSON', '')
        if serialized_pending and directory_name == 'devices' and entry_name == 'pending.json':
            replacement_path = ${JSON.stringify(path.join(devicesDir, "pending-replacement.json"))}
            with open(replacement_path, 'w', encoding='utf-8') as handle:
                handle.write(serialized_pending)
            os.replace(replacement_path, ${JSON.stringify(path.join(devicesDir, "pending.json"))})
        validate_clone_json_descriptor(fd)`,
      );
      expect(rotatedPendingPublicationScript).toContain("NEMOCLAW_TEST_ROTATED_PENDING_JSON");
      const execute = (
        failApproval = false,
        gatewayToken = "secret-token",
        gatewayPort = "18789",
        watcherRace = false,
        invalidWatcherState = false,
        timeoutAfterCommit = false,
        devicesRace: "child-entry" | "none" | "persistent" | "transient" = "none",
        transientPendingJson = "",
        rotatedPendingJson = "",
        hardLinkPending = false,
      ) => {
        const approvalEnv = { ...process.env };
        delete approvalEnv.NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING;
        delete approvalEnv.NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING;
        const approvalScript = rotatedPendingJson
          ? rotatedPendingPublicationScript
          : transientPendingJson
            ? transientPendingPublicationScript
            : timeoutAfterCommit
              ? timeoutScript
              : devicesRace === "child-entry"
                ? childEntryRaceScript
                : devicesRace === "persistent"
                  ? persistentDevicesRaceScript
                  : devicesRace === "transient"
                    ? transientDevicesRaceScript
                    : script;
        const pendingHardLinkPath = path.join(tmpDir, "pending-hard-link.json");
        fs.rmSync(pendingHardLinkPath, { force: true });
        const preparePendingHardLink = hardLinkPending
          ? () => fs.linkSync(path.join(devicesDir, "pending.json"), pendingHardLinkPath)
          : () => undefined;
        preparePendingHardLink();
        const result = spawnSync("sh", {
          encoding: "utf-8",
          input: approvalScript,
          env: {
            ...approvalEnv,
            PATH: `${tmpDir}:/usr/bin:/bin`,
            NEMOCLAW_APPROVE_FAIL: failApproval ? "1" : "0",
            NEMOCLAW_APPROVE_WATCHER_RACE: watcherRace ? "1" : "0",
            NEMOCLAW_APPROVE_WATCHER_RACE_INVALID: invalidWatcherState ? "1" : "0",
            NEMOCLAW_APPROVE_TIMEOUT_AFTER_COMMIT: timeoutAfterCommit ? "1" : "0",
            NEMOCLAW_TEST_PERSISTENT_DEVICES_RACE: devicesRace === "persistent" ? "1" : "0",
            NEMOCLAW_TEST_TRANSIENT_DEVICES_RACE: devicesRace === "transient" ? "1" : "0",
            NEMOCLAW_TEST_CHILD_ENTRY_RACE: devicesRace === "child-entry" ? "1" : "0",
            NEMOCLAW_TEST_TRANSIENT_PENDING_JSON: transientPendingJson,
            NEMOCLAW_TEST_ROTATED_PENDING_JSON: rotatedPendingJson,
            NEMOCLAW_TEST_CLONE_STATE_DIR: stateDir,
            NEMOCLAW_TEST_CLONE_STATE_BACKUP: stateRaceBackup,
            NEMOCLAW_PRIMARY_STATE_DIR: primaryStateDir,
            NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING: "1",
            OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
            OPENCLAW_GATEWAY_PORT: gatewayPort,
            OPENCLAW_GATEWAY_TOKEN: gatewayToken,
            OPENCLAW_STATE_DIR: stateDir,
          },
          timeout: 10_000,
        });
        fs.rmSync(pendingHardLinkPath, { force: true });
        return result;
      };
      const run = (
        pending: unknown[],
        options: {
          failApproval?: boolean;
          invalidWatcherState?: boolean;
          timeoutAfterCommit?: boolean;
          watcherRace?: boolean;
          gatewayToken?: string;
          gatewayPort?: string;
          pendingById?: Record<string, unknown>;
          pairedById?: Record<string, unknown>;
          clientAuth?: "matching" | "missing" | "primary-symlink" | "stale";
          devicesRace?: "child-entry" | "persistent" | "transient";
          hardLinkPending?: boolean;
          rotatedPendingPublication?: boolean;
          transientPendingPublication?: boolean;
        } = {},
      ) => {
        const pendingById =
          options.pendingById ??
          Object.fromEntries(
            pending.map((device, index) => {
              const requestId = (device as { requestId?: unknown } | null)?.requestId;
              return [typeof requestId === "string" ? requestId : `entry-${index}`, device];
            }),
          );
        fs.writeFileSync(path.join(devicesDir, "pending.json"), JSON.stringify(pendingById));
        const pairedById =
          options.pairedById ??
          (Object.values(pendingById).some(
            (device) => (device as { isRepair?: unknown } | null)?.isRepair === true,
          )
            ? { [deviceId]: pairedDevice }
            : {});
        fs.writeFileSync(path.join(devicesDir, "paired.json"), JSON.stringify(pairedById));
        const clonePaired = pairedById[deviceId] as
          | { tokens?: { operator?: { token?: string; scopes?: string[] } } }
          | undefined;
        const pairedOperator = clonePaired?.tokens?.operator;
        const clientAuthMode = options.clientAuth ?? (pairedOperator ? "matching" : "missing");
        fs.rmSync(cloneAuthFile, { force: true });
        const serializedClientAuth = pairedOperator
          ? JSON.stringify({
              version: 1,
              deviceId,
              tokens: {
                operator: {
                  token:
                    clientAuthMode === "matching"
                      ? pairedOperator.token
                      : "stale-clone-device-token",
                  role: "operator",
                  scopes: pairedOperator.scopes,
                },
              },
            })
          : undefined;
        const writeClientAuth = () =>
          serializedClientAuth === undefined
            ? undefined
            : fs.writeFileSync(cloneAuthFile, serializedClientAuth);
        const setClientAuth = {
          matching: writeClientAuth,
          missing: () => undefined,
          "primary-symlink": () => fs.symlinkSync(primaryAuthFile, cloneAuthFile),
          stale: writeClientAuth,
        } satisfies Record<typeof clientAuthMode, () => void | undefined>;
        setClientAuth[clientAuthMode]();
        return execute(
          options.failApproval,
          options.gatewayToken === undefined ? "secret-token" : options.gatewayToken,
          options.gatewayPort === undefined ? "18789" : options.gatewayPort,
          options.watcherRace,
          options.invalidWatcherState,
          options.timeoutAfterCommit,
          options.devicesRace,
          options.transientPendingPublication ? JSON.stringify(pendingById) : "",
          options.rotatedPendingPublication ? JSON.stringify(pendingById) : "",
          options.hardLinkPending,
        );
      };
      const readApprovals = () =>
        fs.existsSync(approvalsFile)
          ? fs.readFileSync(approvalsFile, "utf-8").trim().split("\n").filter(Boolean)
          : [];
      const readApproveCalls = () =>
        fs.existsSync(approveCallsFile)
          ? fs.readFileSync(approveCallsFile, "utf-8").trim().split("\n").filter(Boolean)
          : [];
      const resetLogs = () => {
        fs.rmSync(approvalsFile, { force: true });
        fs.rmSync(approveCallsFile, { force: true });
        fs.rmSync(approveCheckFile, { force: true });
        fs.rmSync(approveEnvFile, { force: true });
        fs.rmSync(listEnvFile, { force: true });
      };
      const localRequest = {
        requestId: "clone-pairing",
        deviceId,
        publicKey,
        clientId: "cli",
        clientMode: "cli",
        role: "operator",
        roles: ["operator"],
        scopes: ["operator.pairing"],
      };
      const pairedDevice = {
        deviceId,
        publicKey,
        clientId: "cli",
        clientMode: "cli",
        role: "operator",
        roles: ["operator"],
        scopes: ["operator.pairing"],
        approvedScopes: ["operator.pairing"],
        tokens: {
          operator: {
            token: "clone-device-token",
            role: "operator",
            scopes: ["operator.pairing"],
          },
        },
      };
      const foreignRequest = {
        ...localRequest,
        requestId: "primary-pairing",
        deviceId: "f".repeat(64),
        publicKey: "foreign-public-key",
      };
      const primaryLocalRequest = {
        ...localRequest,
        requestId: "primary-local-pairing",
      };
      const primaryPending = JSON.stringify({
        [foreignRequest.requestId]: foreignRequest,
        [primaryLocalRequest.requestId]: primaryLocalRequest,
      });
      fs.writeFileSync(path.join(primaryDevicesDir, "pending.json"), primaryPending);
      const primaryPaired = JSON.stringify({ [deviceId]: pairedDevice });
      fs.writeFileSync(path.join(primaryDevicesDir, "paired.json"), primaryPaired);
      const primaryAuth = JSON.stringify({
        version: 1,
        deviceId,
        tokens: {
          operator: {
            token: "primary-device-token",
            role: "operator",
            scopes: ["operator.pairing"],
          },
        },
      });
      fs.writeFileSync(primaryAuthFile, primaryAuth);

      const initial = run([foreignRequest, localRequest]);
      expect(initial.status).toBe(0);
      expect({
        approvalCalls: readApproveCalls().length,
        approvals: readApprovals().length,
        receipt: parseAutoPairApprovalReceipt(initial.stdout),
        wroteClassifiedEnv: fs.existsSync(approveEnvFile),
      }).toEqual({
        approvalCalls: 0,
        approvals: 0,
        receipt: "request-rejected",
        wroteClassifiedEnv: false,
      });
      expect(initial.stdout.includes(`${SUMMARY_MARKER}=1`)).toBe(false);
      expect(readApprovals()).toEqual([]);

      resetLogs();
      const missingCloneToken = run([localRequest], { gatewayToken: "" });
      expect(parseAutoPairApprovalReceipt(missingCloneToken.stdout)).toBe("request-rejected");
      expect(readApprovals()).toEqual([]);
      expect(fs.existsSync(approveEnvFile)).toBe(false);

      resetLogs();
      const repairRequest = {
        ...localRequest,
        requestId: "clone-write-upgrade",
        isRepair: true,
        scopes: ["operator.pairing", "operator.write"],
      };
      const repair = run([foreignRequest, repairRequest]);
      expect(repair.status).toBe(0);
      expect({
        approvalCalls: readApproveCalls().length,
        approvals: readApprovals().length,
        receipt: parseAutoPairApprovalReceipt(repair.stdout),
        rejectionClass: fs.existsSync(approveCheckFile)
          ? fs.readFileSync(approveCheckFile, "utf-8").trim()
          : "none",
        summaryOne: repair.stdout.includes(`${SUMMARY_MARKER}=1`),
        wroteClassifiedEnv: fs.existsSync(approveEnvFile),
      }).toEqual({
        approvalCalls: 1,
        approvals: 1,
        receipt: "approved-one",
        rejectionClass: "none",
        summaryOne: true,
        wroteClassifiedEnv: true,
      });
      expect(readApprovals()).toEqual(["clone-write-upgrade"]);
      resetLogs();
      const combinedInitialRequest = {
        ...localRequest,
        requestId: "clone-pairing-with-write",
        isRepair: false,
        scopes: ["operator.pairing", "operator.write"],
      };
      const combinedInitial = run([foreignRequest, combinedInitialRequest]);
      expect(combinedInitial.status).toBe(0);
      expect(parseAutoPairApprovalReceipt(combinedInitial.stdout)).toBe("request-rejected");
      expect(readApproveCalls()).toEqual([]);
      expect(readApprovals()).toEqual([]);
      resetLogs();
      const writeOnlyInitialRequest = {
        ...localRequest,
        requestId: "clone-write-only",
        isRepair: false,
        scopes: ["operator.write"],
      };
      const writeOnlyInitial = run([foreignRequest, writeOnlyInitialRequest]);
      expect(writeOnlyInitial.status).toBe(0);
      expect(parseAutoPairApprovalReceipt(writeOnlyInitial.stdout)).toBe("request-rejected");
      expect(readApproveCalls()).toEqual([]);
      expect(readApprovals()).toEqual([]);
      for (const clientAuth of ["missing", "stale"] as const) {
        resetLogs();
        const pairedPreconvergence = run([foreignRequest, writeOnlyInitialRequest], {
          pairedById: { [deviceId]: pairedDevice },
          clientAuth,
        });
        expect(pairedPreconvergence.status).toBe(0);
        expect(parseAutoPairApprovalReceipt(pairedPreconvergence.stdout)).toBe("approved-one");
        expect(readApprovals()).toEqual(["clone-write-only"]);
        expect(fs.readFileSync(approveEnvFile, "utf-8").trim()).toBe(
          `ws://127.0.0.1:18789:unset:clone-paired-token:forced:clone-state-fd:${primaryStateDir}`,
        );
        expect(JSON.parse(fs.readFileSync(cloneAuthFile, "utf-8"))).toMatchObject({
          version: 1,
          deviceId,
          tokens: {
            operator: {
              token: "rotated-clone-device-token",
              role: "operator",
              scopes: ["operator.pairing", "operator.read", "operator.write"],
            },
          },
        });
        expect(fs.readFileSync(primaryAuthFile, "utf-8")).toBe(primaryAuth);
        expect(fs.readFileSync(path.join(primaryDevicesDir, "pending.json"), "utf-8")).toBe(
          primaryPending,
        );
        expect(fs.readFileSync(path.join(primaryDevicesDir, "paired.json"), "utf-8")).toBe(
          primaryPaired,
        );
      }
      for (const gatewayPort of ["", "018789", "65536"] as const) {
        resetLogs();
        const invalidClonePort = run([foreignRequest, writeOnlyInitialRequest], {
          clientAuth: "missing",
          gatewayPort,
          pairedById: { [deviceId]: pairedDevice },
        });
        expect(parseAutoPairApprovalReceipt(invalidClonePort.stdout)).toBe("approve-failed");
        expect(readApproveCalls()).toEqual([]);
        expect(readApprovals()).toEqual([]);
        expect(fs.existsSync(approveEnvFile)).toBe(false);
        expect(fs.readFileSync(path.join(primaryDevicesDir, "pending.json"), "utf-8")).toBe(
          primaryPending,
        );
        expect(fs.readFileSync(primaryAuthFile, "utf-8")).toBe(primaryAuth);
      }
      resetLogs();
      const primaryAuthSymlink = run([writeOnlyInitialRequest], {
        pairedById: { [deviceId]: pairedDevice },
        clientAuth: "primary-symlink",
      });
      expect(parseAutoPairApprovalReceipt(primaryAuthSymlink.stdout)).toBe("request-rejected");
      expect(readApprovals()).toEqual([]);
      expect(fs.existsSync(approveEnvFile)).toBe(false);
      expect(fs.readFileSync(primaryAuthFile, "utf-8")).toBe(primaryAuth);
      resetLogs();
      const clonePendingById = {
        [foreignRequest.requestId]: foreignRequest,
        [writeOnlyInitialRequest.requestId]: writeOnlyInitialRequest,
      };
      const clonePending = JSON.stringify(clonePendingById);
      const clonePairing = run([], { pendingById: clonePendingById });
      expect(clonePairing.status).toBe(0);
      expect(parseAutoPairApprovalReceipt(clonePairing.stdout)).toBe("request-rejected");
      expect(readApproveCalls()).toEqual([]);
      expect(readApprovals()).toEqual([]);
      expect(`${clonePairing.stdout}${clonePairing.stderr}`.includes("raw list output")).toBe(
        false,
      );
      expect(`${clonePairing.stdout}${clonePairing.stderr}`.includes("clone-write-only")).toBe(
        false,
      );
      expect(fs.readFileSync(path.join(devicesDir, "pending.json"), "utf-8")).toBe(clonePending);
      expect(fs.readFileSync(path.join(primaryDevicesDir, "pending.json"), "utf-8")).toBe(
        primaryPending,
      );
      expect(fs.readFileSync(path.join(primaryDevicesDir, "paired.json"), "utf-8")).toBe(
        primaryPaired,
      );
      expect(fs.existsSync(listEnvFile)).toBe(false);
      expect(fs.existsSync(approveEnvFile)).toBe(false);

      const cloneScopePendingById = {
        [foreignRequest.requestId]: foreignRequest,
        [repairRequest.requestId]: repairRequest,
      };
      resetLogs();
      const cloneScopeUpgrade = run([], { pendingById: cloneScopePendingById });
      expect(cloneScopeUpgrade.status).toBe(0);
      expect(parseAutoPairApprovalReceipt(cloneScopeUpgrade.stdout)).toBe("approved-one");
      expect(readApprovals()).toEqual(["clone-write-upgrade"]);
      expect(
        `${cloneScopeUpgrade.stdout}${cloneScopeUpgrade.stderr}`.includes("raw list output"),
      ).toBe(false);
      expect(
        `${cloneScopeUpgrade.stdout}${cloneScopeUpgrade.stderr}`.includes("clone-write-upgrade"),
      ).toBe(false);
      expect(JSON.parse(fs.readFileSync(path.join(devicesDir, "pending.json"), "utf-8"))).toEqual({
        [foreignRequest.requestId]: foreignRequest,
      });
      expect(JSON.parse(fs.readFileSync(cloneAuthFile, "utf-8"))).toMatchObject({
        version: 1,
        deviceId,
        tokens: {
          operator: {
            token: "rotated-clone-device-token",
            role: "operator",
            scopes: ["operator.pairing", "operator.read", "operator.write"],
          },
        },
      });
      expect(fs.readFileSync(path.join(primaryDevicesDir, "pending.json"), "utf-8")).toBe(
        primaryPending,
      );
      expect(fs.readFileSync(path.join(primaryDevicesDir, "paired.json"), "utf-8")).toBe(
        primaryPaired,
      );
      expect(fs.existsSync(listEnvFile)).toBe(false);
      expect(fs.readFileSync(approveEnvFile, "utf-8").trim()).toBe(
        `ws://127.0.0.1:18789:unset:clone-paired-token:forced:clone-state-fd:${primaryStateDir}`,
      );

      resetLogs();
      const watcherWon = run([foreignRequest, repairRequest], {
        pairedById: { [deviceId]: pairedDevice },
        watcherRace: true,
      });
      expect(watcherWon.status).toBe(0);
      expect(parseAutoPairApprovalReceipt(watcherWon.stdout)).toBe("approved-one");
      expect(readApprovals()).toEqual(["clone-write-upgrade"]);
      expect(fs.readFileSync(approveEnvFile, "utf-8").trim().split("\n")).toHaveLength(1);
      expect(
        `${watcherWon.stdout}${watcherWon.stderr}`.includes("raw concurrent approval output"),
      ).toBe(false);
      expect(JSON.parse(fs.readFileSync(path.join(devicesDir, "pending.json"), "utf-8"))).toEqual({
        [foreignRequest.requestId]: foreignRequest,
      });
      expect(JSON.parse(fs.readFileSync(cloneAuthFile, "utf-8"))).toMatchObject({
        version: 1,
        deviceId,
        tokens: {
          operator: {
            token: "rotated-clone-device-token",
            role: "operator",
            scopes: ["operator.pairing", "operator.read", "operator.write"],
          },
        },
      });
      expect(fs.readFileSync(primaryAuthFile, "utf-8")).toBe(primaryAuth);
      expect(fs.readFileSync(path.join(primaryDevicesDir, "pending.json"), "utf-8")).toBe(
        primaryPending,
      );
      expect(fs.readFileSync(path.join(primaryDevicesDir, "paired.json"), "utf-8")).toBe(
        primaryPaired,
      );

      resetLogs();
      const timedOutWithoutPairedBaseline = run([localRequest], {
        timeoutAfterCommit: true,
      });
      expect(parseAutoPairApprovalReceipt(timedOutWithoutPairedBaseline.stdout)).toBe(
        "request-rejected",
      );
      expect(readApproveCalls()).toEqual([]);
      expect(readApprovals()).toEqual([]);
      expect(fs.existsSync(approveEnvFile)).toBe(false);
      expect(
        `${timedOutWithoutPairedBaseline.stdout}${timedOutWithoutPairedBaseline.stderr}`.includes(
          "raw timed-out approval output",
        ),
      ).toBe(false);
      expect(fs.existsSync(cloneAuthFile)).toBe(false);
      expect(fs.readFileSync(primaryAuthFile, "utf-8")).toBe(primaryAuth);
      expect(fs.readFileSync(path.join(primaryDevicesDir, "pending.json"), "utf-8")).toBe(
        primaryPending,
      );
      expect(fs.readFileSync(path.join(primaryDevicesDir, "paired.json"), "utf-8")).toBe(
        primaryPaired,
      );

      resetLogs();
      const timedOutAfterCommit = run([foreignRequest, repairRequest], {
        pairedById: { [deviceId]: pairedDevice },
        timeoutAfterCommit: true,
      });
      expect(timedOutAfterCommit.status).toBe(0);
      expect(parseAutoPairApprovalReceipt(timedOutAfterCommit.stdout)).toBe("approved-one");
      expect(readApprovals()).toEqual(["clone-write-upgrade"]);
      expect(fs.readFileSync(approveEnvFile, "utf-8").trim().split("\n")).toEqual([
        `ws://127.0.0.1:18789:unset:clone-paired-token:forced:clone-state-fd:${primaryStateDir}`,
      ]);
      expect(
        `${timedOutAfterCommit.stdout}${timedOutAfterCommit.stderr}`.includes(
          "raw timed-out approval output",
        ),
      ).toBe(false);
      expect(
        `${timedOutAfterCommit.stdout}${timedOutAfterCommit.stderr}`.includes(
          repairRequest.requestId,
        ),
      ).toBe(false);
      expect(JSON.parse(fs.readFileSync(path.join(devicesDir, "pending.json"), "utf-8"))).toEqual({
        [foreignRequest.requestId]: foreignRequest,
      });
      expect(JSON.parse(fs.readFileSync(cloneAuthFile, "utf-8"))).toMatchObject({
        version: 1,
        deviceId,
        tokens: {
          operator: {
            token: "rotated-clone-device-token",
            role: "operator",
            scopes: ["operator.pairing", "operator.read", "operator.write"],
          },
        },
      });
      expect(fs.readFileSync(primaryAuthFile, "utf-8")).toBe(primaryAuth);
      expect(fs.readFileSync(path.join(primaryDevicesDir, "pending.json"), "utf-8")).toBe(
        primaryPending,
      );
      expect(fs.readFileSync(path.join(primaryDevicesDir, "paired.json"), "utf-8")).toBe(
        primaryPaired,
      );

      resetLogs();
      const invalidTimedOutState = run([foreignRequest, repairRequest], {
        invalidWatcherState: true,
        pairedById: { [deviceId]: pairedDevice },
        timeoutAfterCommit: true,
      });
      expect(invalidTimedOutState.status).toBe(0);
      expect(parseAutoPairApprovalReceipt(invalidTimedOutState.stdout)).toBe("approve-failed");
      expect(readApprovals()).toEqual(["clone-write-upgrade"]);
      expect(fs.readFileSync(approveEnvFile, "utf-8").trim().split("\n")).toHaveLength(1);
      expect(
        `${invalidTimedOutState.stdout}${invalidTimedOutState.stderr}`.includes(
          "raw timed-out approval output",
        ),
      ).toBe(false);
      expect(
        `${invalidTimedOutState.stdout}${invalidTimedOutState.stderr}`.includes(
          repairRequest.requestId,
        ),
      ).toBe(false);
      expect(JSON.parse(fs.readFileSync(cloneAuthFile, "utf-8"))).toMatchObject({
        tokens: {
          operator: {
            token: "clone-device-token",
            scopes: ["operator.pairing"],
          },
        },
      });
      expect(fs.readFileSync(primaryAuthFile, "utf-8")).toBe(primaryAuth);
      expect(fs.readFileSync(path.join(primaryDevicesDir, "pending.json"), "utf-8")).toBe(
        primaryPending,
      );
      expect(fs.readFileSync(path.join(primaryDevicesDir, "paired.json"), "utf-8")).toBe(
        primaryPaired,
      );

      resetLogs();
      const invalidWatcherState = run([foreignRequest, repairRequest], {
        invalidWatcherState: true,
        pairedById: { [deviceId]: pairedDevice },
        watcherRace: true,
      });
      expect(invalidWatcherState.status).toBe(0);
      expect(parseAutoPairApprovalReceipt(invalidWatcherState.stdout)).toBe("approve-failed");
      expect(readApprovals()).toEqual(["clone-write-upgrade"]);
      expect(
        `${invalidWatcherState.stdout}${invalidWatcherState.stderr}`.includes(
          "raw concurrent approval output",
        ),
      ).toBe(false);
      expect(JSON.parse(fs.readFileSync(cloneAuthFile, "utf-8"))).toMatchObject({
        tokens: {
          operator: {
            token: "clone-device-token",
            scopes: ["operator.pairing"],
          },
        },
      });
      expect(fs.readFileSync(primaryAuthFile, "utf-8")).toBe(primaryAuth);

      for (const [pendingById, receipt] of [
        [{ "wrong-map-key": writeOnlyInitialRequest }, "request-rejected"],
        [
          {
            [writeOnlyInitialRequest.requestId]: writeOnlyInitialRequest,
            duplicate: {
              ...foreignRequest,
              requestId: writeOnlyInitialRequest.requestId,
            },
          },
          "clone-ambiguous",
        ],
      ] as const) {
        resetLogs();
        const rejected = run([], { pendingById });
        expect(rejected.status).toBe(0);
        expect(parseAutoPairApprovalReceipt(rejected.stdout)).toBe(receipt);
        expect(readApprovals()).toEqual([]);
        expect(fs.existsSync(listEnvFile)).toBe(false);
      }

      const clonePendingPath = path.join(devicesDir, "pending.json");
      resetLogs();
      fs.rmSync(clonePendingPath, { force: true });
      const unavailable = execute();
      expect(unavailable.status).toBe(0);
      expect(parseAutoPairApprovalReceipt(unavailable.stdout)).toBe("list-pending-unavailable");
      expect(readApprovals()).toEqual([]);
      expect(`${unavailable.stdout}${unavailable.stderr}`.includes("raw list output")).toBe(false);
      expect(fs.existsSync(listEnvFile)).toBe(false);
      expect(fs.readFileSync(path.join(primaryDevicesDir, "pending.json"), "utf-8")).toBe(
        primaryPending,
      );

      for (const [preparePendingState, receipt] of [
        [() => fs.writeFileSync(clonePendingPath, "{"), "list-pending-unstable"],
        [() => fs.writeFileSync(clonePendingPath, "[]"), "list-pending-invalid-shape"],
      ] as const) {
        resetLogs();
        preparePendingState();
        const failed = execute();
        expect(failed.status).toBe(0);
        expect(parseAutoPairApprovalReceipt(failed.stdout)).toBe(receipt);
        expect(readApprovals()).toEqual([]);
        expect(`${failed.stdout}${failed.stderr}`.includes("raw list output")).toBe(false);
        expect(fs.existsSync(listEnvFile)).toBe(false);
        expect(fs.readFileSync(path.join(primaryDevicesDir, "pending.json"), "utf-8")).toBe(
          primaryPending,
        );
      }

      resetLogs();
      const stabilized = run([foreignRequest, repairRequest], {
        transientPendingPublication: true,
      });
      expect(stabilized.status).toBe(0);
      expect(parseAutoPairApprovalReceipt(stabilized.stdout)).toBe("approved-one");
      expect(readApprovals()).toEqual([repairRequest.requestId]);
      expect(`${stabilized.stdout}${stabilized.stderr}`).not.toContain(
        "transient pending publication",
      );

      resetLogs();
      const stabilizedRotation = run([foreignRequest, repairRequest], {
        rotatedPendingPublication: true,
      });
      expect(parseAutoPairApprovalReceipt(stabilizedRotation.stdout)).toBe("approved-one");
      expect(readApprovals()).toEqual([repairRequest.requestId]);

      resetLogs();
      const hardLinked = run([foreignRequest, repairRequest], { hardLinkPending: true });
      expect(parseAutoPairApprovalReceipt(hardLinked.stdout)).toBe("list-pending-unsafe");
      expect(readApprovals()).toEqual([]);

      resetLogs();
      const noMatch = run([foreignRequest]);
      expect(parseAutoPairApprovalReceipt(noMatch.stdout)).toBe("clone-no-match");

      resetLogs();
      const ambiguous = run([
        repairRequest,
        { ...repairRequest, requestId: "second-clone-upgrade" },
      ]);
      expect(parseAutoPairApprovalReceipt(ambiguous.stdout)).toBe("clone-ambiguous");

      resetLogs();
      const rejected = run([{ ...repairRequest, publicKey: "mismatched-public-key" }]);
      expect(parseAutoPairApprovalReceipt(rejected.stdout)).toBe("request-rejected");

      resetLogs();
      const approveFailed = run([repairRequest], { failApproval: true });
      expect(parseAutoPairApprovalReceipt(approveFailed.stdout)).toBe("approve-failed");
      expect(`${approveFailed.stdout}${approveFailed.stderr}`.includes("raw approval output")).toBe(
        false,
      );

      const privatePrimaryRaceRequest = {
        ...repairRequest,
        requestId: "private-primary-devices-race",
      };
      const primaryRacePending = JSON.stringify({
        [privatePrimaryRaceRequest.requestId]: privatePrimaryRaceRequest,
      });
      fs.writeFileSync(path.join(primaryDevicesDir, "pending.json"), primaryRacePending);

      resetLogs();
      fs.rmSync(transientRaceMarker, { force: true });
      const transientDevicesRace = run([foreignRequest], {
        devicesRace: "transient",
        pairedById: { [deviceId]: pairedDevice },
      });
      const transientOutput = `${transientDevicesRace.stdout}${transientDevicesRace.stderr}`;
      expect(parseAutoPairApprovalReceipt(transientDevicesRace.stdout)).toBe("clone-no-match");
      expect(transientDevicesRace.stdout.trim().split(/\r?\n/).length).toBe(1);
      expect(transientDevicesRace.stderr.length).toBe(0);
      expect(fs.existsSync(transientRaceMarker)).toBe(true);
      expect(readApproveCalls().length).toBe(0);
      expect(readApprovals().length).toBe(0);
      expect(transientOutput.includes(privatePrimaryRaceRequest.requestId)).toBe(false);
      expect(transientOutput.includes("raw clone auth-mode mismatch")).toBe(false);
      expect(fs.lstatSync(devicesDir).isSymbolicLink()).toBe(false);
      expect(
        fs.readFileSync(path.join(primaryDevicesDir, "pending.json"), "utf-8") ===
          primaryRacePending,
      ).toBe(true);
      expect(
        fs.readFileSync(path.join(primaryDevicesDir, "paired.json"), "utf-8") === primaryPaired,
      ).toBe(true);
      expect(fs.readFileSync(primaryAuthFile, "utf-8") === primaryAuth).toBe(true);

      resetLogs();
      const persistentDevicesRace = run([foreignRequest], {
        devicesRace: "persistent",
        pairedById: { [deviceId]: pairedDevice },
      });
      const persistentOutput = `${persistentDevicesRace.stdout}${persistentDevicesRace.stderr}`;
      const persistentSwapOccurred =
        fs.existsSync(devicesRaceBackup) &&
        fs.existsSync(devicesDir) &&
        fs.lstatSync(devicesDir).isSymbolicLink();
      expect(persistentSwapOccurred).toBe(true);
      fs.unlinkSync(devicesDir);
      fs.renameSync(devicesRaceBackup, devicesDir);
      expect(parseAutoPairApprovalReceipt(persistentDevicesRace.stdout)).toBe(
        "list-pending-unsafe",
      );
      expect(persistentDevicesRace.stdout.trim().split(/\r?\n/).length).toBe(1);
      expect(persistentDevicesRace.stderr.length).toBe(0);
      expect(readApproveCalls().length).toBe(0);
      expect(readApprovals().length).toBe(0);
      expect(persistentOutput.includes(privatePrimaryRaceRequest.requestId)).toBe(false);
      expect(persistentOutput.includes("raw clone auth-mode mismatch")).toBe(false);
      expect(fs.lstatSync(devicesDir).isSymbolicLink()).toBe(false);
      expect(
        fs.readFileSync(path.join(primaryDevicesDir, "pending.json"), "utf-8") ===
          primaryRacePending,
      ).toBe(true);
      expect(
        fs.readFileSync(path.join(primaryDevicesDir, "paired.json"), "utf-8") === primaryPaired,
      ).toBe(true);
      expect(fs.readFileSync(primaryAuthFile, "utf-8") === primaryAuth).toBe(true);

      resetLogs();
      fs.rmSync(childRaceMarker, { force: true });
      fs.rmSync(stateRaceBackup, { recursive: true, force: true });
      const childEntryRace = run([foreignRequest, repairRequest], {
        clientAuth: "missing",
        devicesRace: "child-entry",
        pairedById: { [deviceId]: pairedDevice },
      });
      const childEntryOutput = `${childEntryRace.stdout}${childEntryRace.stderr}`;
      expect(parseAutoPairApprovalReceipt(childEntryRace.stdout)).toBe("approved-one");
      expect(childEntryRace.stdout.trim().split(/\r?\n/).length).toBe(2);
      expect(childEntryRace.stderr.length).toBe(0);
      expect(fs.existsSync(childRaceMarker)).toBe(true);
      expect(fs.existsSync(stateRaceBackup)).toBe(false);
      expect(fs.lstatSync(stateDir).isSymbolicLink()).toBe(false);
      expect(readApproveCalls()).toEqual(["called"]);
      expect(readApprovals()).toEqual([repairRequest.requestId]);
      expect(childEntryOutput.includes(privatePrimaryRaceRequest.requestId)).toBe(false);
      expect(childEntryOutput.includes("raw clone auth-mode mismatch")).toBe(false);
      expect(JSON.parse(fs.readFileSync(path.join(devicesDir, "pending.json"), "utf-8"))).toEqual({
        [foreignRequest.requestId]: foreignRequest,
      });
      expect(JSON.parse(fs.readFileSync(cloneAuthFile, "utf-8"))).toMatchObject({
        version: 1,
        deviceId,
        tokens: {
          operator: {
            token: "rotated-clone-device-token",
            scopes: ["operator.pairing", "operator.read", "operator.write"],
          },
        },
      });
      expect(fs.readFileSync(path.join(primaryDevicesDir, "pending.json"), "utf-8")).toBe(
        primaryRacePending,
      );
      expect(fs.readFileSync(path.join(primaryDevicesDir, "paired.json"), "utf-8")).toBe(
        primaryPaired,
      );
      expect(fs.readFileSync(primaryAuthFile, "utf-8")).toBe(primaryAuth);
      fs.writeFileSync(path.join(primaryDevicesDir, "pending.json"), primaryPending);

      for (const pairedById of [
        { [deviceId]: { ...pairedDevice, publicKey: "mismatched-public-key" } },
        { "wrong-device-map-key": pairedDevice },
        {
          [deviceId]: {
            ...pairedDevice,
            tokens: [pairedDevice.tokens.operator],
          },
        },
        {
          [deviceId]: {
            ...pairedDevice,
            tokens: {
              ...pairedDevice.tokens,
              auditor: {
                token: "unrelated-token",
                role: "auditor",
                scopes: ["operator.pairing"],
              },
            },
          },
        },
        {
          [deviceId]: {
            ...pairedDevice,
            tokens: {
              operator: {
                ...pairedDevice.tokens.operator,
                scopes: ["operator.pairing", "operator.admin"],
              },
            },
          },
        },
      ]) {
        resetLogs();
        const malformedPaired = run([repairRequest], { pairedById });
        expect(parseAutoPairApprovalReceipt(malformedPaired.stdout)).toBe("request-rejected");
        expect(readApprovals()).toEqual([]);
        expect(fs.existsSync(approveEnvFile)).toBe(false);
      }

      const { scopes: _ignoredScopes, ...repairWithoutScopes } = repairRequest;
      for (const rejected of [
        [foreignRequest],
        [{ ...repairRequest, publicKey: "mismatched-public-key" }],
        [repairRequest, { ...repairRequest, requestId: "second-clone-upgrade" }],
        [repairRequest, { ...foreignRequest, requestId: repairRequest.requestId }],
        [{ ...repairRequest, scopes: ["operator.admin"] }],
        [{ ...repairRequest, requestedScopes: ["operator.admin"] }],
        [{ ...repairRequest, requestedScopes: repairRequest.scopes }],
        [{ ...repairRequest, scopes: [] }],
        [{ ...localRequest, requestId: "unpaired-read-only", scopes: ["operator.read"] }],
        [repairWithoutScopes],
      ]) {
        resetLogs();
        const result = run(rejected);
        expect(result.status).toBe(0);
        expect(result.stdout.includes(`${SUMMARY_MARKER}=1`)).toBe(false);
        expect(readApprovals()).toEqual([]);
      }

      resetLogs();
      const hashMismatchedDeviceId = "0".repeat(64);
      fs.writeFileSync(
        path.join(identityDir, "device.json"),
        JSON.stringify({ deviceId: hashMismatchedDeviceId, publicKey }),
      );
      const invalidIdentity = run([{ ...localRequest, deviceId: hashMismatchedDeviceId }]);
      expect(invalidIdentity.status).toBe(0);
      expect(invalidIdentity.stdout.includes(`${SUMMARY_MARKER}=1`)).toBe(false);
      expect(readApprovals()).toEqual([]);
      expect(fs.existsSync(approveEnvFile)).toBe(false);
      expect(fs.existsSync(listEnvFile)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("leaves a failed compatibility-shaped approval retryable without editing device state", () => {
    if (spawnSync("sh", ["-c", "command -v python3"], { stdio: "ignore" }).status !== 0) {
      return;
    }
    const policy = readAutoPairApprovalPolicyModule();
    expect(policy).toBeTruthy();
    const policyB64 = Buffer.from(policy as string, "utf-8").toString("base64");
    const script = buildAutoPairApprovalScript(policyB64, { emitSummary: true });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-recover-"));
    try {
      const stateDir = path.join(tmpDir, "openclaw-state");
      const devicesDir = path.join(stateDir, "devices");
      const pendingFile = path.join(devicesDir, "pending.json");
      const pairedFile = path.join(devicesDir, "paired.json");
      fs.mkdirSync(devicesDir, { recursive: true });
      fs.writeFileSync(
        pendingFile,
        JSON.stringify({
          original: {
            requestId: "upgrade-1",
            deviceId: "device-1",
            publicKey: "public-key-1",
            clientId: "openclaw-cli",
            clientMode: "cli",
            role: "operator",
            roles: ["operator"],
            scopes: ["operator.write"],
          },
        }),
      );
      fs.writeFileSync(
        pairedFile,
        JSON.stringify({
          "device-1": {
            deviceId: "device-1",
            publicKey: "public-key-1",
            clientId: "openclaw-cli",
            clientMode: "cli",
            role: "operator",
            roles: ["operator"],
            scopes: ["operator.pairing"],
            approvedScopes: ["operator.pairing"],
            tokens: { operator: { role: "operator", scopes: ["operator.pairing"] } },
          },
        }),
      );
      const listResponse = JSON.stringify({
        pending: [
          {
            requestId: "upgrade-1",
            deviceId: "device-1",
            publicKey: "public-key-1",
            clientId: "openclaw-cli",
            clientMode: "cli",
            role: "operator",
            roles: ["operator"],
            scopes: ["operator.write"],
          },
        ],
        paired: [],
      });
      fs.writeFileSync(
        path.join(tmpDir, "openclaw"),
        `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "devices" && args[1] === "list") {
  process.stdout.write(${JSON.stringify(`${listResponse}\n`)});
  process.exit(0);
}
if (args[0] === "devices" && args[1] === "approve") {
  process.stderr.write("GatewayClientRequestError: scope upgrade pending approval for requestId upgrade-1\\n");
  process.exit(1);
}
process.exit(2);
`,
        { mode: 0o755 },
      );

      const result = spawnSync("sh", ["-c", script], {
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: `${tmpDir}:/usr/bin:/bin`,
          OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
          OPENCLAW_GATEWAY_PORT: "18789",
          OPENCLAW_GATEWAY_TOKEN: "secret-token",
          OPENCLAW_STATE_DIR: stateDir,
        },
        timeout: 10_000,
      });

      const pending = JSON.parse(fs.readFileSync(pendingFile, "utf-8"));
      const paired = JSON.parse(fs.readFileSync(pairedFile, "utf-8"));
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`${SUMMARY_MARKER}=0`);
      expect(pending).toEqual({
        original: {
          requestId: "upgrade-1",
          deviceId: "device-1",
          publicKey: "public-key-1",
          clientId: "openclaw-cli",
          clientMode: "cli",
          role: "operator",
          roles: ["operator"],
          scopes: ["operator.write"],
        },
      });
      expect(paired["device-1"].approvedScopes).toEqual(["operator.pairing"]);
      expect(paired["device-1"].tokens.operator.scopes).toEqual(["operator.pairing"]);
      expect(JSON.stringify(paired)).not.toContain("operator.admin");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not recover approval failures without the compatibility signature (#4462)", () => {
    if (spawnSync("sh", ["-c", "command -v python3"], { stdio: "ignore" }).status !== 0) {
      return;
    }
    const policy = readAutoPairApprovalPolicyModule();
    expect(policy).toBeTruthy();
    const policyB64 = Buffer.from(policy as string, "utf-8").toString("base64");
    const script = buildAutoPairApprovalScript(policyB64, { emitSummary: true });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-denied-"));
    try {
      const stateDir = path.join(tmpDir, "openclaw-state");
      const devicesDir = path.join(stateDir, "devices");
      const pendingFile = path.join(devicesDir, "pending.json");
      const pairedFile = path.join(devicesDir, "paired.json");
      fs.mkdirSync(devicesDir, { recursive: true });
      const pendingState = {
        original: {
          requestId: "upgrade-1",
          deviceId: "device-1",
          clientId: "openclaw-cli",
          clientMode: "cli",
          scopes: ["operator.write"],
        },
      };
      const pairedState = {
        "device-1": {
          deviceId: "device-1",
          scopes: ["operator.pairing"],
          approvedScopes: ["operator.pairing"],
          tokens: { operator: { role: "operator", scopes: ["operator.pairing"] } },
        },
      };
      fs.writeFileSync(pendingFile, JSON.stringify(pendingState));
      fs.writeFileSync(pairedFile, JSON.stringify(pairedState));
      const listResponse = JSON.stringify({ pending: [pendingState.original], paired: [] });
      fs.writeFileSync(
        path.join(tmpDir, "openclaw"),
        `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "devices" && args[1] === "list") {
  process.stdout.write(${JSON.stringify(`${listResponse}\n`)});
  process.exit(0);
}
if (args[0] === "devices" && args[1] === "approve") {
  process.stderr.write("authorization denied\\n");
  process.exit(1);
}
process.exit(2);
`,
        { mode: 0o755 },
      );

      const result = spawnSync("sh", ["-c", script], {
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: `${tmpDir}:/usr/bin:/bin`,
          OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
          OPENCLAW_GATEWAY_PORT: "18789",
          OPENCLAW_GATEWAY_TOKEN: "secret-token",
          OPENCLAW_STATE_DIR: stateDir,
        },
        timeout: 10_000,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`${SUMMARY_MARKER}=0`);
      expect(JSON.parse(fs.readFileSync(pendingFile, "utf-8"))).toEqual(pendingState);
      expect(JSON.parse(fs.readFileSync(pairedFile, "utf-8"))).toEqual(pairedState);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
