// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  findHostUnmanagedCloudflaredPids,
  findUnmanagedCloudflaredPids,
  startAll,
} from "./services";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("findUnmanagedCloudflaredPids", () => {
  it("finds only executable cloudflared processes not recorded by NemoClaw", () => {
    const pids = findUnmanagedCloudflaredPids([200, 500], () =>
      [
        "  100 cloudflared cloudflared tunnel --url http://localhost:18789",
        "  200 /usr/local/bin/cloudflared /usr/local/bin/cloudflared tunnel run",
        "  300 bash bash /tmp/cloudflared tunnel run",
        "  400 node node test-cloudflared.js",
        "  500 cloudflared.exe cloudflared.exe tunnel run",
      ].join("\n"),
    );

    expect(pids).toEqual([100]);
  });

  it("reports no unmanaged process when optional inspection is unavailable", () => {
    expect(
      findUnmanagedCloudflaredPids(null, () => {
        throw new Error("ps unavailable");
      }),
    ).toEqual([]);
  });

  it("fails closed when required process inspection is unavailable", () => {
    expect(() =>
      findUnmanagedCloudflaredPids(
        null,
        () => {
          throw new Error("ps unavailable");
        },
        true,
      ),
    ).toThrow(
      "Cannot inspect current-user cloudflared processes; refusing to continue tunnel operation.",
    );
  });

  it("fails closed when NemoClaw PID ownership is unreadable", () => {
    const home = mkdtempSync(join(tmpdir(), "nemoclaw-owned-pid-discovery-"));
    const gatewaysDir = join(home, ".nemoclaw", "gateways");
    mkdirSync(gatewaysDir, { recursive: true });
    writeFileSync(join(gatewaysDir, "19080"), "not a directory");
    vi.stubEnv("HOME", home);

    try {
      expect(() =>
        findHostUnmanagedCloudflaredPids(null, () => "  4242 cloudflared cloudflared tunnel run"),
      ).toThrow(
        "Cannot inspect NemoClaw cloudflared ownership; refusing to continue tunnel operation.",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses to start a tunnel when unmanaged-process inspection fails", async () => {
    const pidDir = mkdtempSync(join(tmpdir(), "nemoclaw-unmanaged-inspection-"));
    vi.stubEnv("PATH", "");
    vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await expect(
        startAll({
          pidDir,
          unmanagedCloudflaredPids: (_managedPid, failOnInspectionError) => {
            expect(failOnInspectionError).toBe(true);
            throw new Error("process inspection unavailable");
          },
        }),
      ).rejects.toThrow("process inspection unavailable");
      expect(existsSync(join(pidDir, "cloudflared.pid"))).toBe(false);
    } finally {
      rmSync(pidDir, { recursive: true, force: true });
    }
  });
});
