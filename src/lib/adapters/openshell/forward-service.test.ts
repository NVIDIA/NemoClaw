// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildForwardServiceArgs,
  ForwardServiceStartupCleanupError,
  isForwardServiceListenerOwner,
  isTrustedTaskkillExecutable,
  launchForwardService,
  terminateForwardServiceProcessTree,
  type ForwardServiceTarget,
} from "./forward-service";
import { probeLocalForwardListener } from "./local-forward-listener";

const target: ForwardServiceTarget = {
  executable: "/usr/local/bin/openshell",
  gatewayName: "nemoclaw",
  workspace: "default",
  sandboxName: "demo",
  localHost: "127.0.0.1",
  localPort: 18_789,
  targetHost: "127.0.0.1",
  targetPort: 18_789,
};

const ownerTarget: ForwardServiceTarget = { ...target, executable: process.execPath };
const detachedChildPid = process.pid + 1;
const temporaryDirectories: string[] = [];
const startedProcessGroups: number[] = [];
const processSleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function createLinuxOwnerFixture(actualExecutable?: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-forward-owner-"));
  temporaryDirectories.push(root);
  const procRoot = path.join(root, "proc");
  const binRoot = path.join(root, "bin");
  mkdirSync(path.join(procRoot, "net"), { recursive: true });
  mkdirSync(path.join(procRoot, "4321", "fd"), { recursive: true });
  mkdirSync(path.join(procRoot, "9876", "fd"), { recursive: true });
  mkdirSync(binRoot);
  const executable = path.join(binRoot, "openshell");
  const runtime = actualExecutable ? path.join(binRoot, actualExecutable) : executable;
  writeFileSync(executable, "");
  writeFileSync(runtime, "");
  writeFileSync(
    path.join(procRoot, "net", "tcp"),
    "  0: 0100007F:4965 00000000:0000 0A 00000000:00000000 00:00000000 00000000  998 0 12345 1\n",
  );
  writeFileSync(
    path.join(procRoot, "net", "tcp6"),
    "  1: 00000000000000000000000001000000:4965 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  998 0 67890 1\n",
  );
  symlinkSync("socket:[12345]", path.join(procRoot, "4321", "fd", "7"));
  symlinkSync("socket:[67890]", path.join(procRoot, "9876", "fd", "8"));
  symlinkSync(runtime, path.join(procRoot, "4321", "exe"));
  return { procRoot, target: { ...target, executable } };
}

function darwinOwnerProbe(commandLine: string, finalListener = "4321\n") {
  return vi
    .fn()
    .mockReturnValueOnce({ status: 0, stdout: "4321\n" })
    .mockReturnValueOnce({ status: 0, stdout: `p4321\nftxt\nn${process.execPath}\n` })
    .mockReturnValueOnce({ status: 0, stdout: commandLine })
    .mockReturnValueOnce({ status: 0, stdout: finalListener });
}

afterEach(() => {
  for (const processGroup of startedProcessGroups.splice(0)) {
    try {
      process.kill(-processGroup, "SIGKILL");
    } catch {
      // Best effort only — the owned process group may already be gone.
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 200 && isRunning(pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isRunning(pid);
}

async function availableLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

describe("OpenShell forward service", () => {
  it("builds the direct ForwardTcp command with explicit gateway authority", () => {
    expect(buildForwardServiceArgs(target)).toEqual([
      "--gateway",
      "nemoclaw",
      "--workspace",
      "default",
      "forward",
      "service",
      "demo",
      "--target-port",
      "18789",
      "--target-host",
      "127.0.0.1",
      "--local",
      "127.0.0.1:18789",
    ]);
  });

  it("builds the direct ForwardTcp command for a selected non-default workspace", () => {
    expect(buildForwardServiceArgs({ ...target, workspace: "review-workspace" })).toContain(
      "review-workspace",
    );
  });

  it("proves the exact direct ForwardTcp listener before reuse", () => {
    const expected = [ownerTarget.executable, ...buildForwardServiceArgs(ownerTarget)].join(" ");
    const probe = darwinOwnerProbe(`${expected}\n`);

    expect(isForwardServiceListenerOwner(ownerTarget, { platform: "darwin", probe })).toBe(true);
    expect(probe).toHaveBeenCalledTimes(4);
  });

  it("rejects a listener whose process does not match the direct ForwardTcp target", () => {
    const probe = darwinOwnerProbe("/usr/bin/node foreign-listener.js\n");

    expect(isForwardServiceListenerOwner(ownerTarget, { platform: "darwin", probe })).toBe(false);
  });

  it("rejects ambiguous or changing listener ownership", () => {
    const expected = [ownerTarget.executable, ...buildForwardServiceArgs(ownerTarget)].join(" ");
    const probe = darwinOwnerProbe(`${expected}\n`, "9876\n");

    expect(isForwardServiceListenerOwner(ownerTarget, { platform: "darwin", probe })).toBe(false);
  });

  it("rejects ownership when a host probe times out", () => {
    const lsofTimeout = vi.fn(() => ({ status: null, stdout: "" }));
    expect(
      isForwardServiceListenerOwner(ownerTarget, { platform: "darwin", probe: lsofTimeout }),
    ).toBe(false);

    const psTimeout = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: "4321\n" })
      .mockReturnValueOnce({ status: 0, stdout: `p4321\nftxt\nn${process.execPath}\n` })
      .mockReturnValueOnce({ status: null, stdout: "" });
    expect(
      isForwardServiceListenerOwner(ownerTarget, { platform: "darwin", probe: psTimeout }),
    ).toBe(false);
  });

  it("proves Linux IPv4 ownership while ignoring an IPv6-only listener", () => {
    const fixture = createLinuxOwnerFixture();
    const expected = [fixture.target.executable, ...buildForwardServiceArgs(fixture.target)].join(
      " ",
    );
    const responses = {
      lsof: { status: null, stdout: "" },
      ps: { status: 0, stdout: `${expected}\n` },
    };
    const probe = vi.fn(
      (executable: string) => responses[executable as keyof typeof responses] ?? responses.lsof,
    );

    expect(
      isForwardServiceListenerOwner(fixture.target, {
        platform: "linux",
        probe,
        procRoot: fixture.procRoot,
      }),
    ).toBe(true);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(probe).toHaveBeenCalledWith("lsof", ["-ti4TCP:18789", "-sTCP:LISTEN"]);
    expect(probe).toHaveBeenCalledWith("ps", ["-ww", "-p", "4321", "-o", "args="]);
  });

  it("rejects spoofed arguments when the Linux executable is different", () => {
    const fixture = createLinuxOwnerFixture("python3");
    const expected = [fixture.target.executable, ...buildForwardServiceArgs(fixture.target)].join(
      " ",
    );
    const responses = {
      lsof: { status: null, stdout: "" },
      ps: { status: 0, stdout: `${expected}\n` },
    };
    const probe = vi.fn(
      (executable: string) => responses[executable as keyof typeof responses] ?? responses.lsof,
    );

    expect(
      isForwardServiceListenerOwner(fixture.target, {
        platform: "linux",
        probe,
        procRoot: fixture.procRoot,
      }),
    ).toBe(false);
    expect(probe).toHaveBeenCalledOnce();
  });

  it("denies Linux ownership when the /proc work limit is reached", () => {
    const fixture = createLinuxOwnerFixture();
    const probe = vi.fn(() => ({ status: null, stdout: "" }));

    expect(
      isForwardServiceListenerOwner(fixture.target, {
        platform: "linux",
        probe,
        procRoot: fixture.procRoot,
        procWorkLimit: 1,
      }),
    ).toBe(false);
    expect(probe).toHaveBeenCalledOnce();
  });

  it("detaches the OpenShell child and waits for its local port", () => {
    const unref = vi.fn();
    const spawnDetached = vi.fn(() => ({ unref }));
    const terminateProcessTree = vi.fn();
    let probes = 0;

    launchForwardService(target, {
      isReachable: () => ++probes >= 3,
      sleep: () => {},
      spawnDetached,
      terminateProcessTree,
      timeoutMs: 1_000,
    });

    expect(spawnDetached).toHaveBeenCalledWith(
      target.executable,
      buildForwardServiceArgs(target),
      expect.any(Object),
    );
    expect(unref).toHaveBeenCalledOnce();
    expect(terminateProcessTree).not.toHaveBeenCalled();
  });

  it("uses the selected OpenShell configuration without exposing credentials (#11084)", () => {
    const spawnDetached = vi.fn(() => ({ unref: vi.fn() }));

    launchForwardService(target, {
      isReachable: vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true),
      sleep: () => {},
      sourceEnvironment: {
        HOME: "/tmp/isolated-home",
        NVIDIA_INFERENCE_API_KEY: "secret-value",
        PATH: "/usr/bin",
        XDG_CONFIG_HOME: "/tmp/selected-openshell-config",
      },
      spawnDetached,
    });

    expect(spawnDetached).toHaveBeenCalledWith(target.executable, buildForwardServiceArgs(target), {
      HOME: "/tmp/isolated-home",
      PATH: "/usr/bin",
      XDG_CONFIG_HOME: "/tmp/selected-openshell-config",
    });
  });

  it("refuses an occupied port without launching or adopting its listener", () => {
    const spawnDetached = vi.fn();

    expect(() => launchForwardService(target, { isReachable: () => true, spawnDetached })).toThrow(
      /already occupied/u,
    );
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it("terminates a detached service that does not bind before the deadline", () => {
    const child = { pid: detachedChildPid, unref: vi.fn() };
    const terminateProcessTree = vi.fn();

    expect(() =>
      launchForwardService(target, {
        isReachable: () => false,
        sleep: () => {},
        spawnDetached: () => child,
        terminateProcessTree,
        timeoutMs: 0,
      }),
    ).toThrow(/did not bind/u);
    expect(terminateProcessTree).toHaveBeenCalledWith(child);
    expect(child.unref).not.toHaveBeenCalled();
  });

  it("fails closed when timeout cleanup cannot be proved", () => {
    const cleanupError = new Error("tree remained live");

    expect(() =>
      launchForwardService(target, {
        isReachable: () => false,
        spawnDetached: () => ({ pid: detachedChildPid, unref: vi.fn() }),
        terminateProcessTree: () => {
          throw cleanupError;
        },
        timeoutMs: 0,
      }),
    ).toThrow(
      expect.objectContaining({
        errors: [
          expect.objectContaining({ message: expect.stringMatching(/did not bind/u) }),
          cleanupError,
        ],
        name: ForwardServiceStartupCleanupError.name,
      }),
    );
  });

  it("targets the exact detached process group on POSIX", () => {
    const signalProcess = vi.fn();

    terminateForwardServiceProcessTree(
      { pid: detachedChildPid, unref: vi.fn() },
      {
        platform: "linux",
        processGroupHasRunnableMember: () => false,
        signalProcess,
      },
    );

    expect(signalProcess).toHaveBeenCalledWith(-detachedChildPid, "SIGKILL");
  });

  it("fails closed when POSIX process-group settlement is not proved", () => {
    const signalProcess = vi.fn();
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(5_000);

    expect(() =>
      launchForwardService(target, {
        isReachable: () => false,
        spawnDetached: () => ({ pid: detachedChildPid, unref: vi.fn() }),
        terminateProcessTree: (child) =>
          terminateForwardServiceProcessTree(child, {
            now,
            platform: "linux",
            processGroupHasRunnableMember: () => true,
            signalProcess,
            sleep: () => {},
          }),
        timeoutMs: 0,
      }),
    ).toThrow(expect.objectContaining({ name: ForwardServiceStartupCleanupError.name }));
    expect(signalProcess).toHaveBeenCalledWith(-detachedChildPid, "SIGKILL");
  });

  it("resolves Windows taskkill from SystemRoot while PATH is poisoned", () => {
    const signalProcess = vi.fn();
    const taskkill = vi.fn(() => ({ status: 0 }));
    const trustedTaskkill = "C:\\Windows\\System32\\taskkill.exe";

    terminateForwardServiceProcessTree(
      { pid: detachedChildPid, unref: vi.fn() },
      {
        environment: {
          PATH: "C:\\attacker-controlled",
          SystemRoot: "C:\\Windows",
        },
        isTrustedTaskkillExecutable: (executable) => executable === trustedTaskkill,
        platform: "win32",
        signalProcess,
        taskkill,
      },
    );

    expect(taskkill).toHaveBeenCalledWith(trustedTaskkill, [
      "/PID",
      String(detachedChildPid),
      "/T",
      "/F",
    ]);
    expect(signalProcess).not.toHaveBeenCalled();
  });

  it("qualifies the real taskkill file and rejects a symlink with the default verifier", () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "nemoclaw-taskkill-trust-")));
    temporaryDirectories.push(root);
    const executable = path.join(root, "taskkill.exe");
    const symlink = path.join(root, "taskkill-link.exe");
    writeFileSync(executable, "fixture");
    symlinkSync(executable, symlink);

    expect(isTrustedTaskkillExecutable(executable)).toBe(true);
    expect(isTrustedTaskkillExecutable(symlink)).toBe(false);
    expect(isTrustedTaskkillExecutable(path.join(root, "missing.exe"))).toBe(false);
  });

  it("fails closed when the trusted Windows taskkill executable is unavailable", () => {
    const taskkill = vi.fn(() => ({ status: 0 }));

    expect(() =>
      terminateForwardServiceProcessTree(
        { pid: detachedChildPid, unref: vi.fn() },
        {
          environment: {
            PATH: "C:\\attacker-controlled",
            SystemRoot: "C:\\Windows",
          },
          isTrustedTaskkillExecutable: () => false,
          platform: "win32",
          taskkill,
        },
      ),
    ).toThrow(/Trusted Windows taskkill executable is unavailable/u);
    expect(taskkill).not.toHaveBeenCalled();
  });

  it.each([undefined, "Windows", "\\\\attacker\\share", "C:\\Windows\\..\\poison"])(
    "fails closed for an invalid Windows SystemRoot: %s",
    (systemRoot) => {
      const taskkill = vi.fn(() => ({ status: 0 }));

      expect(() =>
        terminateForwardServiceProcessTree(
          { pid: detachedChildPid, unref: vi.fn() },
          {
            environment: {
              PATH: "C:\\attacker-controlled",
              SystemRoot: systemRoot,
            },
            isTrustedTaskkillExecutable: () => true,
            platform: "win32",
            taskkill,
          },
        ),
      ).toThrow(/Trusted Windows SystemRoot is unavailable/u);
      expect(taskkill).not.toHaveBeenCalled();
    },
  );

  it("fails closed when Windows process-tree termination is not proved", () => {
    const noSuchProcess = Object.assign(new Error("not found"), { code: "ESRCH" });

    expect(() =>
      terminateForwardServiceProcessTree(
        { pid: detachedChildPid, unref: vi.fn() },
        {
          environment: { SystemRoot: "C:\\Windows" },
          isTrustedTaskkillExecutable: () => true,
          platform: "win32",
          signalProcess: () => {
            throw noSuchProcess;
          },
          taskkill: () => ({ status: 1 }),
        },
      ),
    ).toThrow(/process-tree termination failed/u);
  });

  it.skipIf(process.platform === "win32")(
    "kills a delayed listener and its detached process group before reporting timeout",
    async () => {
      const port = await availableLoopbackPort();
      const root = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-forward-timeout-"));
      temporaryDirectories.push(root);
      const markerPath = path.join(root, "pids.json");
      const releasePath = path.join(root, "release");
      const bindDelayMs = 2_500;
      const descendantScript = `
const fs = require("node:fs");
const net = require("node:net");
const server = net.createServer(() => {});
const releasePoll = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(releasePath)})) return;
  clearInterval(releasePoll);
  setTimeout(() => server.listen(${String(port)}, "127.0.0.1"), ${String(bindDelayMs)});
}, 10);
setInterval(() => {}, 1000);
`;
      const leaderScript = `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], {
  stdio: "ignore",
});
fs.writeFileSync(
  ${JSON.stringify(markerPath)},
  JSON.stringify({ leader: process.pid, descendant: descendant.pid }),
);
setInterval(() => {}, 1000);
`;
      let spawned: ChildProcess | undefined;
      let spawnedClose: Promise<unknown[]> | undefined;
      const unref = vi.fn();
      const runtimeTarget = {
        ...target,
        executable: process.execPath,
        localPort: port,
        targetPort: port,
      };

      let launchError: unknown;
      try {
        launchForwardService(runtimeTarget, {
          sleep: (milliseconds) => {
            writeFileSync(releasePath, "ready");
            Atomics.wait(processSleepBuffer, 0, 0, milliseconds);
          },
          spawnDetached: () => {
            spawned = spawn(process.execPath, ["-e", leaderScript], {
              detached: true,
              stdio: "ignore",
            });
            expect(spawned.pid).toBeTypeOf("number");
            const processGroup = spawned.pid!;
            startedProcessGroups.push(processGroup);
            spawnedClose = once(spawned, "close");
            const markerDeadline = Date.now() + 5_000;
            while (!existsSync(markerPath) && Date.now() < markerDeadline) {
              Atomics.wait(processSleepBuffer, 0, 0, 25);
            }
            expect(existsSync(markerPath)).toBe(true);
            return { pid: processGroup, unref };
          },
          timeoutMs: 1_000,
        });
      } catch (error) {
        launchError = error;
      }

      expect(launchError).toEqual(expect.objectContaining({ message: expect.stringMatching(/did not bind/u) }));
      expect(existsSync(markerPath)).toBe(true);
      expect(existsSync(releasePath)).toBe(true);
      const pids = JSON.parse(readFileSync(markerPath, "utf8")) as {
        descendant: number;
        leader: number;
      };
      await spawnedClose;
      expect(spawned?.signalCode).toBe("SIGKILL");
      expect(await waitForExit(pids.leader)).toBe(true);
      expect(await waitForExit(pids.descendant)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, bindDelayMs));
      expect(probeLocalForwardListener(port, 100)).toBe(false);
      expect(unref).not.toHaveBeenCalled();
    },
    15_000,
  );
});
