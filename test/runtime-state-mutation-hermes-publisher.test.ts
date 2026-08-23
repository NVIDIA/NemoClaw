// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(import.meta.dirname, "..");
const PUBLISHER = path.join(ROOT, "scripts", "runtime_state_mutation_hermes_publisher.py");
const CAPABILITY = path.join(ROOT, "agents", "hermes", "runtime-state-mutation-publisher-v1.json");
const STATE_PLAN = path.join(ROOT, "agents", "hermes", "state-lock-plan.json");
const START = path.join(ROOT, "agents", "hermes", "start.sh");
const STARTUP_GATE = path.join(ROOT, "scripts", "runtime-state-mutation-startup-gate.py");

const HARNESS = String.raw`
import hashlib
import importlib.util
import json
import os
import shutil
import sys
import tempfile

spec = importlib.util.spec_from_file_location("hermes_publisher", sys.argv[1])
publisher = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = publisher
spec.loader.exec_module(publisher)
publisher.ROOT_UID = os.getuid()
publisher.ROOT_GID = os.getgid()

with open(sys.argv[2], "r", encoding="utf-8") as stream:
    installed_value = json.load(stream)
installed_plan = {key: value for key, value in installed_value.items() if key != "$comment"}

def canonical(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

def marker(nonce="d" * 64, selectors=None, provider_id="docker"):
    expected = [
        *["path:" + value for value in (".config-hash", ".env", "config.yaml")],
        *["path:" + value for value in installed_plan["readOnlyRoots"]],
        *["path:" + value for value in installed_plan["confidentialRoots"]],
        *["prefix:" + value for value in installed_plan["readOnlyPrefixes"]],
        *["prefix:" + value for value in installed_plan["confidentialPrefixes"]],
    ]
    expected.sort(key=lambda value: value.encode())
    selected = selectors or [
        ({"kind": "path", "path": value.removeprefix("path:")}
         if value.startswith("path:")
         else {"kind": "prefix", "prefix": value.removeprefix("prefix:")})
        for value in expected
    ]
    plan = {
        "schemaVersion": 2,
        "intent": "protection-transition",
        "target": "locked",
        "rollback": "mutable",
        "stateLockPlan": installed_plan,
        "stateRoot": "/sandbox/.hermes",
        "selectors": selected,
        "projectionSha256": "b" * 64,
    }
    plan_text = canonical(plan)
    return {
        "schemaVersion": 1,
        "phase": "fenced",
        "transactionId": "a" * 64,
        "providerId": provider_id,
        "stateRoot": "/sandbox/.hermes",
        "stateRootDevice": "101",
        "stateRootInode": "202",
        "plan": plan_text,
        "planSha256": hashlib.sha256(plan_text.encode()).hexdigest(),
        "projectionSha256": "b" * 64,
        "nonce": nonce,
        "target": "locked",
        "rollback": "mutable",
    }

def code(call):
    try:
        call()
    except publisher.PublisherError as error:
        return error.code
    return "ok"

results = {}
with tempfile.TemporaryDirectory() as temporary:
    durable = os.path.join(temporary, "durable")
    os.mkdir(durable, 0o711)
    plan_path = os.path.join(temporary, "state-lock-plan.json")
    shutil.copyfile(sys.argv[2], plan_path)
    os.chmod(plan_path, 0o444)
    publisher.DURABLE_DIRECTORY = durable
    publisher.STATE_LOCK_PLAN_PATH = plan_path
    publisher._verify_final_posture = lambda posture, plan_json: (
        events.append(["verify", posture, json.loads(plan_json)]) or ("f" * 64)
    )
    events = []
    token_index = 0

    def write_guard_state(posture, rollback, token, phase="shields-transition-pending"):
        state = {
            "version": 1,
            "phase": phase,
            "mutation_lock_token": token,
            "mutation_lock_path": os.path.join(durable, "hermes-config-mutation.lock"),
            "hermes_dir": "/sandbox/.hermes",
            "hash_file": "/etc/nemoclaw/hermes.config-hash",
            "shields_transition": {"mode": posture, "rollback_mode": rollback},
        }
        with open(os.path.join(durable, publisher.GUARD_STATE_NAME), "w", encoding="utf-8") as stream:
            json.dump(state, stream, separators=(",", ":"))
        os.chmod(os.path.join(durable, publisher.GUARD_STATE_NAME), 0o600)

    def fake_guard(action, arguments):
        nonlocal_token = None
        global token_index
        events.append([action, list(arguments)])
        if action == "begin-shields-transition":
            token_index += 1
            nonlocal_token = format(token_index, "064x")
            posture = arguments[arguments.index("--shields-mode") + 1]
            rollback = arguments[arguments.index("--rollback-shields-mode") + 1]
            write_guard_state(posture, rollback, nonlocal_token)
            return f"lock_token={nonlocal_token} original_locked=0\n"
        if action == "prepare-shields-abort":
            state_path = os.path.join(durable, publisher.GUARD_STATE_NAME)
            with open(state_path, "r", encoding="utf-8") as stream:
                state = json.load(stream)
            transition = state["shields_transition"]
            transition["mode"] = transition["rollback_mode"]
            state["phase"] = "shields-transition-aborting"
            with open(state_path, "w", encoding="utf-8") as stream:
                json.dump(state, stream, separators=(",", ":"))
            os.chmod(state_path, 0o600)
        if action in ("finish-shields-transition", "abort-shields-transition"):
            os.unlink(os.path.join(durable, publisher.GUARD_STATE_NAME))
        return "ok\n"

    publisher._run_guard = fake_guard
    selected = marker()
    first = publisher.apply_plan_posture(selected, "locked")
    results["first"] = first
    first_event_count = len(events)
    retry = publisher.apply_plan_posture(selected, "locked")
    results["retry"] = retry
    results["retry_events"] = events[first_event_count:]
    rollback = publisher.apply_plan_posture(selected, "mutable")
    results["rollback"] = rollback
    results["events"] = events

    extra = marker()
    plan = json.loads(extra["plan"])
    plan["selectors"].append({"kind": "path", "path": "unexpected"})
    plan["selectors"].sort(
        key=lambda value: (value["kind"] + ":" + value.get("path", value.get("prefix", ""))).encode()
    )
    extra["plan"] = canonical(plan)
    extra["planSha256"] = hashlib.sha256(extra["plan"].encode()).hexdigest()
    results["extra_selector"] = code(
        lambda: publisher.apply_plan_posture(extra, "locked")
    )

with tempfile.TemporaryDirectory() as temporary:
    durable = os.path.join(temporary, "durable")
    os.mkdir(durable, 0o711)
    plan_path = os.path.join(temporary, "state-lock-plan.json")
    shutil.copyfile(sys.argv[2], plan_path)
    os.chmod(plan_path, 0o444)
    publisher.DURABLE_DIRECTORY = durable
    publisher.STATE_LOCK_PLAN_PATH = plan_path
    publisher._verify_final_posture = lambda posture, plan_json: "4" * 64
    podman_token = "3" * 64

    def podman_guard(action, arguments):
        state_path = os.path.join(durable, publisher.GUARD_STATE_NAME)
        if action == "begin-shields-transition":
            posture = arguments[arguments.index("--shields-mode") + 1]
            rollback = arguments[arguments.index("--rollback-shields-mode") + 1]
            state = {
                "version": 1,
                "phase": "shields-transition-pending",
                "mutation_lock_token": podman_token,
                "mutation_lock_path": os.path.join(durable, "hermes-config-mutation.lock"),
                "hermes_dir": "/sandbox/.hermes",
                "hash_file": "/etc/nemoclaw/hermes.config-hash",
                "shields_transition": {"mode": posture, "rollback_mode": rollback},
            }
            with open(state_path, "w", encoding="utf-8") as stream:
                json.dump(state, stream, separators=(",", ":"))
            os.chmod(state_path, 0o600)
            return f"lock_token={podman_token} original_locked=0\n"
        if action == "finish-shields-transition":
            os.unlink(state_path)
        return "ok\n"

    publisher._run_guard = podman_guard
    results["podman_public"] = publisher.apply_plan_posture(
        marker(nonce="4" * 64, provider_id="podman"), "locked"
    )

with tempfile.TemporaryDirectory() as temporary:
    durable = os.path.join(temporary, "durable")
    os.mkdir(durable, 0o711)
    plan_path = os.path.join(temporary, "state-lock-plan.json")
    shutil.copyfile(sys.argv[2], plan_path)
    os.chmod(plan_path, 0o444)
    publisher.DURABLE_DIRECTORY = durable
    publisher.STATE_LOCK_PLAN_PATH = plan_path
    events = []
    publisher._verify_final_posture = lambda posture, plan_json: (
        events.append(["verify", posture]) or ("e" * 64)
    )
    begin_failed = False
    finish_failed = False

    def recovering_guard(action, arguments):
        global begin_failed, finish_failed
        events.append([action])
        token = "7" * 64
        if action == "begin-shields-transition":
            posture = arguments[arguments.index("--shields-mode") + 1]
            rollback = arguments[arguments.index("--rollback-shields-mode") + 1]
            state = {
                "version": 1,
                "phase": "shields-transition-pending",
                "mutation_lock_token": token,
                "mutation_lock_path": os.path.join(durable, "hermes-config-mutation.lock"),
                "hermes_dir": "/sandbox/.hermes",
                "hash_file": "/etc/nemoclaw/hermes.config-hash",
                "shields_transition": {"mode": posture, "rollback_mode": rollback},
            }
            with open(os.path.join(durable, publisher.GUARD_STATE_NAME), "w", encoding="utf-8") as stream:
                json.dump(state, stream, separators=(",", ":"))
            os.chmod(os.path.join(durable, publisher.GUARD_STATE_NAME), 0o600)
            if not begin_failed:
                begin_failed = True
                raise publisher.PublisherError("simulated-begin-response-loss")
            return f"lock_token={token} original_locked=0\n"
        if action == "finish-shields-transition":
            os.unlink(os.path.join(durable, publisher.GUARD_STATE_NAME))
            if not finish_failed:
                finish_failed = True
                raise publisher.PublisherError("simulated-finish-response-loss")
        return "ok\n"

    publisher._run_guard = recovering_guard
    selected = marker(nonce="8" * 64)
    results["begin_loss"] = code(
        lambda: publisher.apply_plan_posture(selected, "locked")
    )
    results["finish_loss"] = code(
        lambda: publisher.apply_plan_posture(selected, "locked")
    )
    results["recovered"] = publisher.apply_plan_posture(selected, "locked")
    results["recovery_events"] = events

with tempfile.TemporaryDirectory() as temporary:
    durable = os.path.join(temporary, "durable")
    os.mkdir(durable, 0o711)
    plan_path = os.path.join(temporary, "state-lock-plan.json")
    shutil.copyfile(sys.argv[2], plan_path)
    os.chmod(plan_path, 0o444)
    publisher.DURABLE_DIRECTORY = durable
    publisher.STATE_LOCK_PLAN_PATH = plan_path
    events = []
    publisher._verify_final_posture = lambda posture, plan_json: (
        events.append(["verify", posture]) or ("9" * 64)
    )
    begin_lost = False

    def rollback_after_loss_guard(action, arguments):
        global begin_lost
        events.append([action])
        token = "6" * 64
        state_path = os.path.join(durable, publisher.GUARD_STATE_NAME)
        if action == "begin-shields-transition":
            posture = arguments[arguments.index("--shields-mode") + 1]
            rollback = arguments[arguments.index("--rollback-shields-mode") + 1]
            state = {
                "version": 1,
                "phase": "shields-transition-pending",
                "mutation_lock_token": token,
                "mutation_lock_path": os.path.join(durable, "hermes-config-mutation.lock"),
                "hermes_dir": "/sandbox/.hermes",
                "hash_file": "/etc/nemoclaw/hermes.config-hash",
                "shields_transition": {"mode": posture, "rollback_mode": rollback},
            }
            with open(state_path, "w", encoding="utf-8") as stream:
                json.dump(state, stream, separators=(",", ":"))
            os.chmod(state_path, 0o600)
            begin_lost = True
            raise publisher.PublisherError("simulated-begin-response-loss")
        if action == "prepare-shields-abort":
            with open(state_path, "r", encoding="utf-8") as stream:
                state = json.load(stream)
            state["phase"] = "shields-transition-aborting"
            transition = state["shields_transition"]
            transition["mode"] = transition["rollback_mode"]
            with open(state_path, "w", encoding="utf-8") as stream:
                json.dump(state, stream, separators=(",", ":"))
            os.chmod(state_path, 0o600)
        if action == "abort-shields-transition":
            os.unlink(state_path)
        return "ok\n"

    publisher._run_guard = rollback_after_loss_guard
    selected = marker(nonce="5" * 64)
    results["rollback_begin_loss"] = code(
        lambda: publisher.apply_plan_posture(selected, "locked")
    )
    results["rollback_after_begin_loss"] = publisher.apply_plan_posture(
        selected, "mutable"
    )
    results["rollback_recovery_events"] = events

print(json.dumps(results, sort_keys=True))
`;

function runHarness(): Record<string, unknown> {
  const result = spawnSync("python3", ["-I", "-c", HARNESS, PUBLISHER, STATE_PLAN], {
    encoding: "utf8",
    timeout: 20_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe("Hermes runtime state mutation publisher", () => {
  it("publishes and rolls back only the exact installed full plan (#7744)", () => {
    const result = runHarness();
    expect(result.first).toMatchObject({
      protocol: "nemoclaw-runtime-state-mutation-publisher-v1",
      posture: "locked",
      nonce: "d".repeat(64),
    });
    expect(result.podman_public).toMatchObject({
      protocol: "nemoclaw-runtime-state-mutation-publisher-v1",
      posture: "locked",
      nonce: "4".repeat(64),
    });
    expect(result.retry).toMatchObject({ posture: "locked" });
    expect(result.rollback).toMatchObject({ posture: "mutable" });
    const expectedStatePlan = JSON.parse(fs.readFileSync(STATE_PLAN, "utf8")) as Record<
      string,
      unknown
    >;
    delete expectedStatePlan.$comment;
    expect(result.retry_events).toEqual([["verify", "locked", expectedStatePlan]]);
    expect(result.extra_selector).toBe("publisher-plan-selector-mismatch");
    const events = result.events as Array<[string, string[]?]>;
    expect(events.filter(([action]) => action === "begin-shields-transition")).toHaveLength(2);
    expect(events).toContainEqual([
      "begin-shields-transition",
      expect.arrayContaining(["--expected-hermes-device", "101", "--expected-hermes-inode", "202"]),
    ]);
    expect(events).toContainEqual([
      "run-state-dir-transition",
      expect.arrayContaining(["--state-action", "lock"]),
    ]);
    expect(events).toContainEqual([
      "run-state-dir-transition",
      expect.arrayContaining(["--state-action", "unlock"]),
    ]);
  });

  it("recovers nonce-bound begin and finish response loss without replaying them (#7744)", () => {
    const result = runHarness();
    expect(result).toMatchObject({
      begin_loss: "simulated-begin-response-loss",
      finish_loss: "simulated-finish-response-loss",
      recovered: { posture: "locked", nonce: "8".repeat(64) },
    });
    const events = result.recovery_events as Array<[string]>;
    expect(events.filter(([action]) => action === "begin-shields-transition")).toHaveLength(1);
    expect(events.filter(([action]) => action === "finish-shields-transition")).toHaveLength(1);
    expect(events.filter(([action]) => action === "verify")).toHaveLength(1);
  });

  it("can publish the exact rollback after a target begin response is lost (#7744)", () => {
    const result = runHarness();
    expect(result).toMatchObject({
      rollback_begin_loss: "simulated-begin-response-loss",
      rollback_after_begin_loss: { posture: "mutable", nonce: "5".repeat(64) },
    });
    expect(result.rollback_recovery_events).toEqual([
      ["begin-shields-transition"],
      ["prepare-shields-abort"],
      ["run-state-dir-transition"],
      ["abort-shields-transition"],
      ["verify", "mutable"],
    ]);
  });

  it("publishes one exact image capability and checks the durable root gate before startup code", () => {
    expect(fs.readFileSync(CAPABILITY, "utf8")).toBe(
      '{"schemaVersion":1,"protocol":"nemoclaw-runtime-state-mutation-publisher-v1","agent":"hermes","providerId":"docker","stateRoot":"/sandbox/.hermes","planSchemaVersion":2,"entrypoint":"/usr/local/lib/nemoclaw/runtime_state_mutation_hermes_publisher.py"}\n',
    );
    const start = fs.readFileSync(START, "utf8");
    const gate = start.indexOf(
      'NEMOCLAW_RUNTIME_STATE_MUTATION_GATE_HELPER="/usr/local/lib/nemoclaw/runtime-state-mutation-startup-gate.py"',
    );
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(start.indexOf("# managed-entrypoint-env-wrapper begin"));
    expect(gate).toBeLessThan(start.indexOf('source "$_SANDBOX_INIT"'));
    expect(gate).toBeLessThan(start.indexOf('migrate_legacy_layout "/sandbox/.hermes"'));
    expect(start).not.toContain("/sandbox/.nemoclaw/runtime-state-mutation-hold-v1.json");
    expect(start).toContain(
      'NEMOCLAW_RUNTIME_STATE_MUTATION_GATE_PYTHON="/opt/hermes/.venv/bin/python3"',
    );
    expect(start).toContain('NEMOCLAW_RUNTIME_STATE_MUTATION_GATE_SETPRIV="/usr/bin/setpriv"');
    expect(start).toContain("--reuid=sandbox --regid=sandbox --init-groups --");
    expect(start).toContain("nemoclaw_runtime_state_mutation_checkpoint || return 1");
    expect(start).toContain("trap nemoclaw_runtime_state_mutation_retry_exec USR2");
    expect(start).toContain("exec /usr/local/bin/nemoclaw-start");
    expect(start).toContain("nemoclaw_runtime_state_mutation_gate resume");

    const startupGate = fs.readFileSync(STARTUP_GATE, "utf8");
    expect(startupGate).toContain('DURABLE_DIRECTORY = "/var/lib/nemoclaw/runtime-state-mutation"');
    expect(startupGate).toContain('"permitted": 10');
    expect(startupGate).toContain('"activation-ready": 11');
    expect(startupGate).toContain('"retry": 12');
    expect(fs.readFileSync(PUBLISHER, "utf8")).toContain(
      'PYTHON_PATH = "/opt/hermes/.venv/bin/python3"',
    );
  });
});
