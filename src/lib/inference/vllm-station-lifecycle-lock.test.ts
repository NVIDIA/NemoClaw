// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DUAL_STATION_CONTROLLER_UID_FILE,
  type DualStationControllerUidFileStat,
  readDualStationControllerUid,
  withDualStationVllmLifecycleLock,
} from "./vllm-station-lifecycle-lock";

function controllerUidStat(
  kind: "directory" | "file",
  overrides: Partial<DualStationControllerUidFileStat> = {},
): DualStationControllerUidFileStat {
  return {
    uid: 0,
    gid: 0,
    mode: kind === "directory" ? 0o40755 : 0o100644,
    size: kind === "directory" ? 0 : 5,
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
    ...overrides,
  };
}

describe("dual-Station controller UID binding", () => {
  it("reads one root-owned UID through an O_NOFOLLOW descriptor and fstat", () => {
    const close = vi.fn();
    const open = vi.fn((_pathname: string, _flags: number) => 17);
    const fstat = vi.fn(() => controllerUidStat("file"));

    expect(
      readDualStationControllerUid({
        lstat: (pathname) => {
          expect(pathname).toBe(path.dirname(DUAL_STATION_CONTROLLER_UID_FILE));
          return controllerUidStat("directory");
        },
        open,
        fstat,
        read: (fd) => {
          expect(fd).toBe(17);
          return "1001\n";
        },
        close,
      }),
    ).toBe(1001);
    expect(open).toHaveBeenCalledWith(DUAL_STATION_CONTROLLER_UID_FILE, expect.any(Number));
    const flags = open.mock.calls[0]?.[1] ?? 0;
    expect(flags & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
    expect(fstat).toHaveBeenCalledWith(17);
    expect(close).toHaveBeenCalledWith(17);
  });

  it.each([
    [
      "group-writable parent",
      controllerUidStat("directory", { mode: 0o40775 }),
      null,
      "1001\n",
      [],
    ],
    [
      "non-traversable parent",
      controllerUidStat("directory", { mode: 0o40700 }),
      null,
      "1001\n",
      [],
    ],
    ["non-root-owned file", controllerUidStat("directory"), { uid: 1001 }, "1001\n", [[19]]],
    ["wrong file mode", controllerUidStat("directory"), { mode: 0o100664 }, "1001\n", [[19]]],
    ["root UID content", controllerUidStat("directory"), null, "0\n", [[19]]],
    ["multiple UID lines", controllerUidStat("directory"), { size: 10 }, "1001\n1002\n", [[19]]],
  ])("rejects an unsafe controller binding: %s", (_case, directory, fileOverride, contents, expectedCloseCalls) => {
    const close = vi.fn();
    expect(() =>
      readDualStationControllerUid({
        lstat: () => directory,
        open: () => 19,
        fstat: () => controllerUidStat("file", fileOverride ?? {}),
        read: () => contents,
        close,
      }),
    ).toThrow(/Dual-Station controller/u);
    expect(close.mock.calls).toEqual(expectedCloseCalls);
  });

  it("refuses a direct lock call from an account other than the prepared controller", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-refused-lock-"));
    const stateDir = path.join(root, "state");
    const effectiveUid = process.getuid?.() ?? 0;
    const operation = vi.fn();

    try {
      expect(() =>
        withDualStationVllmLifecycleLock(
          operation,
          { stateDir, pollIntervalMs: 5, timeoutMs: 250, corruptLockGraceMs: 5 },
          {
            readControllerUid: () => (effectiveUid > 0 ? effectiveUid + 1 : 1),
            effectiveControllerUid: () => effectiveUid,
          },
        ),
      ).toThrow(
        /requires a non-root effective controller UID|does not match prepared controller UID/u,
      );
      expect(operation).not.toHaveBeenCalled();
      expect(fs.existsSync(stateDir)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
