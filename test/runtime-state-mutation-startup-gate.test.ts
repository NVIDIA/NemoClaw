// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const GATE = path.join(
  import.meta.dirname,
  "..",
  "scripts",
  "runtime-state-mutation-startup-gate.py",
);

const HARNESS = String.raw`
import hashlib
import importlib.util
import json
import os
import sys
import tempfile

spec = importlib.util.spec_from_file_location("runtime_state_startup_gate", sys.argv[1])
gate = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = gate
spec.loader.exec_module(gate)
gate.ROOT_UID = os.getuid()
gate.ROOT_GID = os.getgid()

start = {
    "pid": 41,
    "startIdentity": "9001",
    "parentPid": 1,
    "uids": [1001, 1001, 1001, 1001],
    "commandSha256": "a" * 64,
    "procDevice": "22",
    "procInode": "33",
}
gate._capture_parent = lambda: start

def write(path, value, mode):
    if os.path.exists(path):
        os.chmod(path, 0o600)
    with open(path, "wb") as stream:
        stream.write(gate._canonical(value) + b"\n")
    os.chmod(path, mode)

def code(call):
    try:
        return call()
    except gate.GateError as error:
        return str(error)

results = {}
results["uses_o_path_when_available"] = not hasattr(os, "O_PATH") or bool(
    gate._directory_flags() & os.O_PATH
)
results["readable_final_is_read_only"] = (
    gate._directory_flags(readable=True) & os.O_ACCMODE
) == os.O_RDONLY
results["readable_final_excludes_o_path"] = not hasattr(os, "O_PATH") or not bool(
    gate._directory_flags(readable=True) & os.O_PATH
)
with tempfile.TemporaryDirectory() as root:
    root = os.path.realpath(root)
    durable = os.path.join(root, "durable")
    handoff = os.path.join(root, "handoff")
    os.mkdir(durable, 0o711)
    os.chmod(durable, 0o711)
    os.mkdir(handoff, 0o711)
    os.chmod(handoff, 0o711)
    gate.DURABLE_DIRECTORY = durable
    gate.HANDOFF_ROOT = handoff

    results["inactive"] = gate._run("admit")
    write(os.path.join(durable, gate.ACTIVE_NAME), {"active": True}, 0o600)
    results["unpermitted"] = code(lambda: gate._run("admit"))

    nonce = "b" * 64
    candidate_directory = os.path.join(handoff, nonce)
    os.mkdir(candidate_directory, 0o700)
    os.chmod(candidate_directory, 0o700)
    permit = {
        "schemaVersion": 1,
        "protocol": gate.PERMIT_PROTOCOL,
        "transactionId": "c" * 64,
        "nonce": nonce,
        "markerSha256": "d" * 64,
        "start": start,
        "candidateDirectory": candidate_directory,
    }
    write(os.path.join(durable, gate.PERMIT_NAME), permit, 0o444)
    results["admitted"] = gate._run("admit")

    orphan = os.path.join(candidate_directory, ".startup-complete.json.91.interrupted")
    with open(orphan, "wb") as stream:
        stream.write(b"interrupted")
    os.chmod(orphan, 0o600)
    results["checkpoint"] = gate._run("checkpoint")
    results["checkpoint_retry"] = gate._run("checkpoint")
    candidate_path = os.path.join(candidate_directory, gate.CANDIDATE_NAME)
    with open(candidate_path, "rb") as stream:
        candidate = stream.read()
    results["candidate"] = json.loads(candidate)

    permit_path = os.path.join(durable, gate.PERMIT_NAME)
    with open(permit_path, "rb") as stream:
        permit_payload = stream.read()
    retry = {
        "schemaVersion": 1,
        "protocol": gate.RETRY_PROTOCOL,
        "transactionId": permit["transactionId"],
        "nonce": nonce,
        "permitSha256": hashlib.sha256(permit_payload).hexdigest(),
        "checkpointSha256": hashlib.sha256(candidate).hexdigest(),
        "start": start,
        "candidateDirectory": candidate_directory,
    }
    retry_path = os.path.join(durable, gate.RETRY_NAME)
    write(retry_path, retry, 0o444)
    results["restart"] = gate._run("restart")
    results["resume_retry"] = gate._run("resume")
    results["retry_wait"] = gate._run("admit")
    with open(os.path.join(candidate_directory, gate.RETRY_ACK_NAME), "rb") as stream:
        results["retry_ack"] = json.load(stream)
    wrong_retry = {**retry, "transactionId": "e" * 64}
    write(retry_path, wrong_retry, 0o444)
    results["retry_wrong_transaction"] = code(lambda: gate._run("restart"))
    os.unlink(retry_path)
    os.unlink(os.path.join(candidate_directory, gate.RETRY_ACK_NAME))

    release = {
        "schemaVersion": 1,
        "protocol": gate.RELEASE_PROTOCOL,
        "transactionId": permit["transactionId"],
        "nonce": nonce,
        "checkpointSha256": hashlib.sha256(candidate).hexdigest(),
        "start": start,
        "candidateDirectory": candidate_directory,
    }
    write(os.path.join(durable, gate.RELEASE_NAME), release, 0o444)
    results["released"] = gate._run("admit")
    with open(candidate_path, "ab") as stream:
        stream.write(b"tamper")
    results["tampered_release"] = code(lambda: gate._run("admit"))

with tempfile.TemporaryDirectory() as root:
    root = os.path.realpath(root)
    real = os.path.join(root, "real")
    linked = os.path.join(root, "linked")
    os.mkdir(real, 0o711)
    os.chmod(real, 0o711)
    os.symlink(real, linked)
    gate.DURABLE_DIRECTORY = linked
    results["symlink_directory"] = code(lambda: gate._run("admit"))

with tempfile.TemporaryDirectory() as root:
    root = os.path.realpath(root)
    invalid = os.path.join(root, "invalid")
    os.mkdir(invalid, 0o700)
    os.chmod(invalid, 0o700)
    gate.DURABLE_DIRECTORY = invalid
    results["invalid_present_directory"] = code(lambda: gate._run("admit"))

print(json.dumps(results, sort_keys=True))
`;

describe("runtime state mutation startup gate", () => {
  it("fails closed and authenticates an interruption-safe startup checkpoint (#7744)", () => {
    const result = spawnSync("python3", ["-I", "-c", HARNESS, GATE], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const value = JSON.parse(result.stdout) as Record<string, unknown>;
    const expectedStart = {
      pid: 41,
      startIdentity: "9001",
      parentPid: 1,
      uids: [1001, 1001, 1001, 1001],
      commandSha256: "a".repeat(64),
      procDevice: "22",
      procInode: "33",
    };
    expect(value).toMatchObject({
      uses_o_path_when_available: true,
      readable_final_is_read_only: true,
      readable_final_excludes_o_path: true,
      inactive: "inactive",
      unpermitted: "activation-not-permitted",
      admitted: "permitted",
      checkpoint: "activation-ready",
      checkpoint_retry: "activation-ready",
      restart: "retry",
      resume_retry: "retry",
      retry_wait: "retry-wait",
      retry_wrong_transaction: "retry-permit-mismatch",
      released: "released",
      tampered_release: "release-candidate-mismatch",
      symlink_directory: "unsafe-directory",
      invalid_present_directory: "gate-directory-invalid",
      candidate: {
        schemaVersion: 1,
        protocol: "nemoclaw-runtime-state-mutation-startup-complete-v1",
        transactionId: "c".repeat(64),
        nonce: "b".repeat(64),
        markerSha256: "d".repeat(64),
        start: expectedStart,
      },
      retry_ack: {
        schemaVersion: 1,
        protocol: "nemoclaw-runtime-state-mutation-retry-ack-v1",
        transactionId: "c".repeat(64),
        nonce: "b".repeat(64),
        retrySha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        start: expectedStart,
      },
    });
  });
});
