// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const startScriptPath = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");
const startScript = fs.readFileSync(startScriptPath, "utf-8");

describe("nemoclaw-start inference auth", () => {
  it("syncs the NVIDIA API key into OpenClaw provider config", () => {
    expect(startScript).toMatch(/sync_inference_api_key\(\)/);
    expect(startScript).toMatch(/provider\['apiKey'\] = os\.environ\['NVIDIA_API_KEY'\]/);
    expect(startScript).toMatch(
      /if \[ "\$\(id -u\)" -ne 0 \]; then[\s\S]*?write_auth_profile\s+sync_inference_api_key/s,
    );
    expect(startScript).toMatch(/declare -f write_auth_profile sync_inference_api_key/);
  });
});
