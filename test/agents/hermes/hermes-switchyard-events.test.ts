// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projector = path.resolve(
  import.meta.dirname,
  "../../../agents/hermes/plugin/switchyard_events.py",
);
const load = String.raw`
import importlib.util, io, json, logging, sys, types
spec = importlib.util.spec_from_file_location("events", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
`;
const fixture =
  load +
  String.raw`
event = {
    "kind": "mark", "uuid": "a2165906-9c2c-4846-9a01-2a091eb55876",
    "parent_uuid": "86245902-76db-4234-b586-9697fbfdbfff",
    "name": module.DECISION, "data_schema": None,
    "metadata": {"api_key": "private-sentinel"},
    "data": {"selected_model": "efficient", "evidence": {
        "source": "llm-classifier", "reasoning": "private-sentinel"},
        "prompt": "private-sentinel", "authorization": "private-sentinel"},
}
event.update(json.loads(sys.argv[2]))
print(json.dumps(module.project(types.SimpleNamespace(**event), ("capable", "efficient", "capable"))))
`;

function run(program: string, options: Record<string, unknown>) {
  const result = spawnSync("python3", ["-I", "-c", program, projector, JSON.stringify(options)], {
    encoding: "utf8",
    timeout: 5000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout + result.stderr).not.toContain("private-sentinel");
  return JSON.parse(result.stdout);
}

function project(overrides: Record<string, unknown> = {}) {
  return run(fixture, overrides);
}

const lifecycle =
  load +
  String.raw`
import builtins, os
case = json.loads(sys.argv[2])
state = {"registered": 0, "removed": 0, "read": 0, "imports": 0, "callbacks": []}
log = io.StringIO()
handler = logging.StreamHandler(log)
module.logging.getLogger("gateway.nemoclaw_switchyard").addHandler(handler)
os.environ.pop("NEMOCLAW_HERMES_SWITCHYARD_SHA256", None)
if not case.get("disabled"):
    os.environ["NEMOCLAW_HERMES_SWITCHYARD_SHA256"] = "a" * 64
def read():
    state["read"] += 1
    return {"switchyardDeploymentToml": ""}
def helper(name, path):
    if case.get("read_failure"): raise ValueError("private-sentinel")
    if name.endswith("preflight"):
        return types.SimpleNamespace(read_installed=read, fingerprint=lambda files: ("b" if case.get("drift") else "a") * 64)
    return types.SimpleNamespace(selected_models=lambda deployment: ("capable", "efficient", "capable"))
module._load_helper = helper
def register(name, observer):
    if case.get("register_failure"): raise ValueError("private-sentinel")
    state["registered"] += 1
    state["observer"] = observer
def deregister(name): state["removed"] += 1
def on_unload(callback):
    if case.get("unload_failure"): raise ValueError("private-sentinel")
    state["callbacks"].append(callback)
sys.modules["nemo_relay"] = types.SimpleNamespace(subscribers=types.SimpleNamespace(register=register, deregister=deregister))
original_import = builtins.__import__
def counted_import(name, *args, **kwargs):
    if name == "nemo_relay":
        state["imports"] += 1
        if case.get("relay_failure"): raise ValueError("private-sentinel")
    return original_import(name, *args, **kwargs)
builtins.__import__ = counted_import
result = module.install(types.SimpleNamespace(on_unload=on_unload))
for callback in state.pop("callbacks"): callback()
observer = state.pop("observer", None)
print(json.dumps({**state, "installed": result, "stopped": None if observer is None else observer.stopped, "diagnostic": log.getvalue()}))
`;

describe("Hermes routing event projection", () => {
  it("does not import Relay or read routing files when routing is disabled", () => {
    expect(run(lifecycle, { disabled: true })).toMatchObject({
      installed: false,
      registered: 0,
      read: 0,
      imports: 0,
    });
  });

  it("does not register an observer against drifted configuration", () => {
    expect(run(lifecycle, { drift: true })).toMatchObject({ installed: false, registered: 0 });
  });

  it.each(["read_failure", "register_failure"])(
    "reports incomplete capture without leaking %s exceptions",
    (failure) => {
      expect(run(lifecycle, { [failure]: true })).toMatchObject({
        installed: false,
        registered: 0,
        removed: 0,
      });
    },
  );

  it("deregisters and stops the existing-process subscriber on plugin unload", () => {
    expect(run(lifecycle, {})).toMatchObject({
      installed: true,
      registered: 1,
      removed: 1,
      stopped: true,
    });
  });

  it("removes the subscriber when unload registration fails without logging the exception", () => {
    expect(run(lifecycle, { unload_failure: true })).toMatchObject({
      installed: false,
      registered: 1,
      removed: 1,
      stopped: true,
    });
  });

  it.each([
    ["read_failure", "configuration"],
    ["relay_failure", "relay"],
    ["register_failure", "subscriber"],
    ["unload_failure", "unload"],
  ])("identifies the safe installation stage for %s", (failure, stage) => {
    expect(run(lifecycle, { [failure]: true }).diagnostic).toContain(
      `capture unavailable (${stage})`,
    );
  });

  it("marks truncated capture and stops emitting at the process limit", () => {
    const program =
      load +
      String.raw`
records = []
observer = module.Observer(("capable", "efficient", "capable"), lambda line: records.append(json.loads(line)), limit=2)
event = types.SimpleNamespace(kind="scope", name="hermes.turn", scope_category="start", uuid="a2165906-9c2c-4846-9a01-2a091eb55876", parent_uuid=None)
for _ in range(8): observer(event)
print(json.dumps(records))
`;
    const records = run(program, {});
    expect(records).toHaveLength(3);
    expect(records[2]).toMatchObject({ kind: "truncated", sequence: 3 });
  });

  it("does not emit queued events after unload", () => {
    const program =
      load +
      String.raw`
records = []
observer = module.Observer(("capable", "efficient", "capable"), records.append)
observer.stop()
observer(types.SimpleNamespace())
print(json.dumps(records))
`;
    expect(run(program, {})).toEqual([]);
  });

  it("distinguishes recorder instances when the PID and sequence repeat", () => {
    const records = run(
      load +
        String.raw`
module.os.getpid = lambda: 42
records = []
event = types.SimpleNamespace(kind="scope", name="hermes.turn", scope_category="start", uuid="a2165906-9c2c-4846-9a01-2a091eb55876", parent_uuid=None)
for _ in range(2):
    observer = module.Observer(("capable", "efficient", "capable"), lambda line: records.append(json.loads(line)), limit=1)
    observer(event)
    observer(event)
print(json.dumps(records))
`,
      {},
    );
    expect(records).toHaveLength(4);
    expect(records[0]).toMatchObject({ pid: 42, sequence: 1, instance_id: expect.any(String) });
    expect(records[2]).toMatchObject({ pid: 42, sequence: 1, instance_id: expect.any(String) });
    expect(records[0].instance_id).not.toBe(records[2].instance_id);
    expect(records[1]).toMatchObject({
      kind: "truncated",
      sequence: 2,
      instance_id: records[0].instance_id,
    });
    expect(records[3]).toMatchObject({
      kind: "truncated",
      sequence: 2,
      instance_id: records[2].instance_id,
    });
  });

  it("identifies the recorder instance in capture-failure markers", () => {
    const records = run(
      load +
        String.raw`
records = []
observer = module.Observer(("capable", "efficient", "capable"), lambda line: records.append(json.loads(line)))
event = types.SimpleNamespace(kind="scope", name="hermes.turn", scope_category="start", uuid="a2165906-9c2c-4846-9a01-2a091eb55876", parent_uuid=None)
observer(event)
def fail(*args): raise ValueError("private-sentinel")
module.project = fail
observer(event)
observer(event)
print(json.dumps(records))
`,
      {},
    );
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({
      kind: "capture_failed",
      pid: records[0].pid,
      sequence: 2,
      instance_id: records[0].instance_id,
    });
    expect(records[1].instance_id).toEqual(expect.any(String));
  });

  describe.each([
    [
      "switchyard.routing.decision",
      { selected_model: "efficient", evidence: { source: "llm-classifier" } },
    ],
    [
      "switchyard.routing.llm_call",
      { selected_model: "capable", call_role: "routing", outcome: "ok" },
    ],
  ])("%s schema validation", (name, data) => {
    it("accepts the pinned named schema and Relay's schema-less form", () => {
      expect(project({ name, data, data_schema: { name, version: "1" } })).not.toBeNull();
      expect(project({ name, data, data_schema: null })).not.toBeNull();
    });

    it.each([{ name: "unrelated.future.schema", version: "99" }, {}, "private-sentinel"])(
      "rejects unsupported schema %j on an otherwise-valid mark",
      (data_schema) => {
        expect(project({ name, data, data_schema })).toBeNull();
      },
    );

    it("rejects future versions of the correct mark schema", () => {
      expect(project({ name, data, data_schema: { name, version: "2" } })).toBeNull();
    });
  });

  it("ignores token metrics instead of exporting unrelated event payloads", () => {
    expect(
      project({
        name: "switchyard.routing.llm_tokens",
        data: { measurements: "private-sentinel" },
      }),
    ).toBeNull();
  });

  it("retains canonical ancestry and model identity without payloads", () => {
    expect(project()).toEqual({
      schema: 1,
      uuid: "a2165906-9c2c-4846-9a01-2a091eb55876",
      parent_uuid: "86245902-76db-4234-b586-9697fbfdbfff",
      kind: "mark",
      name: "switchyard.routing.decision",
      selected_model_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      source: "llm-classifier",
    });
  });

  it.each([
    { uuid: "private-sentinel" },
    { parent_uuid: "private-sentinel" },
    { name: "private-sentinel" },
    { data: { selected_model: "private-sentinel", evidence: { source: "llm-classifier" } } },
    { data: { selected_model: "efficient", evidence: { source: "fail_open" } } },
    {
      name: "switchyard.routing.llm_call",
      data: { call_role: "routing", selected_model: "efficient", outcome: "ok" },
    },
    {
      name: "switchyard.routing.llm_call",
      data: { call_role: "answer", selected_model: "capable", outcome: "private-sentinel" },
    },
  ])("rejects unsupported or unbound event fields (%j)", (event) => {
    expect(project(event)).toBeNull();
  });

  it("retains Hermes turn boundaries without scope data or metadata", () => {
    expect(project({ kind: "scope", name: "hermes.turn", scope_category: "start" })).toMatchObject({
      kind: "scope",
      phase: "start",
      hermes_turn: true,
    });
  });

  it.each(["routing", "answer"])(
    "identifies the %s role when the physical model is reused",
    (role) => {
      expect(
        project({
          name: "switchyard.routing.llm_call",
          data: {
            call_role: role,
            selected_model: "capable",
            outcome: "ok",
            error: "private-sentinel",
          },
        }),
      ).toMatchObject({ call_role: role, outcome: "ok" });
    },
  );
});
