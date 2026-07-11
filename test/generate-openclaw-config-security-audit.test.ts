// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildConfig } from "../scripts/generate-openclaw-config.mts";

const BASE_ENV: Record<string, string> = {
  NEMOCLAW_MODEL: "test-model",
  NEMOCLAW_PROVIDER_KEY: "test-provider",
  NEMOCLAW_PRIMARY_MODEL_REF: "test-ref",
  NEMOCLAW_INFERENCE_BASE_URL: "http://localhost:8080",
  NEMOCLAW_INFERENCE_API: "openai",
};

function buildSecurityAuditConfig(chatUiUrl: string, overrides: Record<string, string> = {}): any {
  return buildConfig({ ...BASE_ENV, CHAT_UI_URL: chatUiUrl, ...overrides });
}

describe("generate-openclaw-config.mts: managed security audit findings", () => {
  it("explains NemoClaw-managed insecure auth findings (#6024)", () => {
    const config = buildSecurityAuditConfig("http://127.0.0.1:18789");
    expect(config.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback).toBeUndefined();
    expect(config.security.audit.suppressions).toEqual([
      {
        checkId: "gateway.control_ui.insecure_auth",
        reason:
          "NemoClaw derives this setting from a loopback HTTP CHAT_UI_URL; use HTTPS for non-loopback dashboards.",
      },
      {
        checkId: "config.insecure_or_dangerous_flags",
        detailIncludes: "gateway.controlUi.allowInsecureAuth=true",
        reason:
          "NemoClaw derives this setting from a loopback HTTP CHAT_UI_URL; use HTTPS for non-loopback dashboards.",
      },
    ]);
  });

  it("keeps remote device auth findings active (#6024)", () => {
    const config = buildSecurityAuditConfig("https://nemoclaw0-xxx.brevlab.com:18789", {
      NEMOCLAW_DISABLE_DEVICE_AUTH: "1",
    });
    expect(config.gateway.controlUi.dangerouslyDisableDeviceAuth).toBe(true);
    expect(config.security).toBeUndefined();
  });

  it("keeps all remote HTTP security findings active (#6024)", () => {
    const config = buildSecurityAuditConfig("http://remote.example:18789", {
      NEMOCLAW_DISABLE_DEVICE_AUTH: "1",
    });
    expect(config.gateway.controlUi.allowInsecureAuth).toBe(true);
    expect(config.gateway.controlUi.dangerouslyDisableDeviceAuth).toBe(true);
    expect(config.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback).toBeUndefined();
    expect(config.security).toBeUndefined();
  });

  it("keeps loopback HTTP findings active when the dashboard bind is remote (#6024)", () => {
    const config = buildSecurityAuditConfig("http://127.0.0.1:18789", {
      NEMOCLAW_DASHBOARD_BIND: "0.0.0.0",
    });
    expect(config.gateway.controlUi.allowInsecureAuth).toBe(true);
    expect(config.gateway.controlUi.dangerouslyDisableDeviceAuth).toBe(true);
    expect(config.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback).toBe(true);
    expect(config.security?.audit?.suppressions ?? []).toEqual([]);
  });

  it("keeps loopback HTTP findings active for a WSL all-interface forward (#6024)", () => {
    const config = buildSecurityAuditConfig("http://127.0.0.1:18789", {
      NEMOCLAW_WSL_DASHBOARD_EXPOSURE: "1",
      NEMOCLAW_DISABLE_DEVICE_AUTH: "1",
      NEMOCLAW_DEVICE_AUTH_OPT_OUT_SOURCE: "managed-onboard",
    });
    expect(config.gateway.controlUi.allowInsecureAuth).toBe(true);
    expect(config.gateway.controlUi.dangerouslyDisableDeviceAuth).toBe(true);
    expect(config.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback).toBeUndefined();
    expect(config.security?.audit?.suppressions ?? []).toEqual([]);
  });

  it("keeps explicit device auth findings active when the dashboard bind is remote (#6024)", () => {
    const config = buildSecurityAuditConfig("http://127.0.0.1:18789", {
      NEMOCLAW_DASHBOARD_BIND: "0.0.0.0",
      NEMOCLAW_DISABLE_DEVICE_AUTH: "1",
    });
    expect(config.gateway.controlUi.allowInsecureAuth).toBe(true);
    expect(config.gateway.controlUi.dangerouslyDisableDeviceAuth).toBe(true);
    expect(config.security).toBeUndefined();
  });

  it("keeps an operator device auth opt-out active on loopback (#6024)", () => {
    const config = buildSecurityAuditConfig("https://127.0.0.1:18789", {
      NEMOCLAW_DISABLE_DEVICE_AUTH: "1",
      NEMOCLAW_DEVICE_AUTH_OPT_OUT_SOURCE: "operator",
    });
    expect(config.gateway.controlUi.dangerouslyDisableDeviceAuth).toBe(true);
    expect(config.security).toBeUndefined();
  });

  it("reports the managed onboarding device auth compatibility source truthfully (#6024)", () => {
    const config = buildSecurityAuditConfig("https://127.0.0.1:18789", {
      NEMOCLAW_DISABLE_DEVICE_AUTH: "1",
      NEMOCLAW_DEVICE_AUTH_OPT_OUT_SOURCE: "managed-onboard",
    });

    expect(config.security.audit.suppressions[0].reason).toContain("NemoClaw onboarding");
    expect(config.security.audit.suppressions[0].reason).not.toContain("explicitly opts out");
  });

  it("keeps device auth findings active when opt-out provenance is missing (#6024)", () => {
    const config = buildSecurityAuditConfig("https://127.0.0.1:18789", {
      NEMOCLAW_DISABLE_DEVICE_AUTH: "1",
    });

    expect(config.gateway.controlUi.dangerouslyDisableDeviceAuth).toBe(true);
    expect(config.security).toBeUndefined();
  });

  it.each([
    ["NEMOCLAW_DASHBOARD_BIND", "127.0.0.1"],
    ["NEMOCLAW_WSL_DASHBOARD_EXPOSURE", "2"],
    ["NEMOCLAW_DEVICE_AUTH_OPT_OUT_SOURCE", "untrusted"],
  ])("rejects an invalid %s value (#6024)", (name, value) => {
    expect(() => buildSecurityAuditConfig("https://127.0.0.1:18789", { [name]: value })).toThrow(
      `${name} must be empty or one of:`,
    );
  });

  it("omits audit suppressions for a loopback HTTPS dashboard (#6024)", () => {
    const config = buildSecurityAuditConfig("https://127.0.0.1:18789");
    expect(config.security).toBeUndefined();
  });
});
