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

function buildSecurityAuditConfig(chatUiUrl: string): any {
  return buildConfig({ ...BASE_ENV, CHAT_UI_URL: chatUiUrl });
}

describe("generate-openclaw-config.mts: managed security audit findings", () => {
  it("explains NemoClaw-managed insecure auth findings (#6024)", () => {
    const config = buildSecurityAuditConfig("http://127.0.0.1:18789");
    expect(config.security.audit.suppressions).toEqual([
      {
        checkId: "gateway.control_ui.insecure_auth",
        reason:
          "NemoClaw derives this setting from an HTTP CHAT_UI_URL; use HTTPS for non-loopback dashboards.",
      },
      {
        checkId: "config.insecure_or_dangerous_flags",
        detailIncludes: "gateway.controlUi.allowInsecureAuth=true",
        reason:
          "NemoClaw derives this setting from an HTTP CHAT_UI_URL; use HTTPS for non-loopback dashboards.",
      },
    ]);
  });

  it("explains NemoClaw-managed device auth findings (#6024)", () => {
    const config = buildSecurityAuditConfig("https://nemoclaw0-xxx.brevlab.com:18789");
    expect(config.security.audit.suppressions).toEqual([
      {
        checkId: "gateway.control_ui.device_auth_disabled",
        reason:
          "NemoClaw enables this compatibility setting for non-loopback or explicitly opted-out dashboards; use loopback access to retain device authentication.",
      },
      {
        checkId: "config.insecure_or_dangerous_flags",
        detailIncludes: "gateway.controlUi.dangerouslyDisableDeviceAuth=true",
        reason:
          "NemoClaw enables this compatibility setting for non-loopback or explicitly opted-out dashboards; use loopback access to retain device authentication.",
      },
    ]);
  });

  it("explains both managed flags for a non-loopback HTTP dashboard (#6024)", () => {
    const config = buildSecurityAuditConfig("http://remote.example:18789");
    expect(config.security.audit.suppressions).toHaveLength(4);
    expect(config.security.audit.suppressions.map((entry: any) => entry.checkId)).toEqual([
      "gateway.control_ui.insecure_auth",
      "config.insecure_or_dangerous_flags",
      "gateway.control_ui.device_auth_disabled",
      "config.insecure_or_dangerous_flags",
    ]);
  });

  it("omits audit suppressions for a loopback HTTPS dashboard (#6024)", () => {
    const config = buildSecurityAuditConfig("https://127.0.0.1:18789");
    expect(config.security).toBeUndefined();
  });
});
