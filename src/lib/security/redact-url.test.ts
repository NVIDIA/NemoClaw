// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  makeEmptyClaimsJwtFixture,
  makeJwtFixture,
} from "../../../test/helpers/security-token-fixtures";

import { redact, redactUrl } from "./redact.js";

const credentialLabel = ["api", "Key"].join("");

describe("URL redaction", () => {
  it.each([
    ["SOCKS", "socks5://socks-user:socks-password@proxy.example:1080"],
    ["mixed-case FTP", "FtP://ftp-user:ftp-password@files.example/path"],
    ["mixed-case HTTPS", "HTTPS://https-user:https-password@secure.example:8443"],
  ])("redacts embedded credentials from %s URLs", (_label, value) => {
    const result = redact(value);

    expect(result).toContain("****:****@");
    expect(result).not.toContain("-user");
    expect(result).not.toContain("-password");
  });

  it("redacts a bracket-wrapped SOCKS URL without breaking its closing delimiter", () => {
    const result = redact(
      "proxy [socks5://bracket-user:bracket-password@proxy.example:1080] failed",
    );

    expect(result).toContain("socks5://****:****@proxy.example:1080]");
    expect(result).not.toContain("bracket-user");
    expect(result).not.toContain("bracket-password");
  });

  it("bounds malformed wrapper parsing before falling back to userinfo redaction", () => {
    const wrappers = "]".repeat(4_096);
    const result = redact(
      `proxy [socks5://bounded-user:bounded-password@proxy.example:1080${wrappers}`,
    );

    expect(result).toContain("socks5://****:****@proxy.example:1080");
    expect(result).not.toContain("bounded-user");
    expect(result).not.toContain("bounded-password");
  });

  it("redacts userinfo when a malformed URL cannot be parsed", () => {
    const value = "https://fallback-user:fallback-pass@[not-an-ip/path";
    const logResult = redact(value);
    const persistedResult = redactUrl(value);

    expect(logResult).toBe("https://****:****@[not-an-ip/path");
    expect(persistedResult).toBe("https://[not-an-ip/path");
    expect(logResult).not.toContain("fallback-user");
    expect(persistedResult).not.toContain("fallback-pass");
  });

  it("redacts encoded query secrets when a malformed URL cannot be parsed", () => {
    const encodedSecret = "sk%2Dproj%2Dabcdefghijklmnopqrstuvwxyz";
    const value = `https://fallback-user:fallback-pass@[not-an-ip/path?model=${encodedSecret}&keep=yes`;
    const logResult = redact(value);
    const persistedResult = redactUrl(value);

    expect(logResult).toContain("model=****&keep=yes");
    expect(persistedResult).toContain("model=%3CREDACTED%3E&keep=yes");
    expect(logResult).not.toContain(encodedSecret);
    expect(persistedResult).not.toContain(encodedSecret);
    expect(logResult).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz");
    expect(persistedResult).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz");
  });

  it.each([
    ["parsed", "https://endpoint.example/path"],
    ["malformed", "https://fallback-user:fallback-pass@[not-an-ip/path"],
  ])("redacts encoded fragment secrets in a %s URL", (_label, baseUrl) => {
    const encodedSecret = "sk%2Dproj%2Dabcdefghijklmnopqrstuvwxyz";
    const value = `${baseUrl}#model=${encodedSecret}&keep=yes`;
    const logResult = redact(value);
    const persistedResult = redactUrl(value);

    expect(logResult).toContain("#model=****&keep=yes");
    expect(logResult).not.toContain(encodedSecret);
    expect(logResult).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz");
    expect(persistedResult).not.toContain("#");
    expect(persistedResult).not.toContain(encodedSecret);
  });

  it.each([
    ["parsed", "https://endpoint.example/path", "%ZZsk%2Dproj%2Dabcdefghijklmnopqrstuvwxyz"],
    [
      "malformed",
      "https://fallback-user:fallback-pass@[not-an-ip/path",
      "sk%2Dproj%2Dabcdefghijklmnopqrstuvwxyz%ZZ",
    ],
  ])("redacts a standalone encoded fragment secret with malformed escapes in a %s URL", (_label, baseUrl, fragment) => {
    const result = redact(`${baseUrl}#${fragment}`);

    expect(result).not.toContain("sk%2Dproj%2Dabcdefghijklmnopqrstuvwxyz");
    expect(result).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz");
  });

  it.each([
    ["parsed", "https://endpoint.example/path"],
    ["malformed", "https://fallback-user:fallback-pass@[not-an-ip/path"],
  ])("redacts a fully encoded sensitive fragment assignment in a %s URL", (_label, baseUrl) => {
    const result = redact(`${baseUrl}#%74oken%3Dshort`);

    expect(result).toContain("#token=****");
    expect(result).not.toContain("short");
  });

  it("preserves benign persisted malformed query parameters after a sensitive key", () => {
    const value =
      "https://fallback-user:fallback-pass@[not-an-ip/path?%74oken=opaque-value&keep=yes";

    expect(redact(value)).not.toContain("opaque-value");
    expect(redactUrl(value)).toBe("https://[not-an-ip/path?token=%3CREDACTED%3E&keep=yes");
  });

  it.each([
    ["parsed", "https://endpoint.example/path"],
    ["malformed", "https://fallback-user:fallback-pass@[not-an-ip/path"],
  ])("redacts an encoded token-shaped query name in a %s URL", (_label, baseUrl) => {
    const encodedSecret = "sk%2Dproj%2Dabcdefghijklmnopqrstuvwxyz";
    const value = `${baseUrl}?${encodedSecret}=opaque&keep=yes`;
    const logResult = redact(value);
    const persistedResult = redactUrl(value);

    expect(logResult).not.toContain(encodedSecret);
    expect(logResult).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz");
    expect(persistedResult).not.toContain(encodedSecret);
    expect(persistedResult).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz");
    expect(persistedResult).toContain("%3CREDACTED%3E=opaque&keep=yes");
  });

  it("redacts encoded query secrets after the bounded wrapper fallback (#6224)", () => {
    const wrappers = "]".repeat(4_096);
    const encodedSecret = "sk%2Dproj%2Dabcdefghijklmnopqrstuvwxyz";
    const value = `https://endpoint.example/api?model=${encodedSecret}${wrappers}`;
    const logResult = redact(value);
    const persistedResult = redactUrl(value);

    expect(logResult).toContain(`model=****${wrappers}`);
    expect(logResult).not.toContain(encodedSecret);
    expect(persistedResult).toContain(`model=%3CREDACTED%3E${wrappers}`);
    expect(persistedResult).not.toContain(encodedSecret);
  });

  it.each([
    "file:///tmp/provider.json",
    "custom+agent://runtime.example/session",
  ])("redacts query secrets for the non-network URI %s", (baseUrl) => {
    const value = `${baseUrl}?model=nvapi-abcdefghijklmnopqrstuvwxyz&keep=yes`;

    expect(redact(value)).toContain("model=****&keep=yes");
    expect(redactUrl(value)).toContain("model=%3CREDACTED%3E&keep=yes");
  });

  it("preserves a credentialed IPv6 host while redacting its userinfo", () => {
    const result = redact("proxy https://ipv6-user:ipv6-password@[::1]:8443/path failed");

    expect(result).toContain("https://****:****@[::1]:8443/path");
    expect(result).not.toContain("ipv6-user");
    expect(result).not.toContain("ipv6-password");
  });

  it.each([
    [
      "parentheses and comma",
      "proxy (https://wrapped-user:wrapped-password@proxy.example/path), retry",
      "(https://****:****@proxy.example/path), retry",
    ],
    [
      "angle brackets and semicolon",
      "proxy <ftp://wrapped-user:wrapped-password@files.example/path>; retry",
      "<ftp://****:****@files.example/path>; retry",
    ],
    [
      "a trailing sentence period",
      "proxy socks5://wrapped-user:wrapped-password@proxy.example:1080. retry",
      "socks5://****:****@proxy.example:1080. retry",
    ],
  ])("keeps %s outside the redacted URL token", (_label, value, expected) => {
    const result = redact(value);

    expect(result).toContain(expected);
    expect(result).not.toContain("wrapped-user");
    expect(result).not.toContain("wrapped-password");
  });

  it.each([
    ["semicolon", "pa;ssword"],
    ["comma", "pa,ssword"],
    ["balanced parentheses", "pa(ss)word"],
  ])("redacts credentials containing valid %s punctuation", (_label, password) => {
    const result = redact(`proxy https://userinfo-user:${password}@proxy.example/path failed`);

    expect(result).toContain("https://****:****@proxy.example/path");
    expect(result).not.toContain("userinfo-user");
    expect(result).not.toContain(password);
  });

  it("fully removes generic-scheme userinfo and sensitive query values", () => {
    const result = redactUrl(
      "FtP://ftp-user:ftp-password@files.example/path?token=secret-value#fragment",
    );

    expect(result).toBe("ftp://files.example/path?token=%3CREDACTED%3E");
  });

  it.each([
    "api_key",
    "apiKey",
    "password",
    "secret",
    "authorization",
    "credential",
  ])("redacts opaque query values under credential key %s", (key) => {
    const value = `https://endpoint.example/api?${key}=opaque-value`;
    const result = redactUrl(value);
    const logResult = redact(`endpoint failed: ${value}`);

    expect(result).not.toBeNull();
    expect(new URL(result as string).searchParams.get(key)).toBe("<REDACTED>");
    expect(logResult).toContain(`${key}=****`);
    expect(logResult).not.toContain("opaque-value");
  });

  it("redacts encoded and repeated token-shaped query values under benign names", () => {
    const secrets = {
      anthropic: "sk-ant-abcdefghijklmnopqrstuvwxyz",
      github: "ghp_abcdefghijklmnopqrstuvwxyz",
      jwt: makeJwtFixture(),
      jwtEmptyClaims: makeEmptyClaimsJwtFixture(),
      nvidia: "nvapi-abcdefghijklmnopqrstuvwxyz",
      openai: "sk-proj-abcdefghijklmnopqrstuvwxyz",
      slack: "xoxb-1234567890-abcdefghij",
    };
    const encodedOpenAi = secrets.openai.replaceAll("-", "%2D");
    const result = redactUrl(
      `https://url-user:url-password@endpoint.example/api?value=${secrets.nvidia}&model=${encodedOpenAi}&provider=${secrets.anthropic}&session=${secrets.github}&channel=${secrets.slack}&assertion=${secrets.jwt}&compact=${secrets.jwtEmptyClaims}&repeat=safe&repeat=${secrets.github}&mixed=prefix:${secrets.nvidia}:suffix&token=opaque-value&keep=yes#session=${secrets.slack}`,
    );
    const logResult = redact(
      `request failed: https://endpoint.example/api?model=${encodedOpenAi}&keep=yes`,
    );

    expect(result).not.toBeNull();
    const parsed = new URL(result as string);
    expect(parsed.username).toBe("");
    expect(parsed.password).toBe("");
    expect(parsed.hash).toBe("");
    expect(parsed.searchParams.get("value")).toBe("<REDACTED>");
    expect(parsed.searchParams.get("model")).toBe("<REDACTED>");
    expect(parsed.searchParams.get("provider")).toBe("<REDACTED>");
    expect(parsed.searchParams.get("session")).toBe("<REDACTED>");
    expect(parsed.searchParams.get("channel")).toBe("<REDACTED>");
    expect(parsed.searchParams.get("assertion")).toBe("<REDACTED>");
    expect(parsed.searchParams.get("compact")).toBe("<REDACTED>");
    expect(parsed.searchParams.getAll("repeat")).toEqual(["safe", "<REDACTED>"]);
    expect(parsed.searchParams.get("mixed")).toBe("prefix:<REDACTED>:suffix");
    expect(parsed.searchParams.get("token")).toBe("<REDACTED>");
    expect(parsed.searchParams.get("keep")).toBe("yes");
    expect(logResult).toContain("model=****&keep=yes");
    expect(logResult).not.toContain(encodedOpenAi);
    expect(logResult).not.toContain(secrets.openai);
    for (const secret of Object.values(secrets)) {
      expect(result).not.toContain(secret);
    }
  });

  it.each([
    ["Bearer credential", "Bearer abcdef0123456789", "Bearer <REDACTED>", "Bearer ****"],
    [
      "credential assignment",
      `${credentialLabel}=abcdef0123456789`,
      `${credentialLabel}=<REDACTED>`,
      `${credentialLabel}=****`,
    ],
  ])("redacts a %s under a benign query name", (_label, secret, persistedValue, logValue) => {
    const value = `https://endpoint.example/v1?model=${encodeURIComponent(secret)}&keep=yes`;
    const persistedResult = redactUrl(value);
    const logResult = redact(value);

    expect(persistedResult).not.toBeNull();
    expect(new URL(persistedResult as string).searchParams.get("model")).toBe(persistedValue);
    expect(new URL(logResult).searchParams.get("model")).toBe(logValue);
    expect(persistedResult).not.toContain("abcdef0123456789");
    expect(logResult).not.toContain("abcdef0123456789");
  });

  it.each([
    ["non-JSON header", "abcde12345.payload12.signatureABCDEFGHI"],
    ["short signature", "eyJheader123.payload12.short"],
    ["two segments", "eyJheader123.payload12"],
  ])("preserves the near-miss JWT shape %s", (_label, value) => {
    const url = `https://endpoint.example/v1?model=${value}`;

    expect(new URL(redact(url)).searchParams.get("model")).toBe(value);
    expect(new URL(redactUrl(url) as string).searchParams.get("model")).toBe(value);
  });

  it("preserves a long Unicode query value while redacting an adjacent encoded secret", () => {
    const benign = `model-\u96ea-${"a".repeat(10_000)}`;
    const encodedSecret = "sk%2Dproj%2Dabcdefghijklmnopqrstuvwxyz";
    const value = `https://endpoint.example/v1?model=${encodeURIComponent(benign)}&backup=${encodedSecret}`;
    const logResult = redact(value);
    const persistedResult = redactUrl(value) as string;

    expect(new URL(logResult).searchParams.get("model")).toBe(benign);
    expect(new URL(persistedResult).searchParams.get("model")).toBe(benign);
    expect(new URL(logResult).searchParams.get("backup")).toBe("****");
    expect(new URL(persistedResult).searchParams.get("backup")).toBe("<REDACTED>");
  });
});
