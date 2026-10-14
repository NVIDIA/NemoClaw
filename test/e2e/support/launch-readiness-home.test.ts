// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { launchReadinessReceiptPath } from "../../../src/lib/state/launch-readiness-lease.ts";
import { withGroupWritableReadinessHome } from "../fixtures/launch-readiness-home.ts";

afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "restores home permissions and umask after launch (failure=%s)",
  async (fails) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-home-"));
    fs.chmodSync(home, 0o750);
    const user = os.userInfo();
    vi.spyOn(os, "userInfo").mockReturnValue({ ...user, homedir: home });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const receipt = launchReadinessReceiptPath("test-home", 18080, home);
    fs.mkdirSync(path.dirname(receipt), { recursive: true, mode: 0o700 });
    fs.writeFileSync(receipt, "old receipt", { mode: 0o600 });
    const retained = path.join(path.dirname(receipt), "unrelated.json");
    fs.writeFileSync(retained, "retained", { mode: 0o600 });
    const umask = process.umask();
    const failure = new Error("launch failed");
    try {
      const outcome = await withGroupWritableReadinessHome(
        {
          enabled: true,
          sandboxName: "test-home",
          gatewayName: "nemoclaw-18080",
          gatewayPort: 18080,
        },
        async () => {
          expect(fs.statSync(home).mode & 0o777).toBe(0o775);
          expect(process.umask()).toBe(0o002);
          expect(fs.existsSync(receipt)).toBe(false);
          return fails ? Promise.reject(failure) : Promise.resolve();
        },
      ).catch((error: unknown) => error);
      expect(outcome).toBe(fails ? failure : undefined);
      expect(fs.statSync(home).mode & 0o777).toBe(0o750);
      expect(process.umask()).toBe(umask);
      expect(fs.readFileSync(retained, "utf8")).toBe("retained");
    } finally {
      process.umask(umask);
      fs.rmSync(home, { recursive: true, force: true });
    }
  },
);

it("leaves local and preinstalled host permissions alone", async () => {
  const userInfo = vi.spyOn(os, "userInfo");
  const launch = vi.fn(async () => undefined);
  await withGroupWritableReadinessHome(
    { enabled: false, sandboxName: "test-home", gatewayName: "nemoclaw", gatewayPort: 8080 },
    launch,
  );
  expect(userInfo).not.toHaveBeenCalled();
  expect(launch).toHaveBeenCalledOnce();
});
