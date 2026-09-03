// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = path.join(import.meta.dirname, "../..");
const PUBLISHER = path.join(ROOT, "scripts", "runtime_state_mutation_hermes_publisher.py");
const START = path.join(ROOT, "agents", "hermes", "start.sh");

const HARNESS = String.raw`
import hashlib
import importlib.util
import json
import os
import sys
import tempfile

spec = importlib.util.spec_from_file_location("hermes_publisher", sys.argv[1])
publisher = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = publisher
spec.loader.exec_module(publisher)
publisher.ROOT_UID = os.getuid()
publisher.ROOT_GID = os.getgid()
real_verify_final_posture = publisher._verify_final_posture

installed_plan = {
    "version": 1,
    "readOnlyRoots": ["plugins", "workspace"],
    "confidentialRoots": ["pairing"],
    "readOnlyPrefixes": ["profile-"],
    "confidentialPrefixes": ["secret-"],
    "writableSubpaths": ["workspace/cache"],
}

def canonical(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

def write_installed_plan(path):
    with open(path, "w", encoding="utf-8") as stream:
        stream.write(canonical(installed_plan))
    os.chmod(path, 0o444)

def marker(nonce="d" * 64, selectors=None, provider_id="docker"):
    expected = ["path:.config-hash", "path:.env", "path:config.yaml", "path:pairing",
                "path:plugins", "path:workspace", "prefix:profile-", "prefix:secret-"]
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
    write_installed_plan(plan_path)
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
    write_installed_plan(plan_path)
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
    write_installed_plan(plan_path)
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
    write_installed_plan(plan_path)
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

publisher._verify_final_posture = real_verify_final_posture
publisher._verify_top_posture = lambda posture: None

class VerificationResult:
    ok = False

class MutableGuard:
    def __init__(self, finding):
        self.finding = finding
        self.calls = []

    def parse_agent_state_lock_plan(self, plan_json):
        return json.loads(plan_json)

    def _production_identity(self):
        return "production-identity"

    def run_guard(self, action, config_dir, identity, plan, **options):
        self.calls.append({
            "action": action,
            "configDir": config_dir,
            "identity": identity,
            "plan": plan,
            "options": options,
            "finding": self.finding,
        })
        return VerificationResult()

results["mutable_verification_failures"] = []
for index, finding in enumerate(
    ("verification-flags-mismatch", "verification-config-binding-changed")
):
    with tempfile.TemporaryDirectory() as temporary:
        durable = os.path.join(temporary, "durable")
        os.mkdir(durable, 0o711)
        publisher.DURABLE_DIRECTORY = durable
        publisher.HERMES_DIR = os.path.join(temporary, "sandbox", ".hermes")
        normalized = {
            "bindingSha256": format(index + 1, "064x"),
            "transactionId": format(index + 2, "064x"),
            "nonce": format(index + 3, "064x"),
            "planSha256": format(index + 4, "064x"),
            "projectionSha256": format(index + 5, "064x"),
            "target": "locked",
            "rollback": "mutable",
            "posture": "mutable",
            "stateLockPlanJson": canonical(installed_plan),
        }
        journal = publisher._new_journal(normalized)
        operation = publisher._operation("mutable", "locked")
        operation["phase"] = "top-applied"
        operation["guardToken"] = "a" * 64
        journal["operation"] = operation
        directory_fd = os.open(durable, os.O_RDONLY | os.O_DIRECTORY)
        publisher._write_journal(directory_fd, journal)
        guard = MutableGuard(finding)
        publisher._load_module = lambda path, name: guard
        emitted_receipt = None
        try:
            emitted_receipt = publisher._complete(
                directory_fd, journal, normalized
            )
            failure = "ok"
        except publisher.PublisherError as error:
            failure = error.code
        finally:
            os.close(directory_fd)
        with open(
            os.path.join(durable, publisher.JOURNAL_NAME),
            "r",
            encoding="utf-8",
        ) as stream:
            persisted = json.load(stream)
        results["mutable_verification_failures"].append({
            "finding": finding,
            "failure": failure,
            "emittedReceipt": emitted_receipt,
            "persistedOperation": persisted["operation"],
            "finalPosture": persisted["finalPosture"],
            "calls": guard.calls,
        })

print(json.dumps(results, sort_keys=True))
`;

function runHarness(): Record<string, unknown> {
  const result = spawnSync("python3", ["-I", "-c", HARNESS, PUBLISHER], {
    encoding: "utf8",
    timeout: 20_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

type EntrypointGateFixture = {
  acknowledgePath: string;
  gatePath: string;
  harnessPath: string;
  releasePath: string;
  tracePath: string;
};

function createEntrypointGateFixture(temporary: string): EntrypointGateFixture {
  const fixture = {
    acknowledgePath: path.join(temporary, "release-ack.json"),
    gatePath: path.join(temporary, "gate.sh"),
    harnessPath: path.join(temporary, "entrypoint-harness.sh"),
    releasePath: path.join(temporary, "release.json"),
    tracePath: path.join(temporary, "trace.log"),
  };
  fs.writeFileSync(
    fixture.gatePath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'action=""',
      'for argument in "$@"; do action="$argument"; done',
      'case "$action" in',
      "  admit)",
      '    printf "admit\\n" >> "$NEMOCLAW_TEST_TRACE"',
      '    if [ "$NEMOCLAW_TEST_GATE_MODE" = "deny" ]; then exit 1; fi',
      '    if [ "$NEMOCLAW_TEST_GATE_MODE" = "invalid" ]; then',
      '      printf "%s\\n" "runtime-state-mutation-startup-gate: invalid-state code=gate-receipt-invalid transaction=${NEMOCLAW_TEST_TRANSACTION}" >&2',
      "      exit 76",
      "    fi",
      "    exit 10",
      "    ;;",
      "  checkpoint)",
      '    printf "checkpoint:%s\\n" "$PPID" >> "$NEMOCLAW_TEST_TRACE"',
      "    exit 11",
      "    ;;",
      "  resume)",
      '    if [ ! -f "$NEMOCLAW_TEST_RELEASE" ]; then exit 1; fi',
      '    printf "resume:%s\\n" "$PPID" >> "$NEMOCLAW_TEST_TRACE"',
      "    ;;",
      "  acknowledge)",
      '    temporary_ack="$NEMOCLAW_TEST_ACKNOWLEDGE.$$.tmp"',
      '    printf \'{"pid":%s}\\n\' "$$" > "$temporary_ack"',
      '    chmod 600 "$temporary_ack"',
      '    mv "$temporary_ack" "$NEMOCLAW_TEST_ACKNOWLEDGE"',
      '    printf "acknowledge:%s\\n" "$$" >> "$NEMOCLAW_TEST_TRACE"',
      '    kill -STOP "$$"',
      '    printf "acknowledged:%s\\n" "$$" >> "$NEMOCLAW_TEST_TRACE"',
      "    ;;",
      "  *) exit 1 ;;",
      "esac",
    ].join("\n"),
    { mode: 0o700 },
  );
  fs.writeFileSync(
    fixture.harnessPath,
    [
      "function [ {",
      '  case "$1:$2:$3" in',
      '    "!:-x:/opt/hermes/.venv/bin/python3"|"!:-f:/usr/local/lib/nemoclaw/runtime-state-mutation-startup-gate.py"|"!:-x:/usr/bin/setpriv") return 1 ;;',
      "  esac",
      '  builtin [ "$@"',
      "}",
      "function /opt/hermes/.venv/bin/python3 {",
      '  "$NEMOCLAW_TEST_GATE" "$@"',
      "}",
      "function /usr/bin/setpriv {",
      '  while [ "$#" -gt 0 ]; do',
      '    case "$1" in --) shift; break ;; *) shift ;; esac',
      "  done",
      '  "$@"',
      "}",
      "nemoclaw_test_checkpoint_entry() {",
      '  case "$BASH_COMMAND" in',
      "    _NEMOCLAW_ENTRYPOINT_ENV_WRAPPER=*)",
      "      trap - DEBUG",
      '      printf "checkpoint-call\\n" >> "$NEMOCLAW_TEST_TRACE"',
      "      if nemoclaw_runtime_state_mutation_checkpoint; then exit 0; fi",
      '      status="$?"',
      '      exit "$status"',
      "      ;;",
      "  esac",
      "}",
      "set -T",
      "trap nemoclaw_test_checkpoint_entry DEBUG",
      'source "$NEMOCLAW_TEST_ENTRYPOINT"',
    ].join("\n"),
    { mode: 0o700 },
  );
  return fixture;
}

function readEntrypointTrace(tracePath: string): string[] {
  try {
    const content = fs.readFileSync(tracePath, "utf8").trim();
    return content.length === 0 ? [] : content.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function processState(pid: number): string {
  const result = spawnSync("ps", ["-o", "state=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 1_000,
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

async function waitForCondition(description: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate(), "Timed out waiting for " + description).toBe(true);
}

async function waitForStoppedProcess(pid: number, description: string): Promise<void> {
  await waitForCondition(description, () => processState(pid).startsWith("T"));
}

function entrypointGateEnvironment(
  fixture: EntrypointGateFixture,
  gateMode: "allow" | "deny" | "invalid",
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NEMOCLAW_TEST_ACKNOWLEDGE: fixture.acknowledgePath,
    NEMOCLAW_TEST_ENTRYPOINT: START,
    NEMOCLAW_TEST_GATE: fixture.gatePath,
    NEMOCLAW_TEST_GATE_MODE: gateMode,
    NEMOCLAW_TEST_RELEASE: fixture.releasePath,
    NEMOCLAW_TEST_TRACE: fixture.tracePath,
    NEMOCLAW_TEST_TRANSACTION: "c".repeat(64),
  };
}

describe("Hermes runtime state mutation publisher", () => {
  let harnessResult: Record<string, unknown>;

  beforeAll(() => {
    harnessResult = runHarness();
  });

  it("publishes and rolls back only the exact installed full plan (#7744)", () => {
    const result = harnessResult;
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
    expect(result.retry_events).toEqual([
      [
        "verify",
        "locked",
        {
          version: 1,
          readOnlyRoots: ["plugins", "workspace"],
          confidentialRoots: ["pairing"],
          readOnlyPrefixes: ["profile-"],
          confidentialPrefixes: ["secret-"],
          writableSubpaths: ["workspace/cache"],
        },
      ],
    ]);
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
    const result = harnessResult;
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
    const result = harnessResult;
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

  it("retains the mutable operation without a receipt when final posture verification fails (#9485)", () => {
    const failures = harnessResult.mutable_verification_failures as Array<
      Record<string, unknown>
    >;
    expect(failures).toHaveLength(2);
    const retainedFailure = {
      failure: "publisher-state-posture-invalid",
      emittedReceipt: null,
      finalPosture: null,
      persistedOperation: {
        posture: "mutable",
        rollbackPosture: "locked",
        phase: "top-applied",
        guardToken: "a".repeat(64),
      },
    };
    const canonicalCall = {
      action: "verify-mutable",
      configDir: expect.stringMatching(/\/sandbox\/\.hermes$/),
      identity: "production-identity",
      plan: {
        version: 1,
        readOnlyRoots: ["plugins", "workspace"],
        confidentialRoots: ["pairing"],
        readOnlyPrefixes: ["profile-"],
        confidentialPrefixes: ["secret-"],
        writableSubpaths: ["workspace/cache"],
      },
      options: {
        mutable_top_level_files: [
          expect.stringMatching(/\/sandbox\/\.hermes\/\.config-hash$/),
          expect.stringMatching(/\/sandbox\/\.hermes\/\.env$/),
          expect.stringMatching(/\/sandbox\/\.hermes\/config\.yaml$/),
        ],
      },
    };
    expect(failures).toMatchObject([
      {
        ...retainedFailure,
        finding: "verification-flags-mismatch",
        calls: [{ ...canonicalCall, finding: "verification-flags-mismatch" }],
      },
      {
        ...retainedFailure,
        finding: "verification-config-binding-changed",
        calls: [{ ...canonicalCall, finding: "verification-config-binding-changed" }],
      },
    ]);
  });

  it(
    "runs the Hermes entrypoint checkpoint, release acknowledgement, and parent resume in order (#10155)",
    { timeout: 15_000 },
    async () => {
      const temporary = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-hermes-entrypoint-checkpoint-"),
      );
      const fixture = createEntrypointGateFixture(temporary);
      const child = spawn("bash", [fixture.harnessPath], {
        env: entrypointGateEnvironment(fixture, "allow"),
        stdio: ["ignore", "ignore", "pipe"],
      });
      expect(child.pid).toBeTypeOf("number");
      const startPid = Number(child.pid);
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const completion = new Promise<{ signal: NodeJS.Signals | null; status: number | null }>(
        (resolve) => {
          child.once("exit", (status, signal) => resolve({ signal, status }));
        },
      );

      try {
        await waitForCondition("Hermes entrypoint checkpoint", () =>
          readEntrypointTrace(fixture.tracePath).some((line) => line.startsWith("checkpoint:")),
        );
        await waitForStoppedProcess(startPid, "Hermes entrypoint candidate stop");
        fs.writeFileSync(fixture.releasePath, '{"released":true}\n', { mode: 0o600 });
        expect(child.kill("SIGCONT")).toBe(true);

        await waitForCondition("release acknowledgement publication", () =>
          readEntrypointTrace(fixture.tracePath).some((line) => line.startsWith("acknowledge:")),
        );
        const acknowledgeLine = readEntrypointTrace(fixture.tracePath).find((line) =>
          line.startsWith("acknowledge:"),
        );
        const acknowledgePid = Number(acknowledgeLine?.split(":")[1]);
        expect(Number.isSafeInteger(acknowledgePid)).toBe(true);
        expect(acknowledgePid).toBeGreaterThan(1);
        await waitForStoppedProcess(
          acknowledgePid,
          "release acknowledgement child stop after publication",
        );
        process.kill(acknowledgePid, "SIGCONT");

        await waitForCondition("release acknowledgement completion", () =>
          readEntrypointTrace(fixture.tracePath).includes("acknowledged:" + String(acknowledgePid)),
        );
        await waitForStoppedProcess(
          startPid,
          "Hermes entrypoint parent stop after acknowledged child completion",
        );
        expect(child.kill("SIGCONT")).toBe(true);

        const result = await completion;
        expect(result.status, stderr).toBe(0);
        expect(result.signal).toBeNull();
        expect(JSON.parse(fs.readFileSync(fixture.acknowledgePath, "utf8"))).toEqual({
          pid: acknowledgePid,
        });
        expect(readEntrypointTrace(fixture.tracePath)).toEqual([
          "admit",
          "checkpoint-call",
          "checkpoint:" + String(startPid),
          "resume:" + String(startPid),
          "acknowledge:" + String(acknowledgePid),
          "acknowledged:" + String(acknowledgePid),
        ]);
      } finally {
        child.kill("SIGKILL");
        await completion;
        fs.rmSync(temporary, { force: true, recursive: true });
      }
    },
  );

  it("stops the actual Hermes entrypoint before startup when the durable gate denies admission (#10155)", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-entrypoint-denied-"));
    const fixture = createEntrypointGateFixture(temporary);
    try {
      const result = spawnSync("bash", [fixture.harnessPath], {
        encoding: "utf8",
        env: entrypointGateEnvironment(fixture, "deny"),
        timeout: 5_000,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Runtime state mutation startup gate failed");
      expect(readEntrypointTrace(fixture.tracePath)).toEqual(["admit"]);
      expect(fs.existsSync(fixture.acknowledgePath)).toBe(false);
    } finally {
      fs.rmSync(temporary, { force: true, recursive: true });
    }
  });

  it("fails closed with stable host recovery guidance for invalid gate state (#10155)", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-entrypoint-invalid-"));
    const fixture = createEntrypointGateFixture(temporary);
    try {
      const result = spawnSync("bash", [fixture.harnessPath], {
        encoding: "utf8",
        env: entrypointGateEnvironment(fixture, "invalid"),
        timeout: 5_000,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "invalid-state code=gate-receipt-invalid transaction=" + "c".repeat(64),
      );
      expect(result.stderr).toContain(
        "Run 'nemoclaw <sandbox-name> shields status' on the host",
      );
      expect(result.stderr).not.toContain("held by an active runtime state mutation");
      expect(readEntrypointTrace(fixture.tracePath)).toEqual(["admit"]);
      expect(fs.existsSync(fixture.acknowledgePath)).toBe(false);
    } finally {
      fs.rmSync(temporary, { force: true, recursive: true });
    }
  });
});
