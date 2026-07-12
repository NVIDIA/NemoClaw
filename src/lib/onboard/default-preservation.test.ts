// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { restoreDefaultAfterRecreate, wasSandboxDefault } from "./default-preservation";

describe("wasSandboxDefault", () => {
  it("is true when the sandbox is the current default", () => {
    expect(wasSandboxDefault("my-sb", "my-sb")).toBe(true);
  });

  it("is false when a different sandbox is the default", () => {
    expect(wasSandboxDefault("other-sb", "my-sb")).toBe(false);
  });

  it("is false when there is no default", () => {
    expect(wasSandboxDefault(null, "my-sb")).toBe(false);
  });
});

describe("restoreDefaultAfterRecreate", () => {
  it("re-applies the default when the sandbox held it before recreate", () => {
    const setDefault = vi.fn();
    restoreDefaultAfterRecreate(setDefault, "my-sb", true);
    expect(setDefault).toHaveBeenCalledWith("my-sb");
  });

  it("does NOT touch the default when the sandbox was not default (e.g. a brand-new sandbox)", () => {
    const setDefault = vi.fn();
    restoreDefaultAfterRecreate(setDefault, "new-sb", false);
    expect(setDefault).not.toHaveBeenCalled();
  });

  it("round-trips: a recreate of the prior default restores it", () => {
    const setDefault = vi.fn();
    const wasDefault = wasSandboxDefault("my-sb", "my-sb");
    restoreDefaultAfterRecreate(setDefault, "my-sb", wasDefault);
    expect(setDefault).toHaveBeenCalledWith("my-sb");
  });

  it("round-trips: a recreate of a non-default sandbox leaves the default alone", () => {
    const setDefault = vi.fn();
    const wasDefault = wasSandboxDefault("other-sb", "my-sb");
    restoreDefaultAfterRecreate(setDefault, "my-sb", wasDefault);
    expect(setDefault).not.toHaveBeenCalled();
  });
});
