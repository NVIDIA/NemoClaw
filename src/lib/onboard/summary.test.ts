// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

import { describe, it } from "vitest";

import { formatOnboardConfigSummary, formatSandboxBuildEstimateNote } from "../../../dist/lib/onboard/summary";

describe("onboard summary helpers", () => {
  it("formatOnboardConfigSummary renders all collected fields (#2165)", () => {
    const summary = formatOnboardConfigSummary({
      provider: "gemini-api",
      model: "gemini-2.5-flash",
      credentialEnv: "GEMINI_API_KEY",
      webSearchConfig: { fetchEnabled: true },
      enabledChannels: ["telegram", "slack"],
      sandboxName: "my-assistant",
      notes: ["Sandbox build typically takes 5–15 minutes on this host."],
    });

    assert.ok(summary.includes("Review configuration"), "summary has review heading");
    assert.ok(summary.includes("gemini-api"), "summary includes provider");
    assert.ok(summary.includes("gemini-2.5-flash"), "summary includes model");
    assert.ok(
      summary.includes("GEMINI_API_KEY (staged for OpenShell gateway registration)"),
      "summary shows API key env var + staging state",
    );
    assert.ok(summary.includes("enabled"), "summary includes web-search enabled");
    assert.ok(summary.includes("telegram, slack"), "summary lists enabled channels");
    assert.ok(summary.includes("my-assistant"), "summary shows sandbox name");
    assert.ok(
      summary.includes("Note:          Sandbox build typically takes 5–15 minutes on this host."),
      "summary renders notes under sandbox name",
    );

    const bareSummary = formatOnboardConfigSummary({
      provider: "nvidia-prod",
      model: "nvidia/nemotron-3-super-120b-a12b",
      credentialEnv: "NVIDIA_API_KEY",
      webSearchConfig: null,
      enabledChannels: [],
      sandboxName: "test",
    });
    assert.ok(bareSummary.includes("Messaging:     none"), "empty channels renders as 'none'");
    assert.ok(
      bareSummary.includes("Web search:    disabled"),
      "null webSearch renders as 'disabled'",
    );

    const localSummary = formatOnboardConfigSummary({
      provider: "ollama-local",
      model: "llama3:8b",
      credentialEnv: null,
      webSearchConfig: null,
      enabledChannels: [],
      sandboxName: "local",
    });
    assert.ok(
      localSummary.includes("(not required for ollama-local)"),
      "null credentialEnv falls back to a provider-specific message",
    );

    const orphanSummary = formatOnboardConfigSummary({
      provider: null,
      model: null,
      webSearchConfig: null,
      enabledChannels: null,
      sandboxName: "orphan",
    });
    assert.ok(!orphanSummary.includes("undefined"), "null fields never render as 'undefined'");
    assert.ok(orphanSummary.includes("(unset)"), "null fields fall back to '(unset)'");
  });

  it("formatSandboxBuildEstimateNote warns when runtime is under-provisioned (#2514)", () => {
    const note = formatSandboxBuildEstimateNote({
      isContainerRuntimeUnderProvisioned: true,
      dockerCpus: 2,
      dockerMemTotalBytes: 2 * 1024 ** 3,
    });
    assert.ok(note != null && note.length > 0, "returns a note");
    assert.match(note as string, /under-provisioned/i, "note flags under-provisioned host");
  });

  it("formatSandboxBuildEstimateNote returns a tighter range on a generous host (#2514)", () => {
    const note = formatSandboxBuildEstimateNote({
      isContainerRuntimeUnderProvisioned: false,
      dockerCpus: 12,
      dockerMemTotalBytes: 32 * 1024 ** 3,
    });
    assert.ok(note != null, "returns a note");
    assert.match(note ?? "", /\b3[–-]\d+\s+minutes\b/, "tight range starts at 3 minutes");
  });

  it("formatSandboxBuildEstimateNote returns null when no runtime resource signal is available (#2514)", () => {
    const note = formatSandboxBuildEstimateNote({
      isContainerRuntimeUnderProvisioned: false,
    });
    assert.strictEqual(note, null);
  });
});
