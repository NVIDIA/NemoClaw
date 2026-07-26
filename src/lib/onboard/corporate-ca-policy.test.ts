// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { PEM, tmpDir, writeCa } from "./__test-helpers__/corporate-ca-fixtures";
import {
  encodeCorporateCaArg,
  isKnownMergedTrustStorePath,
  KNOWN_MERGED_TRUST_STORE_PATHS,
} from "./corporate-ca";

describe("isKnownMergedTrustStorePath (#6210)", () => {
  it("matches every well-known merged OS trust-store path", () => {
    for (const p of KNOWN_MERGED_TRUST_STORE_PATHS) {
      expect(isKnownMergedTrustStorePath(p)).toBe(true);
    }
  });

  it("normalizes a non-canonical path before matching", () => {
    expect(isKnownMergedTrustStorePath("/etc/ssl/certs/../certs/ca-certificates.crt")).toBe(true);
  });

  it("does not match a dedicated corporate CA file", () => {
    const p = writeCa(tmpDir());
    expect(isKnownMergedTrustStorePath(p)).toBe(false);
  });
});

describe("encodeCorporateCaArg", () => {
  it("produces single-line base64 that round-trips", () => {
    const encoded = encodeCorporateCaArg(PEM);
    expect(encoded).not.toMatch(/[\r\n]/);
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(PEM);
  });
});
