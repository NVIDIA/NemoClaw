// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  openclaw?: {
    compat?: {
      pluginApi?: unknown;
      minGatewayVersion?: unknown;
    };
    build?: {
      openclawVersion?: unknown;
    };
  };
};

describe("OpenClaw package metadata", () => {
  it("declares the required external plugin compatibility fields", () => {
    expect(packageJson.openclaw?.compat?.pluginApi).toBe(">=2026.5.10-beta.1");
    expect(packageJson.openclaw?.compat?.minGatewayVersion).toBe("2026.5.10-beta.1");
    expect(packageJson.openclaw?.build?.openclawVersion).toBe("2026.5.10-beta.1");
  });
});
