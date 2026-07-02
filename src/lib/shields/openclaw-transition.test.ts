// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

const requireSource = createRequire(import.meta.url);
const INDEX_MODULE = "./index.js";

type ShieldsModule = typeof import("./index");

function openClawTarget() {
  return {
    agentName: "openclaw",
    configPath: "/sandbox/.openclaw/openclaw.json",
    configDir: "/sandbox/.openclaw",
    format: "json",
    configFile: "openclaw.json",
    sensitiveFiles: ["/sandbox/.openclaw/.config-hash"],
  };
}

describe("OpenClaw shields top-config transaction", () => {
  let homeDir: string;
  let shields: ShieldsModule;
  let spies: MockInstance[];
  let dockerExecSpy: MockInstance;
  let guardSpy: MockInstance;
  let applyStateSpy: MockInstance;
  let restoreStateSpy: MockInstance;
  let events: string[];

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-transition-"));
    vi.stubEnv("HOME", homeDir);
    spies = [];
    events = [];
    delete require.cache[requireSource.resolve(INDEX_MODULE)];

    const runner = requireSource("../runner.js");
    const config = requireSource("../sandbox/config.js");
    const privilegedExec = requireSource("../sandbox/privileged-exec.js");
    const dockerExec = requireSource("../adapters/docker/exec.js");
    const stateDirLock = requireSource("./state-dir-lock.js");
    const openClawLock = requireSource("./openclaw-config-lock.js");

    dockerExecSpy = vi.spyOn(dockerExec, "dockerExecFileSync").mockImplementation((cmd) => {
      const argv = cmd as string[];
      switch (argv[0]) {
        case "stat":
          return argv.at(-1) === "/sandbox"
            ? "1775 root:sandbox"
            : argv.at(-1) === "/sandbox/.openclaw"
              ? "755 root:root"
              : "444 root:root";
        case "lsattr":
          return `---------------- ${String(argv.at(-1))}`;
        case "sha256sum":
          return `${"a".repeat(64)}  ${String(argv.at(-1))}`;
        default:
          return "";
      }
    });
    guardSpy = vi
      .spyOn(openClawLock, "runOpenClawConfigGuard")
      .mockImplementation((_exec, action) => {
        events.push(`top:${action}`);
        return { issues: [], chattrApplied: false };
      });
    applyStateSpy = vi
      .spyOn(stateDirLock, "applyStateDirLockMode")
      .mockImplementation((_exec, _dir, _owner, locking) => {
        events.push(`state:${locking ? "lock" : "unlock"}`);
        return [];
      });
    restoreStateSpy = vi
      .spyOn(stateDirLock, "restoreStateDirLockPosture")
      .mockImplementation((_exec, _dir, locked) => {
        events.push(`state:restore:${locked ? "locked" : "mutable"}`);
        return [];
      });

    spies.push(
      vi.spyOn(runner, "run").mockReturnValue({ status: 0 }),
      vi.spyOn(runner, "runCapture").mockReturnValue(""),
      vi.spyOn(config, "resolveAgentConfig").mockImplementation(() => openClawTarget()),
      vi
        .spyOn(privilegedExec, "privilegedSandboxExecArgv")
        .mockImplementation((_sandboxName: unknown, cmd: unknown) => cmd as string[]),
      dockerExecSpy,
      vi.spyOn(stateDirLock, "preflightStateDirLock").mockReturnValue([]),
      applyStateSpy,
      restoreStateSpy,
      guardSpy,
      vi.spyOn(console, "error").mockImplementation(() => undefined),
    );

    shields = requireSource(INDEX_MODULE);
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    vi.unstubAllEnvs();
    delete require.cache[requireSource.resolve(INDEX_MODULE)];
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("freezes the top-level binding before recursive lock and avoids pathname mutation", () => {
    expect(() => shields.lockAgentConfig("openclaw", openClawTarget(), false)).not.toThrow();

    expect(events.slice(0, 2)).toEqual(["top:lock", "state:lock"]);
    const commands = dockerExecSpy.mock.calls.map((call) => call[0] as string[]);
    expect(commands.some((cmd) => ["chmod", "chown", "chattr"].includes(cmd[0]))).toBe(false);
    expect(commands.some((cmd) => cmd[0] === "stat" && cmd.at(-1) === "/sandbox")).toBe(true);
  });

  it("preserves the sealed top after a partial recursive lock", () => {
    applyStateSpy.mockImplementationOnce((_exec, _dir, _owner, locking) => {
      events.push(`state:${locking ? "lock" : "unlock"}`);
      return ["recursive lock failed"];
    });

    expect(() => shields.lockAgentConfig("openclaw", openClawTarget(), false)).toThrow(
      /recursive lock failed/,
    );

    expect(events).toEqual(["top:lock", "state:lock", "top:lock"]);
    expect(restoreStateSpy).not.toHaveBeenCalled();
  });

  it("repairs doctor-tightened permissions without starting a shields transition (#6047)", () => {
    dockerExecSpy.mockImplementation((cmd) => {
      const argv = cmd as string[];
      switch (argv[0]) {
        case "/usr/bin/id":
          return "1000\n";
        case "/usr/bin/timeout":
          return "";
        default:
          throw new Error(`unexpected privileged command: ${argv.join(" ")}`);
      }
    });

    expect(shields.repairMutableConfigPerms("openclaw")).toEqual({
      applied: true,
      verified: true,
      errors: [],
    });

    const commands = dockerExecSpy.mock.calls.map((call) => call[0] as string[]);
    expect(commands).toEqual([
      ["/usr/bin/id", "-u", "sandbox"],
      ["/usr/bin/id", "-g", "sandbox"],
      [
        "/usr/bin/timeout",
        "--signal=TERM",
        "--kill-after=5s",
        "15s",
        "/usr/bin/python3",
        "-I",
        "/usr/local/lib/nemoclaw/normalize_mutable_config_perms.py",
        "/sandbox/.openclaw",
        "1000",
        "1000",
      ],
    ]);
    expect(guardSpy).not.toHaveBeenCalled();
    expect(applyStateSpy).not.toHaveBeenCalled();
  });

  it("fails closed when mutable repair cannot resolve the sandbox identity (#6047)", () => {
    dockerExecSpy.mockReturnValue("root\n");

    expect(shields.repairMutableConfigPerms("openclaw")).toEqual({
      applied: true,
      verified: false,
      errors: ["sandbox identity lookup returned an invalid UID"],
    });

    expect(dockerExecSpy).toHaveBeenCalledTimes(1);
    expect(guardSpy).not.toHaveBeenCalled();
    expect(applyStateSpy).not.toHaveBeenCalled();
  });

  it("keeps the protected top binding until recursive unlock is ready", () => {
    dockerExecSpy.mockImplementation((cmd) => {
      const argv = cmd as string[];
      switch (argv[0]) {
        case "stat":
          return argv.at(-1) === "/sandbox"
            ? "755 sandbox:sandbox"
            : argv.at(-1) === "/sandbox/.openclaw"
              ? "2770 sandbox:sandbox"
              : "660 sandbox:sandbox";
        case "lsattr":
          return `---------------- ${String(argv.at(-1))}`;
        default:
          return "";
      }
    });

    expect(() => shields.unlockAgentConfig("openclaw", openClawTarget(), true)).not.toThrow();

    expect(events.slice(0, 3)).toEqual(["top:preflight", "state:unlock", "top:unlock"]);
  });

  it("fails closed to the locked posture when recursive unlock is partial", () => {
    applyStateSpy.mockImplementationOnce((_exec, _dir, _owner, locking) => {
      events.push(`state:${locking ? "lock" : "unlock"}`);
      return ["recursive unlock failed"];
    });

    expect(() => shields.unlockAgentConfig("openclaw", openClawTarget(), true)).toThrow(
      /recursive unlock failed/,
    );
    expect(events).toEqual(["top:preflight", "state:unlock", "top:lock", "state:restore:locked"]);
  });
});
