// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";
import { bashPrintfQ, extractShellFunction } from "../../support/hermes-shell-harness";
import { switchyardBindingFixture } from "../../helpers/hermes-switchyard";
import {
  createHermesSwitchyardRoutingIntent,
  serializeHermesSwitchyardRouting,
} from "../../../src/lib/hermes-switchyard-routing";

const qualifier = path.resolve(
  import.meta.dirname,
  "../../../agents/hermes/qualify-switchyard-judge.py",
);
const start = fs.readFileSync(
  path.resolve(import.meta.dirname, "../../../agents/hermes/start.sh"),
  "utf8",
);

// Match contributor setup: the default python3 may be older than Python 3.11.
const selectedPython = ["python3", "python3.14", "python3.13", "python3.12", "python3.11"].find(
  (candidate) =>
    spawnSync(candidate, ["-I", "-c", "import sys; sys.exit(sys.version_info < (3, 11))"], {
      encoding: "utf8",
      timeout: 5000,
    }).status === 0,
);
assert.ok(selectedPython, "Switchyard qualification tests require Python 3.11 or newer");
const python: string = selectedPython;

// Native routing stays a packaged-runtime contract. This fake supplies only its public event/API boundary.
const fixture = String.raw`
import asyncio, importlib.util, json, os, sys, types
spec = importlib.util.spec_from_file_location("qualifier", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
case = json.loads(sys.argv[2])
if case.get("configuration_failure"):
    def fail_read(path): raise ValueError("sk-test-private-configuration")
    module.read_configuration = fail_read
    print(json.dumps({"result": module.main()}))
    sys.exit(0)
judge = "capable-model" if case.get("reuse", True) else "judge-model"
models = (judge, "efficient-model", "capable-model")
if "deployment" in case:
    try: models = module.selected_models(case["deployment"])
    except Exception:
        print(json.dumps({"result": "rejected", "requests": 0, "stage": "configuration"}))
        sys.exit(0)
events = [
    {"name": "switchyard.routing.decision", "data": {
        "selected_model": "capable-model", "evidence": {"source": "llm-classifier", "score": 0.1}}},
    {"name": "switchyard.routing.llm_call", "data": {
        "call_role": "routing", "selected_model": judge, "outcome": "ok"}},
    {"name": "switchyard.routing.llm_call", "data": {
        "call_role": "answer", "selected_model": "capable-model", "outcome": "ok"}},
]
for role, model in (("routing", judge), ("answer", "capable-model")):
    events.append({"name": "switchyard.routing.llm_tokens", "data_schema": {
        "name": "nemo.relay.metric_measurements", "version": "1"}, "data": {"measurements": [{
        "name": "switchyard.routing.llm_tokens", "value": 1,
        "attributes": {"call_role": role, "target_model": model, "token_type": "total"}}]}})
failure = case.get("failure")
if failure == "fail-open": events[0]["data"]["evidence"]["source"] = "fail_open"
if failure == "no-verdict": del events[0]["data"]["evidence"]
if failure == "missing-decision": events.pop(0)
if failure == "duplicate-decision": events.append(events[0])
if failure == "wrong-judge": events[1]["data"]["selected_model"] = "unselected-model"
if failure == "failed-judge": events[1]["data"]["outcome"] = "error"
if failure == "no-judge-call": events.pop(1)
if failure == "wrong-answer": events[0]["data"]["selected_model"] = "unselected-model"
if failure == "missing-usage": events.pop(3)
if failure == "merged-usage": events[3]["data"]["measurements"][0]["attributes"]["call_role"] = "answer"
if failure == "wrong-usage-model": events[3]["data"]["measurements"][0]["attributes"]["target_model"] = "unselected-model"
if failure == "invalid-usage": events[3]["data"]["measurements"][0]["value"] = True
if failure == "invalid-metric-schema": events[3]["data_schema"]["version"] = "2"
if failure == "overflow": events *= 40
subscriber = None
state = {"shutdown": 0, "deregister": 0, "requests": 0, "flush": 0}
def register(name, callback):
    global subscriber
    if failure == "register": raise ValueError("test-secret-registration")
    subscriber = callback
def deregister(name):
    global subscriber
    state["deregister"] += 1
    subscriber = None
def flush():
    state["flush"] += 1
    if failure == "flush": raise ValueError("sk-test-private-flush")
    if state["requests"] == 1 and state["flush"] == 1:
        for event in events:
            subscriber(types.SimpleNamespace(kind="mark", data_schema=None, **event)
                       if "data_schema" not in event else types.SimpleNamespace(kind="mark", **event))
async def execute(name, request, next):
    state["requests"] += 1
    state["request_name"] = name
    state["request_model"] = request.content["model"]
    state["max_completion_tokens"] = request.content["max_completion_tokens"]
    if failure == "transport": raise ValueError("sk-test-private-provider-error")
    if failure == "timeout": await asyncio.Event().wait()
    if failure == "passthrough": return await next(request)
    return {"choices": [{"message": {"content": "do not expose model output"}}]}
class Runtime:
    def managed_execution_enabled(self): return failure != "disabled"
    def shutdown(self):
        state["shutdown"] += 1
        if failure == "shutdown": raise ValueError("sk-test-private-shutdown")
relay = types.SimpleNamespace(
    LLMRequest=lambda headers, content: types.SimpleNamespace(headers=headers, content=content),
    llm=types.SimpleNamespace(execute=execute),
    subscribers=types.SimpleNamespace(register=register, deregister=deregister, flush=flush))
os.environ[module.PLUGINS_ENV] = "previous-config"
try:
    module.qualify(models, relay=relay, runtime_factory=Runtime, timeout_seconds=0.02)
except Exception:
    state["result"] = "rejected"
else:
    state["result"] = "qualified"
state["subscriber_removed"] = subscriber is None
state["environment_restored"] = os.environ[module.PLUGINS_ENV] == "previous-config"
print(json.dumps(state))
`;

function runFixture(options: Record<string, unknown>) {
  const result = spawnSync(python, ["-I", "-c", fixture, qualifier, JSON.stringify(options)], {
    encoding: "utf8",
    timeout: 5000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(`${result.stdout}${result.stderr}`).not.toMatch(
    /sk-test-private|test-secret|do not expose/,
  );
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe("Switchyard judge startup qualification", () => {
  it.each(["launch_hermes_gateway", "launch_hermes_gateway_current_user"])(
    "keeps %s stopped when recovery qualification fails (#13863)",
    (entry) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-judge-recovery-"));
      const probes = path.join(directory, "probes");
      const launches = path.join(directory, "launches");
      try {
        const result = spawnSync(
          "bash",
          [
            "-c",
            [
              "set -euo pipefail",
              `PROBES=${bashPrintfQ(probes)}; LAUNCHES=${bashPrintfQ(launches)}`,
              "HERMES_DIR=/unused; _HERMES_PYTHON=judge_python; HERMES_RESTART_SEALED=1",
              "HERMES=fake_gateway; HERMES_SANDBOX_LAZY_INSTALL_TARGET=/unused; INTERNAL_PORT=3000",
              "STEP_DOWN_PREFIX_GATEWAY=(env); _HERMES_SWITCHYARD_JUDGE_QUALIFIED=0",
              `HERMES_GATEWAY_RECOVERY_WAITING_FILE=${bashPrintfQ(path.join(directory, "absent-marker"))}`,
              "id() { printf 1000; }",
              '[() { if [[ "${3:-}" == /usr/local/share/nemoclaw/hermes-* ]]; then return 1; fi; builtin [ "$@"; }',
              'judge_python() { local previous=0; [[ ! -f "$PROBES" ]] || previous=1; printf "probe\\n" >>"$PROBES"; return "$previous"; }',
              "cleanup_stale_hermes_gateway_runtime() { :; }",
              "hermes_capture_tracked_role() { :; }",
              'nohup() { printf "launch\\n" >>"$LAUNCHES"; }',
              extractShellFunction(start, "qualify_hermes_switchyard_judge"),
              extractShellFunction(start, entry).replaceAll(
                "/tmp/gateway.log",
                path.join(directory, "gateway.log"),
              ),
              `${entry}; wait "$GATEWAY_PID"`,
              `if ${entry}; then wait "$GATEWAY_PID"; exit 42; fi`,
            ].join("\n"),
          ],
          { encoding: "utf8", timeout: 5000 },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(fs.readFileSync(probes, "utf8")).toBe("probe\nprobe\n");
        expect(fs.readFileSync(launches, "utf8")).toBe("launch\n");
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("ignores an inherited qualification flag before every probe (#13863)", () => {
    const result = spawnSync(
      "bash",
      [
        "-c",
        [
          "set -euo pipefail",
          "HERMES_DIR=/unused; _HERMES_PYTHON=judge_python",
          "id() { printf 1000; }",
          // The file-presence boundary is enabled without creating system routing files.
          '[() { if [[ "$3" == /usr/local/share/nemoclaw/hermes-* ]]; then return 1; fi; builtin [ "$@"; }',
          // Record invocation on a dedicated descriptor because production suppresses child output.
          "judge_python() { printf probe >&3; }",
          extractShellFunction(start, "qualify_hermes_switchyard_judge"),
          "qualify_hermes_switchyard_judge 3>&1",
          "qualify_hermes_switchyard_judge 3>&1",
        ].join("\n"),
      ],
      {
        encoding: "utf8",
        timeout: 5000,
        env: { ...process.env, _HERMES_SWITCHYARD_JUDGE_QUALIFIED: "1" },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("probeprobe");
  });

  it.each([false, true])(
    "reads generated routing with a dedicated judge=%s (#13863)",
    (dedicated) => {
      const intent = createHermesSwitchyardRoutingIntent({
        efficient: { provider: "nvidia-prod", model: "efficient-model" },
        capable: { provider: "openai-api", model: "capable-model" },
        ...(dedicated ? { judge: { provider: "anthropic-prod", model: "judge-model" } } : {}),
      });
      const deployment = parseToml(
        serializeHermesSwitchyardRouting(intent, switchyardBindingFixture(intent))
          .switchyardDeploymentToml,
      );
      expect(runFixture({ deployment, reuse: !dedicated })).toMatchObject({
        result: "qualified",
        requests: 1,
      });
    },
  );

  it("redacts configuration errors at the process boundary (#13863)", () => {
    expect(runFixture({ configuration_failure: true })).toMatchObject({ result: 1 });
  });

  it.each([true, false])(
    "qualifies native judge evidence with capable reuse=%s (#13863)",
    (reuse) => {
      expect(runFixture({ reuse })).toMatchObject({
        result: "qualified",
        requests: 1,
        shutdown: 1,
        deregister: 1,
        subscriber_removed: true,
        environment_restored: true,
        request_name: "openai.chat_completions",
        request_model: "switchyard",
        max_completion_tokens: 8,
      });
    },
  );

  it.each([
    "fail-open",
    "no-verdict",
    "missing-decision",
    "duplicate-decision",
    "wrong-judge",
    "failed-judge",
    "no-judge-call",
    "wrong-answer",
    "missing-usage",
    "merged-usage",
    "wrong-usage-model",
    "invalid-usage",
    "invalid-metric-schema",
    "overflow",
    "transport",
    "timeout",
    "passthrough",
    "disabled",
    "flush",
    "shutdown",
  ])("keeps routing stopped after %s evidence and cleans the probe (#13863)", (failure) => {
    expect(runFixture({ failure })).toMatchObject({
      result: "rejected",
      shutdown: 1,
      deregister: 1,
      subscriber_removed: true,
      environment_restored: true,
    });
  });

  it("restores the environment after subscriber registration fails (#13863)", () => {
    expect(runFixture({ failure: "register" })).toMatchObject({
      result: "rejected",
      requests: 0,
      shutdown: 0,
      deregister: 0,
      subscriber_removed: true,
      environment_restored: true,
    });
  });

  it.each(["launch_hermes_gateway", "launch_hermes_gateway_current_user"])(
    "does not launch %s when qualification fails (#13863)",
    (entry) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-judge-launch-"));
      try {
        const result = spawnSync(
          "bash",
          [
            "-c",
            [
              "set -euo pipefail",
              "HERMES_RESTART_SEALED=1",
              `HERMES_GATEWAY_RECOVERY_WAITING_FILE=${JSON.stringify(path.join(directory, "absent-marker"))}`,
              "cleanup_stale_hermes_gateway_runtime() { :; }",
              "qualify_hermes_switchyard_judge() { return 1; }",
              "nohup() { printf forbidden-launch; }",
              extractShellFunction(start, entry),
              entry,
            ].join("\n"),
          ],
          { encoding: "utf8", timeout: 5000 },
        );
        expect(result.status).toBe(1);
        expect(result.stdout).not.toContain("forbidden-launch");
        expect(result.stderr).not.toContain("command not found");
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
