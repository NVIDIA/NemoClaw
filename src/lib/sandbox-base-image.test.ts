// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  formatBuildFailureDiagnostics,
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

  it("surfaces stderr build diagnostics on failure (#3584)", () => {
    const output = formatBuildFailureDiagnostics({
      stderr: "the --mount option requires BuildKit",
      stdout: "",
    });
    expect(output).toContain("the --mount option requires BuildKit");
  });

  it("surfaces stdout-only build diagnostics — BuildKit can land errors there (Codex review on #3584)", () => {
    const output = formatBuildFailureDiagnostics({
      stderr: "",
      stdout: "ERROR: failed to solve: process \"/bin/sh -c apt-get install\" did not complete successfully",
    });
    expect(output).toContain("ERROR: failed to solve");
  });

  it("combines stderr and stdout when both carry build output", () => {
    const output = formatBuildFailureDiagnostics({
      stderr: "build error line A",
      stdout: "build error line B",
    });
    expect(output).toBe("build error line A\nbuild error line B");
  });

  it("returns empty string when both streams are empty", () => {
    expect(formatBuildFailureDiagnostics({ stderr: "", stdout: "" })).toBe("");
    expect(formatBuildFailureDiagnostics({})).toBe("");
  });

  it("redacts captured build output before returning it", () => {
    // The runner's redact() pass strips Bearer tokens, NVIDIA API keys, etc.
    // Anything that looks like a secret in build output must not leak.
    const output = formatBuildFailureDiagnostics({
      stderr: "auth: Bearer sk-abcdef0123456789abcdef0123456789abcdef0123456789 failed",
      stdout: "",
    });
    expect(output).not.toContain("sk-abcdef0123456789abcdef0123456789abcdef0123456789");
  });

  it("accepts Buffer streams from spawnSync", () => {
    const output = formatBuildFailureDiagnostics({
      stderr: Buffer.from("buffered build error", "utf8"),
      stdout: null,
    });
    expect(output).toContain("buffered build error");
  });
});
