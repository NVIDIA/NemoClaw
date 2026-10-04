// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  runFixture,
  runPatch,
  writeFixtureDist,
} from "../../helpers/openclaw-device-self-approval-patch-harness.ts";

describe("OpenClaw pairing removal comparison", () => {
  it("O05 sends the stored CLI identity only with the pairing patch (#11763)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pairing-comparison-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    writeFixtureDist(dist);
    try {
      const file = path.join(dist, "call-fixture.js");
      const native = fs.readFileSync(file, "utf8");
      expect(runPatch(dist).status).toBe(0);
      const managed = fs.readFileSync(file, "utf8");
      const expression = `setStoredOperatorDeviceAuthToken(true); gatewayClientOptions({ clientName: "cli", mode: "cli", token: "fixture-token", url: "ws://127.0.0.1:18789" })`;
      type Options = { deviceIdentity: { deviceId: string } | null; url: string };
      const nativeOptions = await runFixture<Promise<Options>>(native, expression);
      const managedOptions = await runFixture<Promise<Options>>(managed, expression);
      expect(nativeOptions).toMatchObject({ deviceIdentity: null, url: "ws://127.0.0.1:18789" });
      expect(managedOptions).toMatchObject({
        deviceIdentity: { deviceId: "device-1" },
        url: "ws://127.0.0.1:18789",
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
