// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  buildSandboxCommandStdio,
  shouldInheritSandboxCommandStdin,
} from "./sandbox-command-stdio";

describe("buildSandboxCommandStdio", () => {
  it("inherits terminal stdin by default", () => {
    expect(buildSandboxCommandStdio({}, true)).toBe("inherit");
  });

  it("closes non-terminal or unknown stdin by default", () => {
    expect(buildSandboxCommandStdio({}, false)).toEqual(["ignore", "inherit", "inherit"]);
    expect(buildSandboxCommandStdio({}, undefined)).toEqual(["ignore", "inherit", "inherit"]);
  });

  it("honors explicit flags over terminal detection", () => {
    expect(buildSandboxCommandStdio({ stdin: true }, false)).toBe("inherit");
    expect(buildSandboxCommandStdio({ stdin: true }, undefined)).toBe("inherit");
    expect(buildSandboxCommandStdio({ stdin: false }, true)).toEqual([
      "ignore",
      "inherit",
      "inherit",
    ]);
  });
});

describe("shouldInheritSandboxCommandStdin", () => {
  it("lets explicit --stdin and --no-stdin win", () => {
    expect(shouldInheritSandboxCommandStdin(true, false)).toBe(true);
    expect(shouldInheritSandboxCommandStdin(false, true)).toBe(false);
  });

  it("inherits only a positively identified TTY when no flag is present", () => {
    expect(shouldInheritSandboxCommandStdin(undefined, true)).toBe(true);
    expect(shouldInheritSandboxCommandStdin(undefined, false)).toBe(false);
    expect(shouldInheritSandboxCommandStdin(undefined, undefined)).toBe(false);
  });
});
