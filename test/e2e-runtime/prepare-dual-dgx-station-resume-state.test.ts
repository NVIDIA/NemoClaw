// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { DualStationResumeState } from "../../scripts/lib/dgx-station-peer.mts";
import {
  CONNECTIVITY_PROBE,
  clearDualStationResumeState,
  writeDualStationResumeState,
} from "../../scripts/prepare-dual-dgx-station.mts";
import { TEST_SYSTEM_PATH } from "../helpers/installer-sourced-env";

function readyState(): DualStationResumeState {
  return {
    schemaVersion: 1,
    revision: "a".repeat(40),
    helperSha256: "b".repeat(64),
    phase: "ready",
    peerTarget: "10.10.0.2",
    hostKeyDigest: "c".repeat(64),
    localGpuUuid: "GPU-LOCAL-0001",
    peerGpuUuid: "GPU-PEER-0002",
    rails: [
      {
        localAddress: "10.10.0.1",
        localMac: "02:00:00:00:00:01",
        peerAddress: "10.10.0.2",
        peerMac: "02:00:00:00:00:02",
      },
      {
        localAddress: "10.10.0.5",
        localMac: "02:00:00:00:00:05",
        peerAddress: "10.10.0.6",
        peerMac: "02:00:00:00:00:06",
      },
    ],
  };
}

function captureThrown(operation: () => void): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  return null;
}

it("accepts direct routes from iproute2 JSON that omits redundant filtered fields", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pair-iproute2-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { mode: 0o700 });
  fs.writeFileSync(
    path.join(bin, "ip"),
    `#!/usr/bin/env bash
case "$*" in
  "-j route get 10.10.0.2 from 10.10.0.1 oif rail0")
    printf '%s\\n' '[{"dst":"10.10.0.2","from":"10.10.0.1","dev":"rail0","flags":[]}]'
    ;;
  "-j route get 10.10.0.6 from 10.10.0.5 oif rail1")
    printf '%s\\n' '[{"dst":"10.10.0.6","from":"10.10.0.5","dev":"rail1","flags":[]}]'
    ;;
  "-j route show exact 10.10.0.0/30")
    printf '%s\\n' '[{"dst":"10.10.0.0/30","dev":"rail0","scope":"link","prefsrc":"10.10.0.1"}]'
    ;;
  "-j route show exact 10.10.0.4/30")
    printf '%s\\n' '[{"dst":"10.10.0.4/30","dev":"rail1","scope":"link","prefsrc":"10.10.0.5"}]'
    ;;
  "-j neighbor show to 10.10.0.2")
    printf '%s\\n' '[{"dst":"10.10.0.2","dev":"rail0","lladdr":"02:00:00:00:00:02","state":["STALE"]}]'
    ;;
  "-j neighbor show to 10.10.0.6")
    printf '%s\\n' '[{"dst":"10.10.0.6","dev":"rail1","lladdr":"02:00:00:00:00:06","state":["REACHABLE"]}]'
    ;;
  *)
    exit 97
    ;;
esac
`,
    { mode: 0o700 },
  );
  fs.writeFileSync(path.join(bin, "ping"), "#!/usr/bin/env bash\nexit 0\n", {
    mode: 0o700,
  });

  try {
    const result = spawnSync(
      "python3",
      ["-", "rail0", "10.10.0.1", "10.10.0.2", "rail1", "10.10.0.5", "10.10.0.6"],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${TEST_SYSTEM_PATH}` },
        input: CONNECTIVITY_PROBE,
      },
    );

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      checks: [
        expect.objectContaining({
          netdev: "rail0",
          routeDevice: "rail0",
          routeSource: "10.10.0.1",
          routeScope: "link",
          peerMac: "02:00:00:00:00:02",
          peerNeighborState: "STALE",
          jumboPing: true,
        }),
        expect.objectContaining({
          netdev: "rail1",
          routeDevice: "rail1",
          routeSource: "10.10.0.5",
          routeScope: "link",
          peerMac: "02:00:00:00:00:06",
          peerNeighborState: "REACHABLE",
          jumboPing: true,
        }),
      ],
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("preserves the primary resume-state write error when temporary cleanup also fails", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pair-state-cleanup-"));
  fs.chmodSync(directory, 0o700);
  const statePath = path.join(directory, "resume.json");
  const primaryError = new Error("primary write failure");
  const cleanupError = Object.assign(new Error("temporary unlink failure"), { code: "EACCES" });
  const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
    throw primaryError;
  });
  const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation(() => {
    throw cleanupError;
  });
  try {
    expect(captureThrown(() => writeDualStationResumeState(statePath, readyState()))).toBe(
      primaryError,
    );
    expect(unlinkSpy).toHaveBeenCalledTimes(1);
  } finally {
    writeSpy.mockRestore();
    unlinkSpy.mockRestore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("surfaces a non-ENOENT temporary cleanup error when the state write succeeded", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pair-state-cleanup-"));
  fs.chmodSync(directory, 0o700);
  const statePath = path.join(directory, "resume.json");
  const cleanupError = Object.assign(new Error("temporary unlink failure"), { code: "EACCES" });
  const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation(() => {
    throw cleanupError;
  });
  try {
    expect(captureThrown(() => writeDualStationResumeState(statePath, readyState()))).toBe(
      cleanupError,
    );
    expect(fs.existsSync(statePath)).toBe(true);
  } finally {
    unlinkSpy.mockRestore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("fsyncs the parent directory after deleting resume state", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pair-state-clear-"));
  fs.chmodSync(directory, 0o700);
  const statePath = path.join(directory, "resume.json");
  writeDualStationResumeState(statePath, readyState());
  const openSpy = vi.spyOn(fs, "openSync");
  const fsyncSpy = vi.spyOn(fs, "fsyncSync");
  const closeSpy = vi.spyOn(fs, "closeSync");
  try {
    clearDualStationResumeState(statePath);

    const directoryOpenIndex = openSpy.mock.calls.findIndex(([target]) => target === directory);
    expect(directoryOpenIndex).toBeGreaterThanOrEqual(0);
    const directoryFd = openSpy.mock.results[directoryOpenIndex]?.value;
    expect(fsyncSpy).toHaveBeenCalledWith(directoryFd);
    expect(closeSpy).toHaveBeenCalledWith(directoryFd);
    expect(fs.existsSync(statePath)).toBe(false);
  } finally {
    openSpy.mockRestore();
    fsyncSpy.mockRestore();
    closeSpy.mockRestore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("preserves the directory fsync error when closing the directory also fails", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pair-state-clear-"));
  fs.chmodSync(directory, 0o700);
  const statePath = path.join(directory, "resume.json");
  writeDualStationResumeState(statePath, readyState());
  const primaryError = new Error("directory fsync failure");
  const cleanupError = new Error("directory close failure");
  const closeSync = fs.closeSync.bind(fs);
  const fsyncSpy = vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
    throw primaryError;
  });
  const closeSpy = vi
    .spyOn(fs, "closeSync")
    .mockImplementationOnce((fd) => closeSync(fd))
    .mockImplementationOnce((fd) => {
      closeSync(fd);
      throw cleanupError;
    });
  try {
    expect(captureThrown(() => clearDualStationResumeState(statePath))).toBe(primaryError);
    expect(fs.existsSync(statePath)).toBe(false);
  } finally {
    fsyncSpy.mockRestore();
    closeSpy.mockRestore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
