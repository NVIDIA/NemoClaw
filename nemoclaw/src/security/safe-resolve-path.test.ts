// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { safeResolvePath } from "./safe-resolve-path.js";

describe("safeResolvePath", () => {
  it("uses the host resolver's value when it returns a non-empty string", () => {
    const host = { resolvePath: (p: string) => `/resolved${p}` };
    expect(safeResolvePath(host, "/a")).toBe("/resolved/a");
  });

  it("falls back to the raw path when the host resolver returns undefined", () => {
    const host = { resolvePath: () => undefined };
    expect(safeResolvePath(host, "IDENTITY.md")).toBe("IDENTITY.md");
  });

  it("falls back to the raw path when the host resolver returns an empty string", () => {
    const host = { resolvePath: () => "" };
    expect(safeResolvePath(host, "IDENTITY.md")).toBe("IDENTITY.md");
  });

  it("falls back to the raw path when the host resolver throws and logs to debug", () => {
    const debug = vi.fn();
    const host = {
      resolvePath: () => {
        throw new Error("resolver unavailable");
      },
      logger: { debug },
    };
    expect(safeResolvePath(host, "notes.md")).toBe("notes.md");
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("resolver unavailable"));
  });

  it("falls back when host has no resolver", () => {
    expect(safeResolvePath({}, "notes.md")).toBe("notes.md");
  });

  it("tolerates a host without a logger when the resolver throws", () => {
    const host = {
      resolvePath: () => {
        throw new Error("boom");
      },
    };
    expect(() => safeResolvePath(host, "notes.md")).not.toThrow();
    expect(safeResolvePath(host, "notes.md")).toBe("notes.md");
  });
});
