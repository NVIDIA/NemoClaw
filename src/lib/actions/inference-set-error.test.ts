// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildOpenshellInferenceSetFailureMessage,
  openshellReportsProviderNotFound,
} from "./inference-set-error";

describe("inference set OpenShell failure diagnostics", () => {
  it("correlates only a quoted missing provider with the requested provider (#5924)", () => {
    expect(
      openshellReportsProviderNotFound(
        "error: provider 'openai-api' not found in gateway",
        "openai-api",
      ),
    ).toBe(true);
    expect(openshellReportsProviderNotFound("provider 'openai-api' not found", "openai-api")).toBe(
      true,
    );
    expect(
      openshellReportsProviderNotFound(
        "error: not found: provider `openai-api` is unavailable",
        "openai-api",
      ),
    ).toBe(true);
    expect(
      openshellReportsProviderNotFound(
        "error: provider 'anthropic-prod' not found in gateway",
        "openai-api",
      ),
    ).toBe(false);
    expect(
      openshellReportsProviderNotFound("error: provider openai-api not found", "openai-api"),
    ).toBe(false);
  });

  it("fully redacts and caps enhanced provider-not-found details (#5924)", () => {
    const envSecret = "plainsecret123456"; // gitleaks:allow
    const bearerSecret = "plainbearersecret123456"; // gitleaks:allow
    const querySecret = "plainquerysecret123456";
    const message = buildOpenshellInferenceSetFailureMessage({
      exitCode: 1,
      providerNotFound: true,
      registeredProviders: ["nvidia-prod"],
      stderr: [
        "error: provider 'openai-api' not found in gateway",
        `OPENAI_API_KEY=${envSecret}`,
        `Authorization: Bearer ${bearerSecret}`,
        `https://gateway.example.test/fail?token=${querySecret}`,
        "x".repeat(3_000),
      ].join(" "),
      stdout: "",
    });
    const detail = message.match(/^OpenShell detail: (.*)$/mu)?.[1];

    expect(detail).toHaveLength(2_000);
    expect(message).toContain("Registered providers: nvidia-prod");
    expect(message).toContain("Tip: register a new provider with `nemoclaw onboard`");
    expect(message).not.toContain(envSecret);
    expect(message).not.toContain(bearerSecret);
    expect(message).not.toContain(querySecret);
  });

  it("redacts URL userinfo and sensitive query values from failure details (#5924)", () => {
    const username = "diagnostic-user";
    const password = "diagnostic-password";
    const querySecret = "diagnostic-query-secret";
    const message = buildOpenshellInferenceSetFailureMessage({
      exitCode: 1,
      providerNotFound: true,
      registeredProviders: [],
      stderr: `error: provider 'openai-api' not found at https://${username}:${password}@gateway.example.test/v1?token=${querySecret}`,
      stdout: "",
    });

    expect(message).not.toContain(username);
    expect(message).not.toContain(password);
    expect(message).not.toContain(querySecret);
    expect(message).toContain("https://****:****@gateway.example.test/v1?token=****");
  });

  it("keeps malformed and mismatched diagnostics on the generic path (#5924)", () => {
    const malformed = `error: provider '${"a".repeat(100_000)}`;
    const startedAt = performance.now();
    expect(openshellReportsProviderNotFound(malformed, "openai-api")).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(100);

    const message = buildOpenshellInferenceSetFailureMessage({
      exitCode: 42,
      providerNotFound: false,
      stderr: "error: network timeout connecting to gateway",
      stdout: "",
    });
    expect(message).toContain("OpenShell detail: error: network timeout connecting to gateway");
    expect(message).not.toMatch(/Registered providers|No providers registered|onboard/);
  });

  it("classifies the full bounded capture before display truncation (#5924)", () => {
    const output = `${"x".repeat(2_500)} error: provider 'openai-api' was not found`;

    expect(openshellReportsProviderNotFound(output, "openai-api")).toBe(true);
  });
});
