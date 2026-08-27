// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const CONTROLLER = path.join(
  import.meta.dirname,
  "../../scripts/runtime-state-mutation-control.py",
);

const HARNESS = String.raw`
import hashlib
import importlib.util
import json
import os
import sys
import tempfile

spec = importlib.util.spec_from_file_location("runtime_state_control", sys.argv[1])
control = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = control
spec.loader.exec_module(control)

control.ROOT_UID = os.geteuid()
control.ROOT_GID = os.getegid()
control._sandbox_account = lambda: (os.geteuid(), os.getegid())

start = control.ProcessReference(
    10,
    "101",
    1,
    (os.geteuid(),) * 4,
    "a" * 64,
    12,
    13,
)
fence = control.FenceProof(start, start, (), (os.geteuid(),))
marker = {"transactionId": "c" * 64, "nonce": "b" * 64}
release_payload = b'{"release":"exact"}\n'

def code(operation):
    try:
        operation()
        return "ok"
    except control.ControlError as error:
        return error.code

def write_at(directory_fd, name, payload):
    fd = os.open(
        name,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        0o600,
        dir_fd=directory_fd,
    )
    try:
        os.write(fd, payload)
    finally:
        os.close(fd)

def record_rejection(directory_fd, name, payload):
    write_at(
        directory_fd,
        control.STARTUP_RELEASE_ACK_NAME,
        control._canonical_protocol_payload(payload),
    )
    results[name] = code(
        lambda: control._read_startup_release_ack(
            marker,
            fence,
            release_payload,
        )
    )
    os.unlink(control.STARTUP_RELEASE_ACK_NAME, dir_fd=directory_fd)

results = {}
with tempfile.TemporaryDirectory() as root:
    root = os.path.realpath(root)
    os.chmod(root, 0o755)
    control.STARTUP_HANDOFF_DIRECTORY = os.path.join(root, "handoff")
    opened = control._open_startup_candidate_directory(marker, create=True)
    assert opened is not None
    root_fd, directory_fd = opened
    try:
        expected = {
            "schemaVersion": 1,
            "protocol": "nemoclaw-runtime-state-mutation-release-ack-v1",
            "transactionId": "c" * 64,
            "nonce": "b" * 64,
            "releaseSha256": hashlib.sha256(release_payload).hexdigest(),
            "start": {
                "pid": 10,
                "startIdentity": "101",
                "parentPid": 1,
                "uids": [os.geteuid()] * 4,
                "commandSha256": "a" * 64,
                "procDevice": "12",
                "procInode": "13",
            },
        }
        assert expected == control._startup_release_ack_payload(
            marker,
            fence,
            release_payload,
        )
        payload = control._canonical_protocol_payload(expected)
        write_at(
            directory_fd,
            control.STARTUP_RELEASE_ACK_PENDING_NAME,
            payload,
        )
        results["pendingIgnored"] = (
            control._read_startup_release_ack(marker, fence, release_payload)
            is None
        )
        os.rename(
            control.STARTUP_RELEASE_ACK_PENDING_NAME,
            control.STARTUP_RELEASE_ACK_NAME,
            src_dir_fd=directory_fd,
            dst_dir_fd=directory_fd,
        )
        results["committed"] = code(
            lambda: control._read_startup_release_ack(
                marker,
                fence,
                release_payload,
            )
        )
        publisher = control.ProcessIdentity(
            22,
            "S",
            start.pid,
            "202",
            start.uids,
            (
                control.STARTUP_GATE_PYTHON,
                b"-I",
                control.STARTUP_GATE_HELPER,
                b"acknowledge",
            ),
            14,
            15,
        )
        publisher_scans = {"count": 0}
        def capture_publishers(_uids):
            publisher_scans["count"] += 1
            return (publisher,) if publisher_scans["count"] == 1 else ()
        control._capture_writer_processes = capture_publishers
        control._recapture_reference = lambda *_args: None
        control.POLL_SECONDS = 0
        results["publisherWait"] = code(
            lambda: control._wait_for_release_ack_publisher(fence)
        )
        results["publisherScans"] = publisher_scans["count"]
        os.unlink(control.STARTUP_RELEASE_ACK_NAME, dir_fd=directory_fd)
        record_rejection(
            directory_fd,
            "wrongRelease",
            {**expected, "releaseSha256": "0" * 64},
        )
        record_rejection(
            directory_fd,
            "wrongNonce",
            {**expected, "nonce": "d" * 64},
        )
        record_rejection(
            directory_fd,
            "wrongTransaction",
            {**expected, "transactionId": "d" * 64},
        )
        record_rejection(
            directory_fd,
            "wrongStart",
            {**expected, "start": {**expected["start"], "pid": 11}},
        )
        write_at(
            directory_fd,
            control.STARTUP_RELEASE_ACK_PENDING_NAME,
            payload,
        )
    finally:
        os.close(directory_fd)
        os.close(root_fd)

    control._cleanup_startup_candidate_directory(marker)
    results["cleaned"] = not os.path.exists(
        control._startup_candidate_directory(marker)
    )

print(json.dumps(results, sort_keys=True))
`;

describe("runtime state mutation release acknowledgement", () => {
  it("accepts the exact acknowledgement after its startup child exits (#10155)", () => {
    const result = spawnSync("python3", ["-I", "-c", HARNESS, CONTROLLER], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      cleaned: true,
      committed: "ok",
      pendingIgnored: true,
      publisherScans: 2,
      publisherWait: "ok",
      wrongNonce: "activation-release-ack-invalid",
      wrongRelease: "activation-release-ack-invalid",
      wrongStart: "activation-release-ack-invalid",
      wrongTransaction: "activation-release-ack-invalid",
    });
  });
});
