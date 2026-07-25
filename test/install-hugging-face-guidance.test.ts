// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { INSTALLER_PAYLOAD, TEST_SYSTEM_PATH } from "./helpers/installer-sourced-env";

describe("installer Hugging Face guidance", () => {
  it("documents optional authentication in installer help (#7157)", () => {
    const result = spawnSync("bash", [INSTALLER_PAYLOAD, "--station-deepseek", "--help"], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toMatch(
      /--station-deepseek\s+Use DeepSeek V4 Flash for DGX Station express install/,
    );
    expect(output).toMatch(/HF_TOKEN\s+Optional Hugging Face read token/);
    expect(output).toContain("https://huggingface.co/settings/tokens");
    expect(output).toMatch(/HUGGING_FACE_HUB_TOKEN\s+Compatibility alias for HF_TOKEN/);
  });

  it("documents optional authentication in piped bootstrap help (#7157)", () => {
    const result = spawnSync("bash", ["-s", "--", "--help"], {
      input: fs.readFileSync(path.resolve(import.meta.dirname, "..", "install.sh"), "utf8"),
      encoding: "utf8",
      env: { HOME: os.tmpdir(), PATH: TEST_SYSTEM_PATH },
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toMatch(/HF_TOKEN\s+Optional Hugging Face read token/);
    expect(output).toContain("https://huggingface.co/settings/tokens");
    expect(output).toMatch(/HUGGING_FACE_HUB_TOKEN\s+Compatibility alias for HF_TOKEN/);
  });
});
