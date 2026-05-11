// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  getSourceShortShaTags,
  parseGlibcVersion,
  versionGte,
} from "../../dist/lib/sandbox-base-image";

describe("sandbox base image helpers", () => {
  it("parses glibc versions from ldd output", () => {
    expect(parseGlibcVersion("ldd (Debian GLIBC 2.41-12+deb13u2) 2.41")).toBe("2.41");
    expect(parseGlibcVersion("ldd (Ubuntu GLIBC 2.39-0ubuntu8.6) 2.39")).toBe("2.39");
  });

  it("compares glibc versions numerically", () => {
    expect(versionGte("2.41", "2.39")).toBe(true);
    expect(versionGte("2.39", "2.39")).toBe(true);
    expect(versionGte("2.36", "2.39")).toBe(false);
  });

  it("derives source-sha tags compatible with base-image workflow metadata", () => {
    const tags = getSourceShortShaTags("/definitely/not/a/git/repo", {
      GITHUB_SHA: "1E94F2E207C5456EBC35E2BD5BB380D4430292C6",
    } as NodeJS.ProcessEnv);
    expect(tags).toEqual(["1e94f2e2", "1e94f2e"]);
  });
});
