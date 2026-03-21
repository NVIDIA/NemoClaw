// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const startScriptPath = path.join(__dirname, "..", "scripts", "nemoclaw-start.sh");
const startScript = fs.readFileSync(startScriptPath, "utf-8");

describe("nemoclaw-start inference auth", () => {
  it("syncs the NVIDIA API key into OpenClaw provider config", () => {
    assert.match(startScript, /sync_inference_api_key\(\)/);
    assert.match(startScript, /provider\['apiKey'\] = os\.environ\['NVIDIA_API_KEY'\]/);
    assert.match(
      startScript,
      /if \[ "\$\(id -u\)" -ne 0 \]; then[\s\S]*?write_auth_profile\s+sync_inference_api_key/s,
    );
    assert.match(
      startScript,
      /declare -f write_auth_profile sync_inference_api_key/,
    );
  });
});
