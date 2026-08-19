// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enforcePrLimit,
  exceedsPrLimit,
  parsePrLimits,
  resolvePrLimit,
} from "../.github/actions/pr-limit/index.mjs";

const POLICY = ["ericksoa: unlimited", "jyaunches: 10", "cv: 1", "cjagwani: 10", "default: 5"].join(
  "\n",
);

afterEach(() => vi.unstubAllGlobals());

describe("PR limit policy", () => {
  it("uses the exact username entry before the default", () => {
    const limits = parsePrLimits(POLICY);
    expect(resolvePrLimit(limits, "CV")).toBe(1);
    expect(resolvePrLimit(limits, "another-user")).toBe(5);
    expect(resolvePrLimit(limits, "ericksoa")).toBe("unlimited");
  });

  it.each([
    ["default: -1", "Invalid PR limit"],
    ["default: 1.5", "Invalid PR limit"],
    ["default: none", "Invalid PR limit"],
    ["cv: 1", "must define default"],
    ["CV: 1\ndefault: 5", "must be lowercase"],
    ["cv: Unlimited\ndefault: 5", "must be lowercase"],
    ["bad--name: 1\ndefault: 5", "Invalid GitHub username"],
  ])("rejects invalid policy %s", (policy, message) => {
    expect(() => parsePrLimits(policy)).toThrow(message);
  });

  it("accepts one-character GitHub usernames", () => {
    expect(resolvePrLimit(parsePrLimits("a: 1\ndefault: 5"), "a")).toBe(1);
  });

  it("validates the checked-in policy and documented default", () => {
    const root = path.join(import.meta.dirname, "..");
    const limits = parsePrLimits(
      fs.readFileSync(path.join(root, ".github", "pr-limits.yaml"), "utf8"),
    );
    expect(limits.get("default")).toBe(5);
    expect(fs.readFileSync(path.join(root, "CONTRIBUTING.md"), "utf8")).toContain(
      "The default limit is 5 open PRs",
    );
  });

  it("allows zero and unlimited limits", () => {
    const limits = parsePrLimits("blocked: 0\ntrusted: unlimited\ndefault: 5");
    expect(resolvePrLimit(limits, "blocked")).toBe(0);
    expect(resolvePrLimit(limits, "trusted")).toBe("unlimited");
  });

  it("closes only above a numeric limit", () => {
    expect(exceedsPrLimit(5, 5)).toBe(false);
    expect(exceedsPrLimit(5, 6)).toBe(true);
    expect(exceedsPrLimit(0, 1)).toBe(true);
    expect(exceedsPrLimit("unlimited", 100)).toBe(false);
  });
});

describe("PR limit enforcement", () => {
  it("does not call GitHub for an unlimited author", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      enforcePrLimit({
        policyText: POLICY,
        author: "ericksoa",
        pullNumber: 9,
        repository: "NVIDIA/NemoClaw",
        token: "test",
      }),
    ).resolves.toEqual({ limit: "unlimited", openCount: null, closed: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a pull request open at the default limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => Array.from({ length: 5 }, () => ({ user: { login: "new-user" } })),
      }),
    );
    await expect(
      enforcePrLimit({
        policyText: POLICY,
        author: "new-user",
        pullNumber: 9,
        repository: "NVIDIA/NemoClaw",
        token: "test",
      }),
    ).resolves.toEqual({ limit: 5, openCount: 5, closed: false });
  });

  it("counts the author across every pull request page", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () =>
          Array.from({ length: 100 }, (_, index) => ({
            user: { login: index < 4 ? "paged-user" : "other" },
          })),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ user: { login: "paged-user" } }],
      });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      enforcePrLimit({
        policyText: POLICY,
        author: "paged-user",
        pullNumber: 9,
        repository: "NVIDIA/NemoClaw",
        token: "test",
      }),
    ).resolves.toEqual({ limit: 5, openCount: 5, closed: false });
    expect(fetchMock.mock.calls[1][0]).toContain("page=2");
  });

  it("comments on and closes a pull request above its limit", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ user: { login: "cv" } }, { user: { login: "cv" } }],
      })
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      enforcePrLimit({
        policyText: POLICY,
        author: "cv",
        pullNumber: 9,
        repository: "NVIDIA/NemoClaw",
        token: "test",
      }),
    ).rejects.toThrow("PR closed");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toContain("/issues/9/comments");
    expect(fetchMock.mock.calls[2][0]).toContain("/pulls/9");
  });
});
