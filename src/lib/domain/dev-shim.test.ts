// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  DEV_SHIM_MARKER,
  buildDevShimContents,
  classifyDevShim,
  pathContainsDirectory,
} from "./dev-shim";

describe("dev shim domain helpers", () => {
  it("classifies absent, managed, and foreign shims", () => {
    expect(classifyDevShim(null)).toBe("absent");
    expect(classifyDevShim(`#!/usr/bin/env bash\n${DEV_SHIM_MARKER}\n`)).toBe("managed");
    expect(classifyDevShim("#!/usr/bin/env bash\necho user\n")).toBe("foreign");
  });

  it("builds a shim that preserves the Node directory and execs the source CLI", () => {
    const contents = buildDevShimContents({ binPath: "/repo/bin/nemoclaw.js", nodeDir: "/opt/node/bin" });

    expect(contents).toContain(DEV_SHIM_MARKER);
    expect(contents).toContain('export PATH="/opt/node/bin:$PATH"');
    expect(contents).toContain('exec "/repo/bin/nemoclaw.js" "$@"');
  });

  it("detects whether PATH already contains a directory", () => {
    expect(pathContainsDirectory("/bin:/home/me/.local/bin:/usr/bin", "/home/me/.local/bin")).toBe(true);
    expect(pathContainsDirectory("/bin:/usr/bin", "/home/me/.local/bin")).toBe(false);
  });
});
