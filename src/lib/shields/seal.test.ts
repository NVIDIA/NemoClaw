// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import path from "node:path";

async function loadSeal(): Promise<typeof import("../../../dist/lib/shields/seal")> {
  const distModulePath = path.join(
    process.cwd(),
    "dist",
    "lib",
    "shields",
    "seal.js",
  );
  return import(distModulePath);
}

describe("parseSha256Output", () => {
  it("returns the hex hash from a standard `sha256sum <file>` line", async () => {
    const { parseSha256Output } = await loadSeal();
    const line =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  /sandbox/.openclaw/openclaw.json";
    expect(parseSha256Output(line)).toBe(
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
  });

  it("returns null for empty or whitespace-only input", async () => {
    const { parseSha256Output } = await loadSeal();
    expect(parseSha256Output("")).toBeNull();
    expect(parseSha256Output("   \n\t  ")).toBeNull();
  });

  it("returns null when the first token is not a 64-char hex string", async () => {
    const { parseSha256Output } = await loadSeal();
    expect(parseSha256Output("garbage output line")).toBeNull();
    expect(parseSha256Output("0123  /sandbox/.openclaw/openclaw.json")).toBeNull();
    // 65 chars
    expect(
      parseSha256Output(
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdefx  /file",
      ),
    ).toBeNull();
  });

  it("normalises uppercase hex to lowercase", async () => {
    const { parseSha256Output } = await loadSeal();
    expect(
      parseSha256Output(
        "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789  /file",
      ),
    ).toBe("abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789");
  });
});

describe("isHashVerificationIssue", () => {
  it("matches every emitted hash-failure prefix so callers refuse to re-seal", async () => {
    const { isHashVerificationIssue } = await loadSeal();
    expect(
      isHashVerificationIssue(
        "/sandbox/.openclaw/openclaw.json content drifted (sha256 ff != sealed 01)",
      ),
    ).toBe(true);
    expect(
      isHashVerificationIssue(
        "/sandbox/.openclaw/openclaw.json sha256sum failed: I/O error",
      ),
    ).toBe(true);
    expect(
      isHashVerificationIssue(
        "/sandbox/.openclaw/openclaw.json sha256sum output unparsable: garbage",
      ),
    ).toBe(true);
    expect(
      isHashVerificationIssue(
        "/sandbox/.openclaw/openclaw.json no seal recorded (expected SHA-256)",
      ),
    ).toBe(true);
  });

  it("rejects unrelated perm-only entries so they remain launderable by re-lock", async () => {
    const { isHashVerificationIssue } = await loadSeal();
    expect(
      isHashVerificationIssue(
        "/sandbox/.openclaw/openclaw.json mode=660 (expected 444)",
      ),
    ).toBe(false);
    expect(
      isHashVerificationIssue(
        "/sandbox/.openclaw/openclaw.json owner=sandbox:sandbox (expected root:root)",
      ),
    ).toBe(false);
    expect(isHashVerificationIssue("dir mode=2770 (expected 755)")).toBe(false);
  });
});
