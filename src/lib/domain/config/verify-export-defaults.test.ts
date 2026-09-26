// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { exportSnapshots } from "../../actions/config/export-test-fixture";
import { asExportedConfig } from "../../../../test/support/config-export-document";
import { validateConfigExportWithPinnedV1 } from "../../../../test/support/v1-config-consumer";
import { testTimeoutOptions } from "../../../../test/helpers/timeouts";
import {
  braveSnapshot,
  hermesImageRef,
  hermesProfileInput,
  hermesSnapshot,
  managedWorkload,
  snapshot,
  tavilySnapshot,
  tunedSnapshot,
} from "./export-source-test-fixture";

function enabledHermesSnapshot(port: number, internalPort: number, tui: boolean, apiPort: number) {
  return hermesSnapshot({
    dashboardPort: port,
    hermesApiPort: apiPort,
    hermesDashboardEnabled: true,
    hermesDashboardPort: port,
    hermesDashboardInternalPort: internalPort,
    hermesDashboardTui: tui,
    workload: managedWorkload(
      {
        ...hermesProfileInput(),
        dashboard: {
          agent: "hermes",
          mode: "loopback-forwarded",
          url: `http://127.0.0.1:${port}`,
          browserUrl: `http://127.0.0.1:${port}`,
          publicPort: port,
          internalPort,
          tuiEnabled: tui,
        },
      },
      hermesImageRef,
    ),
  });
}

function explicitOpenClawDefaultsSnapshot() {
  return tunedSnapshot({
    NEMOCLAW_CONTEXT_WINDOW: "131072",
    NEMOCLAW_MAX_TOKENS: "4096",
    NEMOCLAW_REASONING: "false",
    NEMOCLAW_REASONING_EFFORT: "default",
    NEMOCLAW_AGENT_TIMEOUT: "600",
  });
}

describe("effective v1alpha1 export defaults (#12132)", () => {
  it("preserves source values whether their startup inputs were explicit or omitted", async () => {
    const baseline = await exportSnapshots([snapshot()]);
    const explicit = await exportSnapshots([explicitOpenClawDefaultsSnapshot()]);
    expect(explicit.outcome.ok).toBe(true);
    expect(explicit.writeStdout.mock.calls).toEqual(baseline.writeStdout.mock.calls);
    const config = asExportedConfig(YAML.parse(explicit.writeStdout.mock.calls[0]![0]));
    const sandbox = config.spec.sandboxes[0]!;
    expect(sandbox.agent.inference.routes[0]!.overrides).toEqual({
      model: "gpt-5",
      contextWindow: 131072,
    });
    expect(sandbox.harness).toEqual({
      kind: "openclaw",
      interfaces: { dashboard: { port: 18789 } },
    });
    expect(sandbox).not.toHaveProperty("image");
  });

  it.runIf(process.env.NEMOCLAW_RUN_V1_CONFIG_COMPATIBILITY === "1")(
    "preserves defaults through the pinned v1 parser and native agent generation (#12132)",
    testTimeoutOptions(12 * 60_000),
    async () => {
      const sources = [
        { name: "openclaw-defaults", source: snapshot() },
        { name: "openclaw-explicit", source: explicitOpenClawDefaultsSnapshot() },
        { name: "hermes-disabled", source: hermesSnapshot() },
        {
          name: "hermes-defaults",
          source: enabledHermesSnapshot(18_789, 19_119, true, 8642),
        },
        {
          name: "hermes-explicit",
          source: enabledHermesSnapshot(19_000, 19_120, false, 8643),
        },
      ] as const;
      const exports = await Promise.all(sources.map(({ source }) => exportSnapshots([source])));
      expect(exports.every((result) => result.outcome.ok)).toBe(true);
      const document = asExportedConfig(YAML.parse(exports[0]!.writeStdout.mock.calls[0]![0]));
      const combined = {
        ...document,
        spec: {
          ...document.spec,
          sandboxes: exports.map((result, index) => ({
            ...asExportedConfig(YAML.parse(result.writeStdout.mock.calls[0]![0])).spec
              .sandboxes[0]!,
            name: sources[index]!.name,
          })),
        },
      };
      expect(validateConfigExportWithPinnedV1(YAML.stringify(combined))).toEqual({
        revision: "42a26d90f1f6207cc35b5053556db67c86ce759f",
        compiledSandboxes: 5,
        contextWindows: [131072, 131072],
        hermesNativeSettings: {
          "hermes-disabled": {
            apiPort: 8642,
            dashboard: {
              enabled: false,
              port: 18789,
              internalPort: 19119,
              tui: { enabled: true },
            },
          },
          "hermes-defaults": {
            apiPort: 8642,
            dashboard: {
              enabled: true,
              port: 18789,
              internalPort: 19119,
              tui: { enabled: true },
            },
          },
          "hermes-explicit": {
            apiPort: 8643,
            dashboard: {
              enabled: true,
              port: 19000,
              internalPort: 19120,
              tui: { enabled: false },
            },
          },
        },
        openclawNativeSettings: {
          "openclaw-defaults": {
            model: { contextWindow: 131072, maxTokens: 4096, reasoning: false },
            reasoningEffort: "default",
            execution: { timeoutSeconds: 600, heartbeatEvery: null },
            dashboard: { enabled: true, port: 18789, bind: "loopback" },
            toolDisclosure: "progressive",
          },
          "openclaw-explicit": {
            model: { contextWindow: 131072, maxTokens: 4096, reasoning: false },
            reasoningEffort: "default",
            execution: { timeoutSeconds: 600, heartbeatEvery: null },
            dashboard: { enabled: true, port: 18789, bind: "loopback" },
            toolDisclosure: "progressive",
          },
        },
        openclawNativeSettingsVerified: 2,
        hermesNativeSettingsVerified: 3,
      });
    },
  );
});

describe("web-search v1alpha1 consumer compatibility (#12138)", () => {
  it.runIf(process.env.NEMOCLAW_RUN_V1_CONFIG_COMPATIBILITY === "1").each([
    {
      name: "OpenClaw Brave",
      source: braveSnapshot(),
      provider: "brave",
      credentialReference: "BRAVE_API_KEY",
    },
    {
      name: "OpenClaw Tavily",
      source: tavilySnapshot("openclaw"),
      provider: "tavily",
      credentialReference: "TAVILY_API_KEY",
    },
    {
      name: "Hermes Tavily",
      source: tavilySnapshot("hermes"),
      provider: "tavily",
      credentialReference: "TAVILY_API_KEY",
    },
  ] as const)(
    "preserves $name provider, credential reference and grants through the pinned consumer (#12138)",
    testTimeoutOptions(12 * 60_000),
    async ({ source, provider, credentialReference }) => {
      const exported = await exportSnapshots([source]);
      expect(exported.outcome.ok).toBe(true);
      const raw = exported.writeStdout.mock.calls[0]![0];
      const evidence = validateConfigExportWithPinnedV1(raw);
      expect(evidence.revision).toBe("42a26d90f1f6207cc35b5053556db67c86ce759f");
      expect(evidence.compiledSandboxes).toBe(1);
      expect(evidence.webSearch).toEqual({
        alpha: { provider, credentialReference, agentRefs: ["primary"], nativeProvider: provider },
      });
    },
  );
});
