// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const PATCHER = path.join(ROOT, "agents", "hermes", "patch-external-supervisor-restart.py");

const UPSTREAM_FIXTURE = `import json
import sys
import types

events = []
scenario = sys.argv[1]

status = types.ModuleType("gateway.status")
status.get_running_pid = lambda: None if scenario == "missing" else 4321
gateway = types.ModuleType("gateway")
gateway.status = status
sys.modules["gateway"] = gateway
sys.modules["gateway.status"] = status


def _capture_gateway_argv(pid):
    events.append(["capture", pid])
    if scenario == "external" or scenario == "timeout":
        return ["hermes.real", "gateway", "run", "--external-supervisor"]
    return ["hermes.real", "gateway", "run"]


def _get_restart_exit_wait_budget():
    return 17.0


def _graceful_restart_via_sigusr1(pid, timeout):
    events.append(["signal", pid, timeout])
    return scenario != "timeout"


def _refuse_from_inside_gateway(*args):
    events.append(["refuse", *args])


def _guard_named_profile_under_multiplexer(*, force):
    events.append(["guard", force])


def _dispatch_all_via_service_manager_if_s6(action):
    return False


def _dispatch_via_service_manager_if_s6(action):
    return False


def _restart_all(system):
    events.append(["restart-all", system])


def _installed_service_kind_for(windows):
    return None


is_windows = False


def stop_profile_gateway():
    events.append(["manual-stop"])
    return False


def _wait_for_gateway_exit(*, timeout, force_after):
    events.append(["manual-wait", timeout, force_after])


def run_gateway(*, verbose, force):
    events.append(["manual-start", verbose, force])


def _cmd_restart(args):
    _refuse_from_inside_gateway("restart", "restart loops")
    system = getattr(args, "system", False)
    restart_all = getattr(args, "all", False)
    force = getattr(args, "force", False)
    _guard_named_profile_under_multiplexer(force=force)
    if restart_all and _dispatch_all_via_service_manager_if_s6("restart"):
        return
    if not restart_all and _dispatch_via_service_manager_if_s6("restart"):
        return
    if restart_all:
        _restart_all(system)
        return

    # The Windows restart path handles both registered installs and detached restarts.
    kind = _installed_service_kind_for(is_windows)
    service_configured = kind is not None and (kind != "windows" or _gw_windows().is_installed())
    if kind is not None:
        raise AssertionError("fixture does not exercise service managers")

    if service_configured:
        raise AssertionError("fixture does not configure a service")

    if stop_profile_gateway():
        print("stopped")
    _wait_for_gateway_exit(timeout=10.0, force_after=5.0)
    run_gateway(verbose=0, force=force)


if __name__ == "__main__":
    args = types.SimpleNamespace(system=False, all=False, force=False)
    try:
        _cmd_restart(args)
    except SystemExit as error:
        print(json.dumps({"events": events, "exit": error.code}))
        raise
    print(json.dumps({"events": events, "exit": 0}))
`;

function writeFixture(): { gatewayPath: string; temporaryRoot: string } {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-restart-"));
  const gatewayPath = path.join(temporaryRoot, "gateway.py");
  fs.writeFileSync(gatewayPath, UPSTREAM_FIXTURE);
  return { gatewayPath, temporaryRoot };
}

function patch(gatewayPath: string) {
  return spawnSync("python3", ["-I", PATCHER, gatewayPath], {
    encoding: "utf8",
    timeout: 5000,
  });
}

function run(gatewayPath: string, scenario: string) {
  return spawnSync("python3", ["-I", gatewayPath, scenario], {
    encoding: "utf8",
    timeout: 5000,
  });
}

function lastJson(stdout: string) {
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as {
    events: unknown[][];
    exit: number;
  };
}

describe("Hermes external-supervisor restart patch", () => {
  it("routes an externally supervised gateway through SIGUSR1 and remains idempotent", () => {
    const { gatewayPath, temporaryRoot } = writeFixture();
    try {
      expect(patch(gatewayPath).status).toBe(0);
      expect(patch(gatewayPath).status).toBe(0);

      const result = run(gatewayPath, "external");
      expect(result.status, result.stderr).toBe(0);
      expect(lastJson(result.stdout)).toMatchObject({
        events: [
          ["refuse", "restart", "restart loops"],
          ["guard", false],
          ["capture", 4321],
          ["signal", 4321, 17],
        ],
        exit: 0,
      });
      expect(result.stdout).toContain("Handed gateway restart to the external supervisor");
      expect(result.stdout).not.toContain("manual-stop");
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it.each(["manual", "missing"])("preserves the upstream %s restart path", (scenario) => {
    const { gatewayPath, temporaryRoot } = writeFixture();
    try {
      expect(patch(gatewayPath).status).toBe(0);
      const result = run(gatewayPath, scenario);
      expect(result.status, result.stderr).toBe(0);
      const output = lastJson(result.stdout);
      expect(output.events).toContainEqual(["manual-stop"]);
      expect(output.events).toContainEqual(["manual-start", 0, false]);
      expect(output.events.some((event) => event[0] === "signal")).toBe(false);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("fails instead of falling through when the supervised gateway does not exit", () => {
    const { gatewayPath, temporaryRoot } = writeFixture();
    try {
      expect(patch(gatewayPath).status).toBe(0);
      const result = run(gatewayPath, "timeout");
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("Externally supervised gateway did not exit for restart");
      const output = lastJson(result.stdout);
      expect(output.events).toContainEqual(["signal", 4321, 17]);
      expect(output.events).not.toContainEqual(["manual-stop"]);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when the pinned restart shape changes", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-restart-drift-"));
    try {
      const gatewayPath = path.join(temporaryRoot, "gateway.py");
      fs.writeFileSync(gatewayPath, "def _cmd_restart_changed(args):\n    pass\n");
      const result = patch(gatewayPath);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("external-supervisor restart source shape changed");
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
