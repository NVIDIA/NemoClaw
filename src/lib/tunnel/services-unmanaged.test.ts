// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { findHostUnmanagedCloudflaredPids, findUnmanagedCloudflaredPids } from "./services";

afterEach(() => {
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

  it("returns no unmanaged processes when the process list is unavailable", () => {
    expect(
      findUnmanagedCloudflaredPids(null, () => {
        throw new Error("ps unavailable");
      }),
    ).toEqual([]);
  });

  it("skips process discovery when NemoClaw PID ownership is unreadable", () => {
    const home = mkdtempSync(join(tmpdir(), "nemoclaw-owned-pid-discovery-"));
    const gatewaysDir = join(home, ".nemoclaw", "gateways");
    mkdirSync(gatewaysDir, { recursive: true });
    writeFileSync(join(gatewaysDir, "19080"), "not a directory");
    vi.stubEnv("HOME", home);

    try {
      expect(
        findHostUnmanagedCloudflaredPids(null, () => "  4242 cloudflared cloudflared tunnel run"),
      ).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
