// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildForwardServiceArgs,
  isForwardServiceListenerOwner,
  launchForwardService,
  type ForwardServiceTarget,
} from "./forward-service";

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
const temporaryDirectories: string[] = [];

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
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

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
    let probes = 0;

    launchForwardService(target, {
      isReachable: () => ++probes >= 3,
      sleep: () => {},
      spawnDetached,
      timeoutMs: 1_000,
    });

    expect(spawnDetached).toHaveBeenCalledWith(
      target.executable,
      buildForwardServiceArgs(target),
      expect.any(Object),
    );
    expect(unref).toHaveBeenCalledOnce();
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

  it("fails when the detached service does not bind before the deadline", () => {
    expect(() =>
      launchForwardService(target, {
        isReachable: () => false,
        sleep: () => {},
        spawnDetached: () => ({ unref: () => {} }),
        timeoutMs: 0,
      }),
    ).toThrow(/did not bind/u);
  });
});
