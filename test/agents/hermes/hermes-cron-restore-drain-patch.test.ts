// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PATCHER = path.resolve("agents/hermes/patch-cron-restore-drain.py");

const DRAIN_SOURCE = `import functools
from pathlib import Path
from typing import Optional
from utils import atomic_json_write

_DRAIN_REQUEST_FILENAME = ".drain_request.json"


@functools.lru_cache(maxsize=1)
def current_instantiation_epoch():
    return "epoch"

def drain_requested(*, home: Optional[Path] = None) -> bool:
    """True iff a begin-drain marker for THIS instantiation is present.
    """
    return True


def drain_notification_suppressed(*, home: Optional[Path] = None) -> bool:
    return False
`;

const RUN_SOURCE = `class GatewayAuthorizationMixin:
    pass

class GatewayKanbanWatchersMixin:
    pass

class GatewaySlashCommandsMixin:
    pass

class GatewayRunner(GatewayAuthorizationMixin, GatewayKanbanWatchersMixin, GatewaySlashCommandsMixin):
    def __init__(self):
        # External (NAS-driven) drain state — distinct from the shutdown
        # \`\`_draining\`\` flag above. Set by \`\`_drain_control_watcher\`\` when the
        # \`\`.drain_request.json\`\` marker is present: the gateway flips
        # \`\`gateway_state -> draining\`\` and refuses NEW turns, but the process
        # does NOT exit (the whole point — quiesce-without-restart, D4a). It is
        # fully reversible: removing the marker reverts to \`\`running\`\` and
        # re-accepts turns. \`\`_draining\`\` (shutdown) is one-way and ends in
        # process exit; this one is a steady state NAS polls during its
        # request -> poll -> proceed loop.
        self._external_drain_active = False

    def _update_runtime_status(self, status):
        self.runtime_status = status

    def _enter_external_drain(self):
        if self._external_drain_active:
            return

    def _exit_external_drain(self):
        if not self._external_drain_active:
            return
        self._external_drain_active = False
`;

const JOBS_SOURCE = `from datetime import datetime, timedelta
from typing import Any, Dict, List

def get_due_jobs() -> List[Dict[str, Any]]:
    return []
`;

interface Fixture {
  drainControl: string;
  gatewayRun: string;
  cronJobs: string;
  root: string;
}

function createFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cron-drain-patch-"));
  const drainControl = path.join(root, "drain_control.py");
  const gatewayRun = path.join(root, "run.py");
  const cronJobs = path.join(root, "jobs.py");
  fs.writeFileSync(drainControl, DRAIN_SOURCE);
  fs.writeFileSync(gatewayRun, RUN_SOURCE);
  fs.writeFileSync(cronJobs, JOBS_SOURCE);
  return { drainControl, gatewayRun, cronJobs, root };
}

function runPatcher(fixture: Fixture) {
  return spawnSync(
    process.env.PYTHON || "python3",
    [
      "-I",
      PATCHER,
      "--drain-control",
      fixture.drainControl,
      "--gateway-run",
      fixture.gatewayRun,
      "--cron-jobs",
      fixture.cronJobs,
    ],
    { encoding: "utf8" },
  );
}

describe("Hermes cron restore drain source patch", () => {
  it("composes independent drains and hydrates the startup gate synchronously", () => {
    const fixture = createFixture();
    try {
      const patchResult = runPatcher(fixture);
      expect(patchResult.status, patchResult.stderr).toBe(0);
      const probe = `
import importlib.util
import json
import os
import stat
import sys
import types
from pathlib import Path

utils = types.ModuleType("utils")
utils.atomic_json_write = lambda *args, **kwargs: None
sys.modules["utils"] = utils

def load(name, source):
    spec = importlib.util.spec_from_file_location(name, source)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module

drain = load("gateway.drain_control", sys.argv[1])
gateway = types.ModuleType("gateway")
gateway.__path__ = []
gateway.drain_control = drain
sys.modules["gateway"] = gateway

drain.operator_drain_requested = lambda home=None: False
original_open, original_fstat, original_stat, original_close = os.open, os.fstat, os.stat, os.close
os.open = lambda *_args, **_kwargs: 42
os.fstat = lambda _fd: types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=0, st_gid=0)
os.close = lambda _fd: None
try:
    os.stat = lambda *_args, **_kwargs: (_ for _ in ()).throw(FileNotFoundError())
    absent = drain.drain_requested()
    os.stat = lambda *_args, **_kwargs: types.SimpleNamespace()
    present = drain.drain_requested()
    runner_module = load("patched_gateway_run", sys.argv[2])
    runner = runner_module.GatewayRunner()
    runner._enter_external_drain()
finally:
    os.open, os.fstat, os.stat, os.close = original_open, original_fstat, original_stat, original_close

print(json.dumps({
    "absent": absent,
    "present": present,
    "startup_active": runner._external_drain_active,
    "runtime_status": runner.runtime_status,
}))
`;
      const result = spawnSync(
        process.env.PYTHON || "python3",
        ["-I", "-c", probe, fixture.drainControl, fixture.gatewayRun],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        absent: false,
        present: true,
        runtime_status: "draining",
        startup_active: true,
      });
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("re-arms eligible one-shots in every profile before the restore gate opens", () => {
    const fixture = createFixture();
    try {
      const patchResult = runPatcher(fixture);
      expect(patchResult.status, patchResult.stderr).toBe(0);
      const probe = `
import contextlib
import importlib.util
import json
from datetime import datetime, timezone

spec = importlib.util.spec_from_file_location("patched_jobs", ${JSON.stringify(fixture.cronJobs)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
now = datetime(2026, 8, 30, 12, 0, 0, tzinfo=timezone.utc)
not_before = datetime(2026, 8, 30, 11, 50, 0, tzinfo=timezone.utc)
default_jobs = [
    {"id": "held", "enabled": True, "state": "scheduled", "last_run_at": None,
     "run_claim": None, "fire_claim": None, "repeat": {"completed": 0},
     "schedule": {"kind": "once", "run_at": "2026-08-30T11:55:00+00:00"},
     "next_run_at": "2026-08-30T11:55:00+00:00"},
    {"id": "old", "enabled": True, "state": "scheduled", "last_run_at": None,
     "run_claim": None, "fire_claim": None,
     "schedule": {"kind": "once", "run_at": "2026-08-30T11:40:00+00:00"},
     "next_run_at": "2026-08-30T11:40:00+00:00"},
    {"id": "future", "enabled": True, "state": "scheduled", "last_run_at": None,
     "run_claim": None, "fire_claim": None,
     "schedule": {"kind": "once", "run_at": "2026-08-30T12:05:00+00:00"},
     "next_run_at": "2026-08-30T12:05:00+00:00"},
    {"id": "claimed", "enabled": True, "state": "scheduled", "last_run_at": None,
     "run_claim": {"by": "other"}, "fire_claim": None,
     "schedule": {"kind": "once", "run_at": "2026-08-30T11:55:00+00:00"},
     "next_run_at": "2026-08-30T11:55:00+00:00"},
]
named_jobs = [
    {"id": "named-held", "enabled": True, "state": "scheduled", "last_run_at": None,
     "run_claim": None, "fire_claim": None, "repeat": {"completed": 0},
     "schedule": {"kind": "once", "run_at": "2026-08-30T11:58:00+00:00"},
     "next_run_at": "2026-08-30T11:58:00+00:00"},
    {"id": "named-disabled", "enabled": False, "state": "scheduled", "last_run_at": None,
     "run_claim": None, "fire_claim": None,
     "schedule": {"kind": "once", "run_at": "2026-08-30T11:58:00+00:00"},
     "next_run_at": "2026-08-30T11:58:00+00:00"},
]
stores = {"default": default_jobs, "named": named_jobs}
saved = []
active_home = None

@contextlib.contextmanager
def use_cron_store(home):
    global active_home
    previous = active_home
    active_home = home
    try:
        yield
    finally:
        active_home = previous

module._hermes_now = lambda: now
module._ensure_aware = lambda value: value
module.parse_schedule = lambda value: {"kind": "once", "run_at": value, "display": value}
module.compute_next_run = lambda schedule: schedule["run_at"]
module.use_cron_store = use_cron_store
module.load_jobs = lambda: stores[active_home]
module.save_jobs = lambda value: saved.append({"home": active_home, "jobs": json.loads(json.dumps(value))})
module._jobs_lock = contextlib.nullcontext
changed = module.rearm_nemoclaw_drained_oneshots(not_before, ["default", "named"])
now = datetime(2026, 8, 30, 12, 0, 5, tzinfo=timezone.utc)
replayed = module.rearm_nemoclaw_drained_oneshots(not_before, ["default", "named"])
print(json.dumps({"changed": changed, "replayed": replayed, "stores": stores, "saved": saved}))
`;
      const result = spawnSync(process.env.PYTHON || "python3", ["-I", "-c", probe], {
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      const observed = JSON.parse(result.stdout) as {
        changed: number;
        replayed: number;
        stores: Record<
          string,
          Array<{ id: string; next_run_at: string; nemoclaw_restore_rearm_gate?: string }>
        >;
        saved: Array<{ home: string }>;
      };

      expect(observed.changed).toBe(2);
      expect(observed.replayed).toBe(2);
      expect(observed.saved.map(({ home }) => home)).toEqual([
        "default",
        "named",
        "default",
        "named",
      ]);
      expect(observed.stores.default.find((job) => job.id === "held")?.next_run_at).toBe(
        "2026-08-30T12:00:07+00:00",
      );
      expect(observed.stores.default.find((job) => job.id === "future")?.next_run_at).toBe(
        "2026-08-30T12:05:00+00:00",
      );
      expect(observed.stores.default.find((job) => job.id === "old")?.next_run_at).toBe(
        "2026-08-30T11:40:00+00:00",
      );
      expect(observed.stores.default.find((job) => job.id === "claimed")?.next_run_at).toBe(
        "2026-08-30T11:55:00+00:00",
      );
      expect(observed.stores.named.find((job) => job.id === "named-held")?.next_run_at).toBe(
        "2026-08-30T12:00:07+00:00",
      );
      expect(
        observed.stores.default.find((job) => job.id === "held")?.nemoclaw_restore_rearm_gate,
      ).toBe("2026-08-30T11:50:00+00:00");
      expect(
        observed.stores.named.find((job) => job.id === "named-held")?.nemoclaw_restore_rearm_gate,
      ).toBe("2026-08-30T11:50:00+00:00");
      expect(observed.stores.named.find((job) => job.id === "named-disabled")?.next_run_at).toBe(
        "2026-08-30T11:58:00+00:00",
      );
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
