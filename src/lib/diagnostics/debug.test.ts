// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Import from compiled dist/ so coverage is attributed correctly.
import {
  buildDmesgRerunCommand,
  createTarball,
  dmesgRestrictedMessage,
  getDebugCompletionMessages,
  isDmesgPermissionDeniedOutput,
  isDmesgRestrictedForCurrentUser,
  redact,
} from "../../../dist/lib/diagnostics/debug";

describe("redact", () => {
  it("redacts NVIDIA_API_KEY=value patterns", () => {
    const key = ["NVIDIA", "API", "KEY"].join("_");
    expect(redact(`${key}=some-value`)).toBe(`${key}=<REDACTED>`);
  });

  it("redacts generic KEY/TOKEN/SECRET/PASSWORD env vars", () => {
    expect(redact("API_KEY=secret123")).toBe("API_KEY=<REDACTED>");
    expect(redact("MY_TOKEN=tok_abc")).toBe("MY_TOKEN=<REDACTED>");
    expect(redact("DB_PASSWORD=hunter2")).toBe("DB_PASSWORD=<REDACTED>");
    expect(redact("MY_SECRET=s3cret")).toBe("MY_SECRET=<REDACTED>");
    expect(redact("CREDENTIAL=cred")).toBe("CREDENTIAL=<REDACTED>");
  });

  it("redacts nvapi- prefixed keys", () => {
    expect(redact("using key nvapi-AbCdEfGhIj1234")).toBe("using key <REDACTED>");
  });

  it("redacts classic GitHub personal access tokens (ghp_)", () => {
    expect(redact("token: ghp_" + "a".repeat(36))).toBe("token: <REDACTED>");
  });

  it("redacts fine-grained GitHub personal access tokens (github_pat_)", () => {
    expect(redact("token: github_pat_" + "A".repeat(40))).toBe("token: <REDACTED>");
  });

  it("redacts Bearer tokens", () => {
    expect(redact("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig")).toBe(
      "Authorization: Bearer <REDACTED>",
    );
  });

  it("handles multiple patterns in one string", () => {
    const input = "API_KEY=secret nvapi-abcdefghijk Bearer tok123";
    const result = redact(input);
    expect(result).not.toContain("secret");
    expect(result).not.toContain("nvapi-abcdefghijk");
    expect(result).not.toContain("tok123");
  });

  it("leaves clean text unchanged", () => {
    const clean = "Hello world, no secrets here";
    expect(redact(clean)).toBe(clean);
  });
});

describe("createTarball", () => {
  let tempDir: string;
  let outputDir: string;

  beforeEach(() => {
    process.exitCode = undefined;
  });

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    if (outputDir) rmSync(outputDir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it("sets process.exitCode = 1 and returns false when tar fails on invalid output path", () => {
    tempDir = mkdtempSync(join(tmpdir(), "debug-test-"));
    writeFileSync(join(tempDir, "dummy.txt"), "test data");
    const ok = createTarball(tempDir, "/nonexistent/path/debug.tar.gz");
    expect(ok).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it("leaves pre-existing user output untouched and removes the temp sibling when tar fails", () => {
    tempDir = mkdtempSync(join(tmpdir(), "debug-test-"));
    writeFileSync(join(tempDir, "payload.txt"), "test data");
    outputDir = mkdtempSync(join(tmpdir(), "debug-test-out-"));
    const output = join(outputDir, "partial.tar.gz");
    // Pre-existing user file must NOT be clobbered when tar fails.
    const previous = "pre-existing user content";
    writeFileSync(output, previous);
    // Removing the source dir forces tar to fail without racing in-progress
    // collection.
    rmSync(tempDir, { recursive: true, force: true });
    const ok = createTarball(tempDir, output);
    expect(ok).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(existsSync(output)).toBe(true);
    expect(readFileSync(output, "utf-8")).toBe(previous);
    // No .partial sibling should remain after cleanup.
    const partials = readdirSync(outputDir).filter(
      (name) => name.endsWith(".partial") || name.includes(".partial."),
    );
    expect(partials).toEqual([]);
  });

  it("creates tarball successfully and returns true for valid output path", () => {
    tempDir = mkdtempSync(join(tmpdir(), "debug-test-"));
    writeFileSync(join(tempDir, "dummy.txt"), "test data");
    // Write output to a SEPARATE directory — writing into the source dir
    // causes tar to see the file changing as it reads, returning exit 1.
    outputDir = mkdtempSync(join(tmpdir(), "debug-test-out-"));
    const output = join(outputDir, "output.tar.gz");
    const ok = createTarball(tempDir, output);
    expect(ok).toBe(true);
    expect(process.exitCode).toBeUndefined();
    expect(existsSync(output)).toBe(true);
  });
});

describe("dmesg restriction detection", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("detects restricted dmesg for non-root users", () => {
    tempDir = mkdtempSync(join(tmpdir(), "debug-dmesg-test-"));
    const restrictPath = join(tempDir, "dmesg_restrict");
    writeFileSync(restrictPath, "1\n");

    expect(isDmesgRestrictedForCurrentUser(restrictPath, 1000)).toBe(true);
  });

  it("does not skip dmesg for root or unreadable restriction state", () => {
    tempDir = mkdtempSync(join(tmpdir(), "debug-dmesg-test-"));
    const restrictPath = join(tempDir, "dmesg_restrict");
    writeFileSync(restrictPath, "1\n");

    expect(isDmesgRestrictedForCurrentUser(restrictPath, 0)).toBe(false);
    expect(isDmesgRestrictedForCurrentUser(join(tempDir, "missing"), 1000)).toBe(false);
  });
});

describe("getDebugCompletionMessages", () => {
  it("suggests --output when no tarball path is provided", () => {
    expect(getDebugCompletionMessages()).toEqual([
      "Done. If filing a bug, run with --output and attach the tarball to your issue:",
      "  nemoclaw debug --output /tmp/nemoclaw-debug.tar.gz",
    ]);
  });

  it("omits the redundant --output hint when a tarball was already written", () => {
    expect(getDebugCompletionMessages("/tmp/nemoclaw-debug.tar.gz")).toEqual([]);
  });
});

describe("isDmesgPermissionDeniedOutput", () => {
  it("recognizes restricted dmesg stderr", () => {
    expect(
      isDmesgPermissionDeniedOutput("dmesg: read kernel buffer failed: Operation not permitted"),
    ).toBe(true);
  });

  it("does not treat unrelated permission errors as dmesg restrictions", () => {
    expect(isDmesgPermissionDeniedOutput("docker: Permission denied")).toBe(false);
  });
});

describe("dmesgRestrictedMessage (#4366)", () => {
  it("explains why kernel messages were skipped", () => {
    const msg = dmesgRestrictedMessage("kernel.dmesg_restrict=1 prevents non-root access");
    expect(msg).toContain("kernel messages skipped");
    expect(msg).toContain("kernel.dmesg_restrict=1 prevents non-root access");
  });

  it("includes a 'sudo nemoclaw debug' hint so users can re-run with kernel logs", () => {
    const msg = dmesgRestrictedMessage("some-reason");
    expect(msg).toMatch(/sudo nemoclaw debug/);
    expect(msg.toLowerCase()).toMatch(/re-?run/);
  });

  it("warns that privileged diagnostics may contain sensitive data", () => {
    const msg = dmesgRestrictedMessage("some-reason");
    expect(msg.toLowerCase()).toMatch(/sensitive/);
  });

  it("preserves --quick in the rerun hint when the user invoked debug --quick", () => {
    const msg = dmesgRestrictedMessage("some-reason", { quick: true });
    expect(msg).toContain("sudo nemoclaw debug --quick");
  });

  it("preserves --output in the rerun hint when the user supplied an output path", () => {
    const msg = dmesgRestrictedMessage("some-reason", { output: "/tmp/out.tgz" });
    expect(msg).toContain("sudo nemoclaw debug --output '/tmp/out.tgz'");
  });

  it("preserves both --quick and --output together", () => {
    const msg = dmesgRestrictedMessage("some-reason", {
      quick: true,
      output: "/tmp/out.tgz",
    });
    expect(msg).toContain("sudo nemoclaw debug --quick --output '/tmp/out.tgz'");
  });

  it("falls back to bare 'sudo nemoclaw debug' when no options are supplied", () => {
    const msg = dmesgRestrictedMessage("some-reason");
    expect(msg).toMatch(/`sudo nemoclaw debug`/);
  });
});

describe("buildDmesgRerunCommand (#4366)", () => {
  it("returns the bare command when no options are set", () => {
    expect(buildDmesgRerunCommand()).toBe("sudo nemoclaw debug");
  });

  it("appends --quick when opts.quick is true", () => {
    expect(buildDmesgRerunCommand({ quick: true })).toBe("sudo nemoclaw debug --quick");
  });

  it("appends a single-quoted --output path", () => {
    expect(buildDmesgRerunCommand({ output: "/tmp/out.tgz" })).toBe(
      "sudo nemoclaw debug --output '/tmp/out.tgz'",
    );
  });

  it("escapes single quotes inside the output path", () => {
    expect(buildDmesgRerunCommand({ output: "/tmp/o'ut.tgz" })).toBe(
      "sudo nemoclaw debug --output '/tmp/o'\\''ut.tgz'",
    );
  });
});
