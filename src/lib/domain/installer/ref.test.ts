// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { resolveInstallerVersion, resolveInstallRef } from "./ref";

describe("installer ref helpers", () => {
  it("resolves install refs with the same priority as install.sh", () => {
    expect(resolveInstallRef({ NEMOCLAW_INSTALL_REF: "feature", NEMOCLAW_INSTALL_TAG: "v1" })).toBe(
      "feature",
    );
    expect(resolveInstallRef({ NEMOCLAW_INSTALL_TAG: "v1" })).toBe("v1");
    expect(resolveInstallRef({})).toBe("latest");
  });

  it("derives installer versions from refs and fallback sources", () => {
    expect(
      resolveInstallerVersion({
        defaultVersion: "0.1.0",
        env: { NEMOCLAW_INSTALL_REF: "v1.2.3" },
        gitDescribeVersion: "v2.0.0",
      }),
    ).toBe("1.2.3");
    expect(
      resolveInstallerVersion({
        defaultVersion: "0.1.0",
        env: { NEMOCLAW_INSTALL_TAG: "latest" },
        gitDescribeVersion: "v2.0.0-4-gabc",
        packageJsonVersion: "3.0.0",
        stampedVersion: "2.0.0",
      }),
    ).toBe("2.0.0-4-gabc");
    expect(
      resolveInstallerVersion({
        defaultVersion: "0.1.0",
        stampedVersion: "2.0.0",
      }),
    ).toBe("2.0.0");
    expect(resolveInstallerVersion({ defaultVersion: "0.1.0" })).toBe("0.1.0");
  });
});
