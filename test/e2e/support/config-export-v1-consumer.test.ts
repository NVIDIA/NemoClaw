// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { exportSnapshots } from "../../../src/lib/actions/config/export-test-fixture.ts";
import {
  getHermesDashboardRegistryFields,
  resolveHermesDashboardOnboardState,
} from "../../../src/lib/onboard/hermes-dashboard.ts";
import {
  hermesImageRef,
  hermesProfileInput,
  hermesSnapshot,
  managedWorkload,
  snapshot,
  tunedSnapshot,
} from "../../../src/lib/domain/config/export-source-test-fixture.ts";
import { testTimeoutOptions } from "../../helpers/timeouts.ts";
import { validateWithRevisionMatchedV1Consumer } from "./v1-config-consumer.ts";

async function rawExport(source: ReturnType<typeof snapshot>): Promise<string> {
  const exported = await exportSnapshots([source]);
  expect(exported.outcome.ok).toBe(true);
  return exported.writeStdout.mock.calls[0]![0];
}

function hermesTuiDisabledSnapshot() {
  const state = resolveHermesDashboardOnboardState({
    agentName: "hermes",
    effectivePort: 18_789,
    env: {
      NEMOCLAW_HERMES_DASHBOARD: "1",
      NEMOCLAW_DASHBOARD_PORT: "18789",
      NEMOCLAW_HERMES_DASHBOARD_PORT: "18789",
      NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT: "19119",
      NEMOCLAW_HERMES_DASHBOARD_TUI: "0",
    },
  });
  return hermesSnapshot({
    ...getHermesDashboardRegistryFields(state),
    dashboardPort: 18_789,
    hermesApiPort: 8642,
    workload: managedWorkload(
      {
        ...hermesProfileInput(),
        dashboard: {
          agent: "hermes",
          mode: "loopback-forwarded",
          url: "http://127.0.0.1:18789",
          browserUrl: "http://127.0.0.1:18789",
          publicPort: 18_789,
          internalPort: 19_119,
          tuiEnabled: false,
        },
      },
      hermesImageRef,
    ),
  });
}

describe("revision-matched v1 config consumer", () => {
  it(
    "preserves exported defaults through parsing and native generation (#12132)",
    testTimeoutOptions(12 * 60 * 1_000),
    async () => {
      const openclaw = await rawExport(snapshot());
      const openclawExplicit = await rawExport(
        tunedSnapshot({
          NEMOCLAW_CONTEXT_WINDOW: "131072",
          NEMOCLAW_MAX_TOKENS: "4096",
          NEMOCLAW_REASONING: "false",
          NEMOCLAW_REASONING_EFFORT: "default",
          NEMOCLAW_AGENT_TIMEOUT: "600",
        }),
      );
      const hermesDisabled = await rawExport(hermesSnapshot());
      const hermesTuiDisabled = await rawExport(hermesTuiDisabledSnapshot());
      const openClawSource = {
        contextWindow: 131_072,
        maxTokens: 4096,
        reasoning: false,
        timeoutSeconds: 600,
        heartbeatPresent: false,
        dashboardEnabled: true,
        dashboardPort: 18_789,
        dashboardBind: "loopback",
        toolDisclosure: "progressive",
        explicitAgentOwnership: true,
        thinkingDefaultPresent: false,
      };
      const evidence = validateWithRevisionMatchedV1Consumer([
        {
          name: "openclaw",
          harness: "openclaw",
          raw: openclaw,
          agentName: "primary",
          source: openClawSource,
        },
        {
          name: "openclaw-explicit-source",
          harness: "openclaw",
          raw: openclawExplicit,
          agentName: "primary",
          source: openClawSource,
        },
        {
          name: "hermes-disabled",
          harness: "hermes",
          raw: hermesDisabled,
          source: {
            apiPort: 8642,
            dashboard: {
              enabled: false,
              port: 18_789,
              internalPort: 19_119,
              tui: { enabled: true },
            },
          },
        },
        {
          name: "hermes-tui-disabled",
          harness: "hermes",
          raw: hermesTuiDisabled,
          source: {
            apiPort: 8642,
            dashboard: {
              enabled: true,
              port: 18_789,
              internalPort: 19_119,
              tui: { enabled: false },
            },
          },
        },
      ]);

      expect(evidence.revision).toBe("88c6600c06b0937907290362eef86912052c4ad0");
      expect(evidence.documents).toHaveLength(4);
      expect(evidence.documents.map(({ harness, sha256 }) => ({ harness, sha256 }))).toEqual(
        [
          ["openclaw", openclaw],
          ["openclaw", openclawExplicit],
          ["hermes", hermesDisabled],
          ["hermes", hermesTuiDisabled],
        ].map(([harness, raw]) => ({
          harness,
          sha256: createHash("sha256").update(raw).digest("hex"),
        })),
      );
    },
  );
});
