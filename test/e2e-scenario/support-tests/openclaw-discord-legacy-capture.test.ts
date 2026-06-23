// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

function legacyCaptureCheckerSource(): string {
  const legacyScript = fs.readFileSync(
    path.join(REPO_ROOT, "test/e2e/test-openclaw-discord-pairing.sh"),
    "utf8",
  );
  return (
    /check_fake_discord_gateway_capture\(\) \{[\s\S]*?node - "\$FAKE_DISCORD_GATEWAY_CAPTURE_FILE" "\$DISCORD_TOKEN" <<'NODE'\n(?<source>[\s\S]*?)\nNODE\n\}/.exec(
      legacyScript,
    )?.groups?.source ??
    (() => {
      throw new Error("legacy Discord capture checker not found");
    })()
  );
}

describe("legacy OpenClaw Discord pairing capture check", () => {
  it("accepts redacted identify rows without persisting the raw token", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-discord-capture-"));
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

      const result = spawnSync(process.execPath, ["-", captureFile, sentinel], {
        input: legacyCaptureCheckerSource(),
        encoding: "utf8",
      });

      expect(fs.readFileSync(captureFile, "utf8")).not.toContain(sentinel);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("OK");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
