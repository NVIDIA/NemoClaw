// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveOpenshell } from "../../dist/lib/resolve-openshell";

describe("lib/resolve-openshell", () => {
  it("returns command -v result when absolute path", () => {
    expect(resolveOpenshell({ commandVResult: "/usr/bin/openshell" })).toBe("/usr/bin/openshell");
  });

  it("prefers explicit installer override over command -v", () => {
    const previous = process.env.NEMOCLAW_OPENSHELL_BIN;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-bin-"));
    const override = path.join(tmp, "openshell");
    fs.writeFileSync(override, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

    try {
      process.env.NEMOCLAW_OPENSHELL_BIN = override;
      expect(resolveOpenshell({ commandVResult: "/opt/homebrew/bin/openshell" })).toBe(override);
    } finally {
      if (previous === undefined) {
        delete process.env.NEMOCLAW_OPENSHELL_BIN;
      } else {
        process.env.NEMOCLAW_OPENSHELL_BIN = previous;
      }
    }
  });

  it("rejects non-absolute command -v result (alias)", () => {
    expect(
      resolveOpenshell({ commandVResult: "openshell", checkExecutable: () => false }),
    ).toBeNull();
  });

  it("rejects alias definition from command -v", () => {
    expect(
      resolveOpenshell({
        commandVResult: "alias openshell='echo pwned'",
        checkExecutable: () => false,
      }),
    ).toBeNull();
  });

  it("falls back to ~/.local/bin when command -v fails", () => {
    expect(
      resolveOpenshell({
        commandVResult: null,
        checkExecutable: (p) => p === "/fakehome/.local/bin/openshell",
        home: "/fakehome",
      }),
    ).toBe("/fakehome/.local/bin/openshell");
  });

  it("falls back to /usr/local/bin", () => {
    expect(
      resolveOpenshell({
        commandVResult: null,
        checkExecutable: (p) => p === "/usr/local/bin/openshell",
      }),
    ).toBe("/usr/local/bin/openshell");
  });

  it("falls back to /usr/bin", () => {
    expect(
      resolveOpenshell({
        commandVResult: null,
        checkExecutable: (p) => p === "/usr/bin/openshell",
      }),
    ).toBe("/usr/bin/openshell");
  });

  it("prefers ~/.local/bin over /usr/local/bin", () => {
    expect(
      resolveOpenshell({
        commandVResult: null,
        checkExecutable: (p) =>
          p === "/fakehome/.local/bin/openshell" || p === "/usr/local/bin/openshell",
        home: "/fakehome",
      }),
    ).toBe("/fakehome/.local/bin/openshell");
  });

  it("returns null when openshell not found anywhere", () => {
    expect(
      resolveOpenshell({
        commandVResult: null,
        checkExecutable: () => false,
      }),
    ).toBeNull();
  });

  it("skips home candidate when home is not absolute", () => {
    expect(
      resolveOpenshell({
        commandVResult: null,
        checkExecutable: () => false,
        home: "relative/path",
      }),
    ).toBeNull();
  });
});
