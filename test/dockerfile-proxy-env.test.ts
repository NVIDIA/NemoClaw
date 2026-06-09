// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DOCKERFILE = join(import.meta.dirname, "..", "Dockerfile");

describe("Dockerfile runtime proxy environment", () => {
  it("seeds container-level proxy env from NEMOCLAW_PROXY_HOST/PORT (#4304)", () => {
    const dockerfile = readFileSync(DOCKERFILE, "utf8");
    const expected = [
      "ENV HTTP_PROXY=http://${NEMOCLAW_PROXY_HOST}:${NEMOCLAW_PROXY_PORT} \\",
      "    HTTPS_PROXY=http://${NEMOCLAW_PROXY_HOST}:${NEMOCLAW_PROXY_PORT} \\",
      "    NO_PROXY=localhost,127.0.0.1,::1,${NEMOCLAW_PROXY_HOST} \\",
      "    http_proxy=http://${NEMOCLAW_PROXY_HOST}:${NEMOCLAW_PROXY_PORT} \\",
      "    https_proxy=http://${NEMOCLAW_PROXY_HOST}:${NEMOCLAW_PROXY_PORT} \\",
      "    no_proxy=localhost,127.0.0.1,::1,${NEMOCLAW_PROXY_HOST}",
    ].join("\n");

    expect(dockerfile).toContain(expected);
  });
});
