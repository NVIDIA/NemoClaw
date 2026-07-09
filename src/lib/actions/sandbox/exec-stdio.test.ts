// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { buildSandboxExecStdio, shouldInheritSandboxExecStdin } from "./exec-stdio";

describe("buildSandboxExecStdio", () => {
  it("inherits terminal stdin by default", () => {
    expect(buildSandboxExecStdio({}, true)).toBe("inherit");
  });

  it("closes non-terminal or unknown stdin by default", () => {
    expect(buildSandboxExecStdio({}, false)).toEqual(["ignore", "inherit", "inherit"]);
    expect(buildSandboxExecStdio({}, undefined)).toEqual(["ignore", "inherit", "inherit"]);
  });

  it("honors explicit flags over terminal detection", () => {
    expect(buildSandboxExecStdio({ stdin: true }, false)).toBe("inherit");
    expect(buildSandboxExecStdio({ stdin: true }, undefined)).toBe("inherit");
    expect(buildSandboxExecStdio({ stdin: false }, true)).toEqual(["ignore", "inherit", "inherit"]);
  });
});

describe("shouldInheritSandboxExecStdin", () => {
  it("lets explicit --stdin and --no-stdin win", () => {
    expect(shouldInheritSandboxExecStdin(true, false)).toBe(true);
    expect(shouldInheritSandboxExecStdin(false, true)).toBe(false);
  });

  it("inherits only a positively identified TTY when no flag is present", () => {
    expect(shouldInheritSandboxExecStdin(undefined, true)).toBe(true);
    expect(shouldInheritSandboxExecStdin(undefined, false)).toBe(false);
    expect(shouldInheritSandboxExecStdin(undefined, undefined)).toBe(false);
  });
});
