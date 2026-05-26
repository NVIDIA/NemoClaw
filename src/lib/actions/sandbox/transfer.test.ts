// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildOpenshellDownloadArgs,
  buildOpenshellUploadArgs,
} from "../../../../dist/lib/actions/sandbox/transfer";

describe("buildOpenshellDownloadArgs", () => {
  it("builds the basic two-arg form with no destination", () => {
    expect(buildOpenshellDownloadArgs("alpha", "/sandbox/.openclaw/workspace/USER.md")).toEqual([
      "sandbox",
      "download",
      "alpha",
      "/sandbox/.openclaw/workspace/USER.md",
    ]);
  });

  it("appends the optional destination", () => {
    expect(
      buildOpenshellDownloadArgs("alpha", "/sandbox/.openclaw/workspace", {
        destination: "./alpha-workspace",
      }),
    ).toEqual([
      "sandbox",
      "download",
      "alpha",
      "/sandbox/.openclaw/workspace",
      "./alpha-workspace",
    ]);
  });
});

describe("buildOpenshellUploadArgs", () => {
  it("builds the basic two-arg form with no destination and no flag", () => {
    expect(buildOpenshellUploadArgs("alpha", "./USER.md")).toEqual([
      "sandbox",
      "upload",
      "alpha",
      "./USER.md",
    ]);
  });

  it("places --no-git-ignore before the positional args", () => {
    expect(
      buildOpenshellUploadArgs("alpha", "./workspace", {
        destination: "/sandbox/.openclaw/workspace",
        noGitIgnore: true,
      }),
    ).toEqual([
      "sandbox",
      "upload",
      "--no-git-ignore",
      "alpha",
      "./workspace",
      "/sandbox/.openclaw/workspace",
    ]);
  });

  it("appends the destination without --no-git-ignore when the flag is unset", () => {
    expect(
      buildOpenshellUploadArgs("alpha", "./USER.md", {
        destination: "/sandbox/.openclaw/workspace/USER.md",
      }),
    ).toEqual([
      "sandbox",
      "upload",
      "alpha",
      "./USER.md",
      "/sandbox/.openclaw/workspace/USER.md",
    ]);
  });
});
