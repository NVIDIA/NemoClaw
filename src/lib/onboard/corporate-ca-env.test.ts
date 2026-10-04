// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { expectWarning, tmpDir, writeCa } from "./__test-helpers__/corporate-ca-fixtures";
import {
  CORPORATE_CA_DISABLE_ENV,
  CORPORATE_CA_EXPLICIT_ENV,
  CorporateCaValidationError,
  resolveCorporateCaFromEnv,
} from "./corporate-ca";

describe("resolveCorporateCaFromEnv", () => {
  it("returns null when no CA env is set", () => {
    expect(resolveCorporateCaFromEnv({})).toBeNull();
  });

  it("does not read the host trust store from env resolution alone (#6210)", () => {
    expect(resolveCorporateCaFromEnv({})).toBeNull();
  });

  it("resolves the explicit env var first", () => {
    const p = writeCa(tmpDir());
    const resolved = resolveCorporateCaFromEnv({ [CORPORATE_CA_EXPLICIT_ENV]: p });
    expect(resolved?.sourceEnv).toBe(CORPORATE_CA_EXPLICIT_ENV);
    expect(resolved?.pem).toContain("BEGIN CERTIFICATE");
  });

  it("throws when the explicit env var points at an invalid file", () => {
    expect(() =>
      resolveCorporateCaFromEnv({ [CORPORATE_CA_EXPLICIT_ENV]: "/does/not/exist.pem" }),
    ).toThrow(CorporateCaValidationError);
  });

  it("falls back to REQUESTS_CA_BUNDLE / CURL_CA_BUNDLE", () => {
    const p = writeCa(tmpDir());
    expect(resolveCorporateCaFromEnv({ REQUESTS_CA_BUNDLE: p })?.sourceEnv).toBe(
      "REQUESTS_CA_BUNDLE",
    );
    expect(resolveCorporateCaFromEnv({ CURL_CA_BUNDLE: p })?.sourceEnv).toBe("CURL_CA_BUNDLE");
  });

  it("warns and continues past an invalid fallback env var to the next", () => {
    const p = writeCa(tmpDir());
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const resolved = resolveCorporateCaFromEnv({
      REQUESTS_CA_BUNDLE: "/does/not/exist.pem",
      CURL_CA_BUNDLE: p,
    });
    const messages = errorSpy.mock.calls.map((call) => String(call[0]));
    errorSpy.mockRestore();
    expect(resolved?.sourceEnv).toBe("CURL_CA_BUNDLE");
    expectWarning(messages, "REQUESTS_CA_BUNDLE", "WARNING");
  });

  it("returns null and warns when every fallback env var is invalid", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const resolved = resolveCorporateCaFromEnv({
      REQUESTS_CA_BUNDLE: "/missing.pem",
      SSL_CERT_FILE: "/nope.pem",
    });
    const messages = errorSpy.mock.calls.map((call) => String(call[0]));
    errorSpy.mockRestore();
    expect(resolved).toBeNull();
    expect(messages.filter((m) => m.includes("WARNING"))).toHaveLength(2);
  });

  it("honors the disable opt-out", () => {
    const p = writeCa(tmpDir());
    expect(
      resolveCorporateCaFromEnv({
        [CORPORATE_CA_EXPLICIT_ENV]: p,
        [CORPORATE_CA_DISABLE_ENV]: "0",
      }),
    ).toBeNull();
  });

  it("throws when the explicit env var points at a merged OS trust store (#6210)", () => {
    expect(() =>
      resolveCorporateCaFromEnv({
        [CORPORATE_CA_EXPLICIT_ENV]: "/etc/ssl/certs/ca-certificates.crt",
      }),
    ).toThrow(CorporateCaValidationError);
  });

  it("skips a fallback env var pointing at a merged OS trust store and warns (#6210)", () => {
    const p = writeCa(tmpDir());
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const resolved = resolveCorporateCaFromEnv({
      REQUESTS_CA_BUNDLE: "/etc/ssl/certs/ca-certificates.crt",
      CURL_CA_BUNDLE: p,
    });
    const messages = errorSpy.mock.calls.map((call) => String(call[0]));
    errorSpy.mockRestore();
    expect(resolved?.sourceEnv).toBe("CURL_CA_BUNDLE");
    expectWarning(messages, "REQUESTS_CA_BUNDLE", "merged OS trust store");
  });
});
