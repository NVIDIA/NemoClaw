// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  AUTO_PAIR_MAX_APPROVALS,
  buildAutoPairApprovalScript,
  parseAutoPairApprovalReceipt,
  readAutoPairApprovalPolicyModule,
} from "./auto-pair-approval";

const SUMMARY_MARKER = "__NEMOCLAW_AUTO_PAIR_APPROVED__";
const RECEIPT_MARKER = "__NEMOCLAW_AUTO_PAIR_RECEIPT__";

describe("buildAutoPairApprovalScript (#4263/#4616)", () => {
  it("builds the bounded allowlisted approval pass", () => {
    const script = buildAutoPairApprovalScript("UE9MSUNZ");
    expect(script).toContain("/tmp/nemoclaw-proxy-env.sh");
    expect(script).toContain("command -v openclaw");
    expect(script).toContain("command -v python3");
    expect(script).toContain("'devices', 'list', '--json'");
    expect(script).toContain("'devices', 'approve'");
    expect(script).toContain("approval_request_decision(device)");
    expect(script).toContain("if not decision['allowed']:");
    expect(script).toContain("list_env['NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT'] = '1'");
    expect(script).toContain("approve_env = gateway_approval_env(os.environ)");
    expect(script).toContain("approve_env.pop('NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT', None)");
    expect(script).toContain(`MAX_APPROVALS = ${AUTO_PAIR_MAX_APPROVALS}`);
    expect(script).toContain("'UE9MSUNZ'");
  });

  it("adds local-device filtering only for restored-clone approval", () => {
    const ordinary = buildAutoPairApprovalScript("UE9MSUNZ");
    const restoredClone = buildAutoPairApprovalScript("UE9MSUNZ", {
      emitReceipt: true,
      localDeviceOnly: true,
      budget: { maxApprovals: AUTO_PAIR_MAX_APPROVALS },
    });

    expect(ordinary).not.toContain("local_identity_public_key");
    expect(ordinary).toContain("approve_env.pop('NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING', None)");
    expect(ordinary).toContain("approve_env.pop('NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT', None)");
    expect(ordinary).toContain("approve_env.pop('NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING', None)");
    expect(ordinary).not.toContain("approve_env['NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING'] = '1'");
    expect(ordinary).not.toContain("approve_env['NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING'] = '1'");
    expect(ordinary).not.toContain("load_clone_local_pending");
    expect(ordinary).not.toContain("open_clone_state_root");
    expect(ordinary).not.toContain("pass_fds=");
    expect(ordinary).not.toContain("NODE_DISABLE_COMPILE_CACHE");
    expect(ordinary).not.toContain("OPENCLAW_NO_RESPAWN");
    expect(restoredClone).toContain("local_identity_public_key");
    expect(restoredClone).toContain(
      "approve_env.pop('NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING', None)",
    );
    expect(restoredClone).toContain(
      "approve_env.pop('NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING', None)",
    );
    expect(restoredClone).not.toContain(
      "approve_env['NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING'] = '1'",
    );
    expect(restoredClone).toContain(
      "approve_env['NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING'] = '1'",
    );
    expect(restoredClone).not.toContain("'devices', 'list', '--json'");
    expect(restoredClone).toContain("'pending.json'");
    expect(restoredClone).toContain("'paired.json'");
    expect(restoredClone).not.toContain("local_approval_auth_mode == 'runtime'");
    expect(restoredClone).not.toContain("os.environ.get('OPENCLAW_GATEWAY_TOKEN'");
    expect(restoredClone).toContain("local_approval_auth_mode == 'paired-token'");
    expect(restoredClone).toContain("sync_approved_clone_device_auth");
    expect(restoredClone).toContain("os.O_DIRECTORY | os.O_NOFOLLOW");
    expect(restoredClone).toContain("getattr(os, 'O_PATH', os.O_RDONLY)");
    expect(restoredClone).toContain("dir_fd=clone_state_dir_fd");
    expect(restoredClone).toContain("clone_devices_dir_fd,");
    expect(restoredClone).toContain("clone_identity_dir_fd,");
    expect(restoredClone).toContain("pass_fds=approval_pass_fds");
    expect(restoredClone).toContain("approve_env['NODE_DISABLE_COMPILE_CACHE'] = '1'");
    expect(restoredClone).toContain("approve_env['OPENCLAW_NO_RESPAWN'] = '1'");
    expect(restoredClone).toContain("approve_env.pop('OPENCLAW_GATEWAY_TOKEN', None)");
    expect(restoredClone).toContain(
      "approve_env['OPENCLAW_STATE_DIR'] = f'/proc/self/fd/{clone_state_dir_fd}'",
    );
    expect(restoredClone).toContain("approve_env['NEMOCLAW_OPENCLAW_PENDING_FD']");
    expect(restoredClone).toContain("approve_env['NEMOCLAW_OPENCLAW_PAIRED_FD']");
    expect(restoredClone).toContain("approve_env['NEMOCLAW_OPENCLAW_IDENTITY_FD']");
    expect(restoredClone).toContain("clone_directory_is_current('devices'");
    expect(restoredClone).toContain("if not related_pending:");
    expect(restoredClone).toContain("len(related_pending) > 1");
    expect(restoredClone).toContain("pending = related_pending");
    expect(restoredClone).toContain("MAX_APPROVALS = 1");
    expect(restoredClone).toContain(RECEIPT_MARKER);
  });

  it("omits the summary marker by default and appends it when requested", () => {
    const silent = buildAutoPairApprovalScript("UE9MSUNZ");
    const reporting = buildAutoPairApprovalScript("UE9MSUNZ", { emitSummary: true });
    expect(silent).not.toContain(SUMMARY_MARKER);
    expect(silent).not.toContain(RECEIPT_MARKER);
    expect(reporting).toContain(`print(f'${SUMMARY_MARKER}={approved_count}')`);
    // The reporting script is the silent script with exactly the summary line
    // inserted before the heredoc terminator — nothing else changes.
    const stripped = reporting.replace(`print(f'${SUMMARY_MARKER}={approved_count}')\n`, "");
    expect(stripped).toBe(silent);
  });

  it("reads the real policy module from disk", () => {
    const module = readAutoPairApprovalPolicyModule();
    expect(module).toBeTruthy();
    expect(module).toContain("def approval_request_decision");
    expect(module).toContain("def gateway_approval_env");
    expect(module).not.toContain("recover_failed_scope_approval");
  });

  it.each([
    "approved-one",
    "list-failed",
    "list-state-path-invalid",
    "list-platform-unsupported",
    "list-state-root-failed",
    "list-devices-directory-failed",
    "list-pending-unsafe",
    "list-pending-unstable",
    "list-pending-invalid-shape",
    "list-pending-unavailable",
    "list-timeout",
    "list-exec-failed",
    "list-scope-upgrade-pending",
    "list-device-pairing-required",
    "list-gateway-connect-failed",
    "list-command-failed",
    "list-empty-output",
    "list-invalid-json",
    "list-invalid-output",
    "list-missing-pending",
  ] as const)("accepts the terminal fixed receipt %s", (receipt) => {
    expect(
      parseAutoPairApprovalReceipt(`ignored setup output\n${RECEIPT_MARKER}=${receipt}\n`),
    ).toBe(receipt);
  });

  it.each([
    `${RECEIPT_MARKER}=approved-one\nlater output\n`,
    `${RECEIPT_MARKER}=approve-failed\n${RECEIPT_MARKER}=approved-one\n`,
    `${RECEIPT_MARKER}=raw-request-id\n`,
  ])("rejects a non-terminal, duplicate, or unknown receipt [case %#]", (output) => {
    expect(parseAutoPairApprovalReceipt(output)).toBeNull();
  });
});
