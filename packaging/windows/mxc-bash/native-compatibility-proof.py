# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Shared native component-proof admission; not installed qualification."""

import hashlib
import json
from pathlib import PureWindowsPath
import re


def exact_fields(value, expected):
    return isinstance(value, dict) and all(
        key in value and type(value[key]) is type(item) and value[key] == item
        for key, item in expected.items()
    )


def validate_native_job_ui(job, ui):
    expected_job = {
        "schemaVersion": 1, "classification": "owned-native-MXC-job-teardown",
        "stage": "before-primary-handle-release", "clock": "GetTickCount64",
        "jobAccountingQueried": True, "jobAccountingKnown": True,
        "jobAccountingBytes": 48, "jobAccountingExpectedBytes": 48,
        "jobAccountingError": 0, "activeProcesses": 0,
        "rootWaitStatus": 0, "rootSignaled": True, "rootWaitError": 0,
    }
    if not exact_fields(job, expected_job) or (
        type(job.get("rootPid")) is not int or not 0 < job["rootPid"] <= 0xFFFFFFFF
        or type(job.get("tickMilliseconds")) is not int or job["tickMilliseconds"] < 0
        or type(job.get("totalProcesses")) is not int or job["totalProcesses"] < 1
        or type(job.get("terminatedProcesses")) is not int
        or not 0 <= job["terminatedProcesses"] <= job["totalProcesses"]
    ):
        raise ValueError("Hermes native job accounting is missing or invalid.")
    expected_ui = {
        "schemaVersion": 1, "classification": "native-MXC-ui-policy-assignment",
        "stage": "before-primary-thread-resume",
        "policyOrigin": "serialized-process-security-environment",
        "securityEnvironmentAttached": True, "rootPid": job["rootPid"],
        "uiRestrictions": 0x3ff, "disallowWin32k": False,
        "policyMutated": False, "enforcementReadback": False,
    }
    if not exact_fields(ui, expected_ui) or set(ui) != set(expected_ui):
        raise ValueError("Hermes native UI policy assignment differs.")


def validate_native_ui_marker(marker, root_pid, required):
    if not required:
        if marker is not None:
            raise ValueError("Unexpected native UI marker outside desktop execution.")
        return
    if not isinstance(marker, dict) or set(marker) != {"prepared", "closed"}:
        raise ValueError("Native UI marker lifecycle is missing.")
    prepared, closed = marker["prepared"], marker["closed"]
    if not isinstance(prepared, dict) or not isinstance(closed, dict):
        raise ValueError("Native UI marker lifecycle must contain objects.")
    sid, session = prepared.get("appContainerSid"), prepared.get("sessionId")
    expected = {
        "schemaVersion": 1, "classification": "native-Hermes-ui-owner", "stage": "prepare",
        "rootPid": root_pid, "appContainerSid": sid, "sessionId": session,
        "exclusiveCreation": True, "mediumNoWriteUp": True, "guestAccess": 0x120001,
        "descriptorMatched": True, "policyAssignment": "PSEC-0x3ff-Win32k-false",
        "enforcementReadback": False,
    }
    if (not isinstance(sid, str) or len(sid) > 184
        or not re.fullmatch(r"S-1-15-2-(?:[0-9]+-)*[0-9]+", sid)
        or type(session) is not int or not 0 <= session <= 0xFFFFFFFF
        or not exact_fields(prepared, expected) or set(prepared) != set(expected)):
        raise ValueError("Native UI marker does not bind the host policy and root.")
    expected_close = {
        "schemaVersion": 1, "classification": "native-Hermes-ui-owner", "stage": "owner-close",
        "rootPid": root_pid, "closed": True, "absentAfterOwnerClose": True,
        "presenceHandleClosed": True, "absenceStatus": closed.get("absenceStatus"),
    }
    if (type(closed.get("absenceStatus")) is not int
        or closed["absenceStatus"] not in (0xC0000034, 0xC000003A)
        or not exact_fields(closed, expected_close) or set(closed) != set(expected_close)):
        raise ValueError("Native UI marker closure or absence is unproven.")


def validate_native_personal(record, source_revision, request_raw, log_raw):
    """Admit same-source component execution, never installed qualification."""
    if not exact_fields(record, {
        "schemaVersion": 2, "classification": "canonical-personal-mxc-feasibility",
        "sourceRevision": source_revision, "selectedTier": "base-container",
        "feasibilityPassed": True, "installedAcceptance": False,
        "fullAgentQualified": False, "privateStateLeaseTested": False,
        "executorAttempted": True, "rootsRetainedForUnclosedExecutor": False,
        "error": None, "cleanupErrors": [],
    }) or not re.fullmatch(r"[a-f0-9]{40}", source_revision):
        raise ValueError("Native Personal requires a complete same-source component pass.")
    if any(key in record for key in ("profileDeletion", "desktopJobMask", "nativeExecutionError")):
        raise ValueError("Native Personal cannot reuse legacy or failed execution evidence.")
    if any(key in record for key in ("diagnosticOnly", "browserFirstProbe", "coldJobProbe",
                                    "rendererWerDiagnostic", "rendererPostmortemDiagnostic")):
        raise ValueError("A diagnostic Personal run cannot qualify native composition.")
    cleanup = record.get("cleanup", {})
    if not exact_fields(cleanup, dict.fromkeys((
        "executorClosed", "hostDesktopsReleased", "hostDiagnosticChildrenClosed",
        "nativeTeardownVerified", "ownedRootsRemoved", "browserDiagnosticComplete",
    ), True)) or "profileDeleted" in cleanup:
        raise ValueError("Native Personal cleanup is incomplete.")
    execution = record.get("execution", {})
    if not exact_fields(execution, {
        "childClosed": True, "exitCode": 0, "signal": None, "error": None,
        "timedOut": False, "outputExceeded": False, "nativeOutputExceeded": False,
    }) or type(execution.get("pid")) is not int or not 0 < execution["pid"] <= 0xFFFFFFFF:
        raise ValueError("Native Personal executor did not close normally.")
    observed = record.get("nativeExecution", {})
    binding = observed.get("binding", {}) if isinstance(observed, dict) else {}
    args = execution.get("args", [])
    if (not exact_fields(observed, {
        "schemaVersion": 1, "classification": "native-Personal-execution-cleanup",
    }) or not isinstance(args, list) or len(args) != 3 or args[1] != "--log-file"
        or not all(isinstance(item, str) for item in args)
        or not isinstance(execution.get("executable"), str)
        or not exact_fields(binding, {
            "executable": execution["executable"], "executorPid": execution["pid"],
            "policyFile": args[0], "requestSha256": record.get("requestSha256"),
        })
        or PureWindowsPath(args[0]).name != "personal-request.json"
        or PureWindowsPath(args[2]) != PureWindowsPath(args[0]).with_name("mxc-native.log")
        or not isinstance(request_raw, bytes) or not 0 < len(request_raw) <= 1024 * 1024
        or not isinstance(log_raw, bytes) or not 0 < len(log_raw) <= 4 * 1024 * 1024
        or hashlib.sha256(request_raw).hexdigest() != record.get("requestSha256")
        or hashlib.sha256(log_raw).hexdigest() != observed.get("logSha256")):
        raise ValueError("Native Personal request/log do not match its owned execution.")
    request = json.loads(request_raw)
    if (not exact_fields(request, {"version": "1.0.0", "containment": "processcontainer"})
        or request.get("fallback") != {"allowDaclMutation": False}
        or not exact_fields(request.get("fallback"), {"allowDaclMutation": False})
        or not exact_fields(request.get("process"), {"inheritDefaultEnv": False})
        or request.get("processContainer") != {"leastPrivilege": False, "capabilities": []}
        or not exact_fields(request.get("processContainer"), {"leastPrivilege": False, "capabilities": []})
        or request.get("ui") != {"disable": False, "clipboard": "none", "injection": False}
        or not exact_fields(request.get("ui"), {"disable": False, "clipboard": "none", "injection": False})
        or request.get("network") != {"egress": {"default": "deny"},
                                       "ingress": {"default": "deny", "hostLoopback": "deny"}}
        or request.get("telemetry") != {"enabled": False}
        or not exact_fields(request.get("telemetry"), {"enabled": False})
        or "runtimeConfig" in request):
        raise ValueError("Native Personal request changes its isolation contract.")
    log = log_raw.decode("utf-8", errors="strict")
    if any(not isinstance(text, str) or "NEMOCLAW_HERMES_DESKTOP_MASK=" in text
           for text in (log, execution.get("stderr"), execution.get("nativeStderr"))):
        raise ValueError("Native Personal changed the retained UI restrictions.")
    job, ui = observed.get("jobTeardown"), observed.get("uiPolicy")
    validate_native_job_ui(job, ui)
    marker = observed.get("uiMarker")
    validate_native_ui_marker(marker, job["rootPid"], True)
    if job["rootPid"] == execution["pid"]:
        raise ValueError("Native Personal root is not the executor process.")
    events, snapshots, policies, markers = [], [], [], []
    for index, line in enumerate(log.splitlines()):
        match = re.fullmatch(r'\[\d+\] (\{"event":.*\})', line)
        if match:
            events.append((index, json.loads(match[1])))
        for prefix, rows in (("NEMOCLAW_NATIVE_MXC_TEARDOWN", snapshots),
                             ("NEMOCLAW_NATIVE_MXC_UI_POLICY", policies),
                             ("NEMOCLAW_NATIVE_UI_OWNER", markers)):
            match = re.fullmatch(r'\[\d+\] ' + prefix + r'=(\{.*\})', line)
            if match:
                rows.append((index, json.loads(match[1])))
    exits = [(i, row) for i, row in events if row.get("event") == "mxc.ProcessExited"]
    network = [(i, row) for i, row in events if row.get("event") == "mxc.NetworkPolicyApplied"]
    expected_network = {
        "event": "mxc.NetworkPolicyApplied", "backend": "processcontainer",
        "identity": "redacted", "tier": "base-container",
        "enforcement_mode": "capabilities", "default_policy": "block",
        "proxy_port": 0, "firewall_rules_created": 0, "firewall_applied": False,
        "status": "success",
    }
    if (len(network) != 1 or not exact_fields(network[0][1], expected_network)
        or set(network[0][1]) != set(expected_network)
        or not exact_fields(observed.get("policy"), expected_network)
        or set(observed["policy"]) != set(expected_network)):
        raise ValueError("Native Personal network policy record differs.")
    teardowns = [(i, row) for i, row in events if row.get("event") == "mxc.SandboxTornDown"]
    expected_exit = {"event": "mxc.ProcessExited", "backend": "processcontainer",
                     "tier": "base-container", "pid": job["rootPid"], "exit_code": 0}
    expected_teardown = {
        "event": "mxc.SandboxTornDown", "backend": "processcontainer",
        "identity": "redacted", "tier": "base-container", "pid": job["rootPid"],
        "status": "success", "firewall_rules_removed": 0, "firewall_removal_ok": True,
        "bfs_removed": False, "proxy_stopped": False, "preserve_policy": False,
        "container_released": False,
    }
    if (any(len(rows) != 1 for rows in (exits, teardowns, snapshots, policies))
        or not exact_fields(exits[0][1], expected_exit)
        or not exact_fields(teardowns[0][1], expected_teardown)
        or set(teardowns[0][1]) != set(expected_teardown)
        or snapshots[0][1] != job or policies[0][1] != ui
        or not policies[0][0] < exits[0][0] < teardowns[0][0] < snapshots[0][0]):
        raise ValueError("Native Personal host log lacks ordered policy/exit/teardown evidence.")
    # Compare types as well as values; Python otherwise equates True and 1.
    validate_native_job_ui(snapshots[0][1], policies[0][1])
    if (len(markers) != 2 or markers[0][1] != marker["prepared"]
        or markers[1][1] != marker["closed"]
        or not markers[0][0] < policies[0][0] < snapshots[0][0] < markers[1][0]):
        raise ValueError("Native UI marker log is missing, reordered or substituted.")
    validate_native_ui_marker({"prepared": markers[0][1], "closed": markers[1][1]}, job["rootPid"], True)
    desktop = record.get("hostDesktopCleanup", {})
    if not exact_fields(desktop, {
        "schemaVersion": 1, "classification": "closed-Personal-executor-desktop-cleanup",
        "passed": True, "identityAndCloseVerified": True, "observerClosed": True,
        "stage": "complete", "rootPid": job["rootPid"], "error": None,
    }) or not exact_fields(desktop.get("binding"), binding):
        raise ValueError("Native Personal lacks its bound desktop cleanup result.")


def validate_native_personal_inputs(record, compatibility, executor, source_revision):
    """Bind the tested native binaries to the ones selected for composition."""
    inputs = record.get("hostInputs", {})
    identity = inputs.get("mxc", {})
    tested = inputs.get("compatibility", {})
    files = executor.get("files", [])
    if (record.get("sourceRevision") != source_revision or len(files) != 1
        or not exact_fields(identity, {
            "bytes": files[0].get("bytes"), "sha256": files[0].get("sha256"),
            "peMachine": 0xAA64, "path": record.get("execution", {}).get("executable"),
        })
        or tested.get("sourceRevision") != source_revision
        or tested.get("mxcFile") != files[0]
        or tested.get("files") != compatibility.get("files")
        or tested.get("license") != compatibility.get("license")):
        raise ValueError("Native Personal tested different executor or compatibility inputs.")


def validate_native_proof(proof, compatibility, executor, source_revision):
    """Validate current native component evidence, not installed qualification."""
    if (
        type(proof.get("schemaVersion")) is not int
        or proof["schemaVersion"] != 2
        or proof.get("classification")
        != "small-msys-native-basecontainer-compatibility-proof"
        or proof.get("sourceRevision") != source_revision
        or proof.get("passed") is not True
        or proof.get("normalCleanup") is not True
        or proof.get("phase") != "two-container-isolation"
        or proof.get("imageVariant")
        != "ci-derived-unsigned-msys-dll-bash-and-sh-dynamic-base"
        or executor.get("classification") != "mxc-native-owned-token-inspection-build"
        or type(compatibility.get("schemaVersion")) is not int
        or compatibility["schemaVersion"] != 1
        or compatibility.get("runtimeExecuted") is not False
        or compatibility.get("qualified") is not False
        or type(proof.get("startedExecutors")) is not int
        or proof["startedExecutors"] != 5
        or proof.get("hostProcessesClosed") is not True
        or proof.get("hostProcessesNormal") is not True
    ):
        raise ValueError("Hermes native component evidence is incomplete or stale.")
    nonce = proof.get("nonce", "")
    if not isinstance(nonce, str) or not re.fullmatch(r"[a-f0-9]{24}", nonce):
        raise ValueError("Hermes native evidence lacks its owned run nonce.")
    ids = {"nm-" + nonce[:12] + "-" + role for role in ("base", "start", "d", "a", "b")}
    observations = proof.get("nativeExecutions", {})
    cleanup = proof.get("cleanup", {})
    if (
        not isinstance(observations, dict) or set(observations) != ids
        or not isinstance(cleanup, dict) or set(cleanup) != ids
    ):
        raise ValueError("Hermes native evidence omits or substitutes an execution.")
    policy = {
        "event": "mxc.NetworkPolicyApplied", "backend": "processcontainer",
        "identity": "redacted", "tier": "base-container",
        "enforcement_mode": "capabilities", "default_policy": "block",
        "proxy_port": 0, "firewall_rules_created": 0,
        "firewall_applied": False, "status": "success",
    }
    for container_id in sorted(ids):
        observed = observations[container_id]
        row = cleanup[container_id]
        if not isinstance(observed, dict) or not isinstance(row, dict):
            raise ValueError("Hermes native execution evidence must be objects.")
        log_sha = observed.get("logSha256")
        actual_policy = observed.get("policy", {})
        job = observed.get("jobTeardown", {})
        ui = observed.get("uiPolicy", {})
        validate_native_job_ui(job, ui)
        if "uiMarker" not in observed:
            raise ValueError("Native execution lacks its UI marker observation.")
        validate_native_ui_marker(observed["uiMarker"], job["rootPid"], container_id.endswith("-d"))
        process = row.get("executor", {})
        if (
            not isinstance(log_sha, str) or not re.fullmatch(r"[a-f0-9]{64}", log_sha)
            or not isinstance(actual_policy, dict) or set(actual_policy) != set(policy)
            or any(type(actual_policy[k]) is not type(v) or actual_policy[k] != v
                   for k, v in policy.items())
            or row.get("nativeTeardownVerified") is not True
            or row.get("shareRemoved") is not True
            or "nativeTeardownError" not in row
            or row.get("nativeTeardownError") is not None
            or not isinstance(process, dict)
            or process.get("closed") is not True
            or process.get("forced") is not False
            or type(process.get("exitCode")) is not int or process["exitCode"] != 0
            or "error" not in process
            or process.get("error") is not None
        ):
            raise ValueError("Hermes native policy or cleanup evidence failed.")
