// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { RUNTIME_STATE_MUTATION_CONTROL_HARNESS } from "../helpers/runtime-state-mutation-control-harness.ts";

const CONTROLLER = path.join(
  import.meta.dirname,
  "../../scripts/runtime-state-mutation-control.py",
);

let harnessResult: Record<string, unknown>;

beforeAll(() => {
  const result = spawnSync(
    "python3",
    ["-I", "-c", RUNTIME_STATE_MUTATION_CONTROL_HARNESS, CONTROLLER],
    {
      encoding: "utf8",
      timeout: 15_000,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  harnessResult = JSON.parse(result.stdout) as Record<string, unknown>;
});

describe("runtime state mutation controller", () => {
  it("accepts only the canonical adapter request and transaction binding (#7744)", () => {
    expect(harnessResult.canonical).toMatch(/^[0-9a-f]{64}$/u);
    expect(harnessResult).toMatchObject({
      noncanonical: "envelope-schema",
      duplicate: "duplicate-json-field",
      boolean_version: "envelope-version",
      transaction: "transaction-binding-mismatch",
      restore: "plan-schema",
      unsorted_selectors: "plan-selector-order",
      plus_generation: "generation+7",
      punctuation_generation: "lifecycle-generation",
      podman_provider: "podman",
      podman_handle: expect.stringMatching(/^podman-state-mutation-v1:/u),
      cross_provider_handle: "provider-handle",
    });
  });

  it("holds exact OpenShell and managed-image entrypoint identities through recovery (#9485)", () => {
    expect(harnessResult).toMatchObject({
      acquire: "fenced",
      assert: "fenced",
      managed_start_with_cmd: true,
      prefixed_start: false,
      reordered_start: false,
      bare_direct_start: false,
      bare_interpreted_start: false,
      acquire_fence: {
        supervisor: {
          pid: 1,
          startIdentity: "100",
          executableDevice: "81",
          executableInode: "10101",
        },
        start: { pid: 10, startIdentity: "200", parentPid: 1 },
        startSupport: [
          { pid: 75, parentPid: 10 },
          { pid: 76, parentPid: 10 },
        ],
        writerUids: [1000, 1001],
      },
      discovered_pid1: 1,
      discovered_start: 10,
      wrong_pid1: "supervisor-unavailable",
      supervisor_identity_drift: "supervisor-identity-drift",
      start_identity_drift: "start-process-identity-drift",
      startup_support_identity_drift: "startup-support-identity-drift",
      running_supervisor_hold: "supervisor-not-host-stopped",
      fixed_transport_broker: 88,
      forged_transport_broker_rejected: true,
      wrong_argv_transport_broker_rejected: true,
      dynamic_transport_broker_rejected: true,
    });
    expect(harnessResult.hold_events).toEqual([
      ["stop", 10],
      ["stop", 75],
      ["stop", 76],
      ["stop", 77],
      ["stop", 78],
      ["exclude", [10, 75, 76, 77, 78]],
      ["assert-writers", [10, 75, 76, 77, 78]],
    ]);
    const events = harnessResult.state_events as unknown[][];
    expect(events.slice(0, 5)).toEqual([
      ["capture"],
      ["discover", "mnt:[401]"],
      ["hold", "mnt:[401]", 10, null],
      ["capture"],
      ["assert", "fenced", false],
    ]);
    expect(harnessResult.state_transition_preserves_identity).toBe(true);
  });

  it("terminates every other writer and preserves only exact stopped processes (#7744)", () => {
    expect(harnessResult.writer_signals).toEqual([[42, 15]]);
    expect(harnessResult.writer_scans_remaining).toBe(0);
    expect(harnessResult.unstoppable_writer).toBe("writer-exclusion-timeout");
    expect(harnessResult.unknown_writer).toBe("unreadable-writer-process");
    expect(harnessResult.vanished_process).toBe(true);
    expect(harnessResult.unreadable_process_io).toBe("unreadable-writer-process");
  });

  it("rescans when an unexpected writer changes identity before signalling (#10155)", () => {
    expect(harnessResult.writer_pid_reuse_signals).toEqual([[42, 15]]);
    expect(harnessResult.writer_pid_reuse_scans_remaining).toBe(0);
  });

  it("keeps recapturing an exact process reference across raced signals (#10155)", () => {
    const sigstop = harnessResult.sigstop as number;
    expect(harnessResult.reference_signal_attempts).toEqual([
      [10, sigstop],
      [10, sigstop],
      [10, sigstop],
      [10, sigstop],
    ]);
    expect(harnessResult.replaced_reference_signal).toBe("fenced-process-drift");
    expect(harnessResult.reference_signal_timeout).toBe("writer-pid-reused");
  });

  it("signals the same kernel task after mutable process metadata changes (#9485)", () => {
    const sigstop = harnessResult.sigstop as number;
    expect(harnessResult.same_task_signal).toBe("ok");
    expect(harnessResult.same_task_signal_events).toEqual([
      ["open", 10, 0],
      ["signal", 91, sigstop],
      ["close", 91],
    ]);
    expect(harnessResult.replacement_task_signal).toBe("writer-pid-reused");
    expect(harnessResult.replacement_task_signal_events).toEqual([
      ["open", 10, 0],
      ["close", 91],
    ]);
    expect(harnessResult.same_task_executable_replacement_signal).toBe("writer-pid-reused");
    expect(harnessResult.same_task_executable_replacement_signal_events).toEqual([
      ["open", 10, 0],
      ["close", 91],
    ]);
  });

  it("retains supervisor argv refreshes but rejects same-task executable replacement (#9485)", () => {
    expect(harnessResult.refreshed_supervisor).toBe("ok");
    expect(harnessResult.replaced_supervisor).toBe("supervisor-identity-drift");
    expect(harnessResult.exec_replaced_supervisor).toBe("supervisor-identity-drift");
  });

  it("publishes, rolls an activated fence back, and recovers every durable phase (#7744)", () => {
    expect(harnessResult).toMatchObject({
      publish: "published",
      activate: "activation-proven",
      rollback_after_activation: "rolled-back",
      rollback_retired: true,
      recover_activation: "activation-proven",
      wrong_binding: "active-fence-binding-mismatch",
      stale_release_preserves_active: true,
    });
    const events = harnessResult.state_events as unknown[][];
    expect(events).toContainEqual(["posture", "locked"]);
    expect(events).toContainEqual(["posture", "mutable"]);
    expect(events).toContainEqual(["retire", "rolled-back", true]);
    expect(events).toContainEqual(["hold", "mnt:[401]", 10, 77]);
    expect(events).toContainEqual(["activation-receipt", "activation-proven"]);
  });

  it("creates public protocol files privately before applying their final mode (#7744)", () => {
    expect(harnessResult.atomic_write_modes).toEqual([[0o600], 0o444]);
  });

  it("uses the fixed publisher contract and rejects unbound evidence (#7744)", () => {
    expect(harnessResult).toMatchObject({
      publisher_valid: "ok",
      publisher_bad_receipt: "publisher-receipt-invalid",
      publisher_error: "publisher-posture-refused",
    });
    expect(harnessResult.publisher_calls).toEqual([
      [expect.stringMatching(/^[0-9a-f]{64}$/u), "locked"],
    ]);
  });

  it("proves and freezes a fresh Hermes activation before it returns evidence (#7744)", () => {
    const sigcont = harnessResult.sigcont as number;
    expect(harnessResult.activation_events).toEqual([
      ["guard-start"],
      ["assert-fence"],
      ["permit"],
      ["signal", 10, sigcont],
      ["checkpoint"],
      ["wait-gateway"],
      ["freeze-tree"],
      ["verify-checkpoint"],
      ["guard-disarm"],
    ]);
    expect(harnessResult.activation_failure_events).toEqual([
      ["guard-start"],
      ["assert-fence"],
      ["permit"],
      ["signal", 10, sigcont],
      ["checkpoint"],
      ["guard-hold"],
    ]);
    expect(harnessResult.activation_retry_events).toEqual([
      ["guard-start"],
      ["restore-hold"],
      ["retry-exec-ack"],
      ["permit"],
      ["signal", 10, sigcont],
      ["checkpoint"],
      ["wait-gateway"],
      ["freeze-tree"],
      ["verify-checkpoint"],
      ["guard-disarm"],
    ]);
    expect(harnessResult.activation_failure).toBe("activation-timeout");
    expect(harnessResult.live_proof).toMatchObject({
      service: 77,
      generation: `sha256:${"a".repeat(64)}`,
      listener: "tcp:18642:991",
      health: expect.stringMatching(/^[0-9a-f]{64}$/u),
      checkpoint: "c".repeat(64),
    });
    expect(harnessResult.network_namespace_health).toMatchObject({
      status: 200,
      finalNamespace: "net:[401]",
      events: expect.arrayContaining([
        ["setns", 902, 0x40000000],
        ["connect", "127.0.0.1", 18642, 3, "net:[402]"],
        ["setns", 901, 0x40000000],
      ]),
    });
    expect(harnessResult.activation_receipt).toBe("ok");
    expect(harnessResult.activation_receipt_tamper).toBe("activation-receipt-mismatch");
  });

  it("resumes exact-process activation cleanup after every unlink boundary (#7744)", () => {
    const faults = harnessResult.cleanup_faults as Record<string, Record<string, unknown>>;
    expect(Object.keys(faults).sort()).toEqual(
      [
        "activation-permit.json",
        "activation-release.json",
        "activation-retry.json",
        "startup-complete.json",
        "retry-ack.json",
        "candidate-directory",
        "activation-cleanup.json",
      ].sort(),
    );
    Object.values(faults).forEach((result) => {
      expect(result).toEqual({
        faulted: true,
        progressRecorded: true,
        pending: false,
        clean: true,
      });
    });
  });

  it("records release intent before resuming exact writers and waits for parent acknowledgement (#10155)", () => {
    const sigcont = harnessResult.sigcont as number;
    expect(harnessResult).toMatchObject({
      release: "activation-proven",
      released_marker: true,
      released_sentinel: true,
      released_state: "complete",
      release_retry: "activation-proven",
      recover_released: "activation-proven",
      released_reacquire: "transaction-already-released",
    });
    expect(harnessResult.release_events).toEqual([
      ["verify-checkpoint"],
      ["release-receipt"],
      ["resume", 75],
      ["resume", 76],
      ["resume", 77],
      ["resume", 78],
      ["resume", 10],
      ["signal", 1, sigcont],
      ["release-ack"],
      ["parent-ack-health"],
    ]);
    expect(harnessResult.release_retry_events).toEqual([
      ["verify-checkpoint"],
      ["release-receipt"],
      ["release-ack"],
      ["parent-ack-health"],
    ]);
    expect(harnessResult.transient_exit_release_events).toEqual([
      ["verify-checkpoint"],
      ["release-receipt"],
      ["resume", 75],
      ["resume", 76],
      ["resume", 77],
      ["resume", 10],
      ["signal", 1, sigcont],
      ["release-ack"],
      ["parent-ack-health"],
    ]);
    expect(harnessResult.persistent_exit_release).toBe("activation-process-drift");
    const events = harnessResult.state_events as unknown[][];
    expect(events).toContainEqual(["release-hold", "intent"]);
    expect(events).toContainEqual(["release-parent-resume", "acknowledged"]);
    expect(events).toContainEqual(["protocol-cleanup", "activation-proven"]);
  });

  it("re-holds a real writer when the activation controller is SIGKILLed (#7744)", () => {
    const sigstop = harnessResult.sigstop as number;
    expect(harnessResult.kernel_namespace_broadcast).toEqual([[-1, sigstop]]);
    expect(harnessResult.live_controller_hold_events).toEqual([
      ["stop", [11, 12]],
      ["resume", 13],
      ["resume", 14],
    ]);
    expect(harnessResult).toMatchObject({
      live_guard_hold_command: true,
      guardian_controller_ready: true,
      guardian_client_eof: true,
      guardian_held_after_sigkill: true,
      guardian_retains_controller_lock: true,
      guardian_releases_controller_lock: true,
      guardian_blocks_mutation: true,
      guardian_writer_stopped: true,
      last_resort_controller_ready: true,
      last_resort_client_eof: true,
      last_resort_writer_stopped: true,
      last_resort_retains_controller_lock: true,
      last_resort_blocks_mutation: true,
      last_resort_procfs_independent: true,
      last_resort_external_recovery: true,
      retry_exec_ack: true,
      retry_exec_states: "unset\n1\n",
      retry_trap_seen: true,
      retry_stopped_before: true,
      retry_exec_pid_stable: true,
      retry_exec_start_stable: true,
      retry_exec_command_stable: true,
    });
  });

  it("refuses procfs outside the container PID namespace (#7744)", () => {
    expect(harnessResult.private_proc).toBe("ok");
    expect(harnessResult.host_proc).toBe("unsafe-proc-namespace");
    expect(harnessResult.foreign_pid_namespace).toBe("unsafe-proc-namespace");
  });
});
