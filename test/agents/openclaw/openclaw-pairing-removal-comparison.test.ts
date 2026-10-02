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
  it("O05 changes stored CLI identity selection when the pairing patch is omitted (#11763)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pairing-comparison-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    writeFixtureDist(dist);
    try {
      const file = path.join(dist, "call-fixture.js");
      const native = fs.readFileSync(file, "utf8");
      expect(runPatch(dist).status).toBe(0);
      const managed = fs.readFileSync(file, "utf8");
      const expression = `setStoredOperatorDeviceAuthToken(true); shouldOmitDeviceIdentityForGatewayCall({ authMode: "token", opts: { clientName: "cli", mode: "cli" }, token: "fixture-token", url: "ws://127.0.0.1:18789" })`;
      expect(runFixture<boolean>(native, expression)).toBe(true);
      expect(runFixture<boolean>(managed, expression)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
