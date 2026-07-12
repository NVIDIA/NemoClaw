// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { assertDiscordGatewayCapture } from "../live/openclaw-pairing-helpers.ts";

describe("OpenClaw Discord pairing capture check", () => {
  it("accepts redacted identify rows without persisting the raw token", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-discord-capture-"));
    try {
      const captureFile = path.join(tmp, "capture.jsonl");
      const sentinel = "test-sentinel-discord-token";
      fs.writeFileSync(
        captureFile,
        `${JSON.stringify({
          event: "identify",
          tokenMatchesExpected: true,
          tokenLooksPlaceholder: false,
        })}\n`,
      );

      assertDiscordGatewayCapture(captureFile, sentinel);

      expect(fs.readFileSync(captureFile, "utf8")).not.toContain(sentinel);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
