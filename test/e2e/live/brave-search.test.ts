// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { resolveOpenshell } from "../../../src/lib/adapters/openshell/resolve.ts";
import {
  BRAVE_TEST_KEY,
  startBraveBackend,
  writeBraveEgressPreload,
} from "../fixtures/brave-backend.ts";
import { testTimeout } from "../../helpers/timeouts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import { trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";
import { prepareOwnedSandboxForOnboard } from "../fixtures/owned-sandbox-cleanup.ts";
import { BRAVE_AGENT_BOUNDARY, BRAVE_SHELL_BOUNDARY } from "./brave-search-helpers.ts";

const SANDBOX_NAME = "e2e-brave-search";

test(
  "Brave credentials stay outside the running OpenClaw process and login shell (#7425)",
  {
    timeout: testTimeout(35 * 60_000),
    meta: {
      e2ePhases: [
        "onboard Brave-enabled OpenClaw sandbox with synthetic credentials",
        "inspect OpenClaw agent command credential isolation",
        "inspect fresh login shell credential isolation",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox, secrets }) => {
    await artifacts.target.declare({
      id: "brave-search",
      boundary:
        "real OpenShell Brave provider attachment, agent /proc environment, and fresh login shell; mocked Brave HTTP",
      sandboxName: SANDBOX_NAME,
      contracts: [
        "production onboarding attaches Brave using a synthetic credential",
        "BRAVE_API_KEY is absent or an OpenShell placeholder in the OpenClaw agent command",
        "BRAVE_API_KEY is absent or an OpenShell placeholder in a fresh login shell",
      ],
    });
    await runtimeProvider.requireAvailable({
      artifactName: "runtime-info",
      scenarioLabel: "Brave credential isolation",
    });
    const inference = requireHostedInferenceConfig(secrets);
    const env = {
      ...buildAvailabilityProbeEnv(),
      ...inference.env,
      NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
      NEMOCLAW_AGENT: "openclaw",
      NEMOCLAW_NON_INTERACTIVE: "1",
      NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
      NEMOCLAW_WEB_SEARCH_PROVIDER: "brave",
      BRAVE_API_KEY: BRAVE_TEST_KEY,
      TAVILY_API_KEY: "",
      OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
    };
    const openshell = resolveOpenshell();
    assert(openshell, "OpenShell is required for Brave credential isolation");
    const backend = await startBraveBackend(200, true);
    cleanup.trackDisposable("remove Brave mock transport", backend.close);
    await prepareOwnedSandboxForOnboard(host, sandbox, cleanup, SANDBOX_NAME);
    const preload = writeBraveEgressPreload(backend.directory, openshell);
    const redactionValues = [BRAVE_TEST_KEY, inference.apiKey];

    progress.phase("onboard Brave-enabled OpenClaw sandbox with synthetic credentials");
    const onboard = await host.nemoclaw(
      ["onboard", "--fresh", "--non-interactive", "--yes-i-accept-third-party-software"],
      {
        artifactName: "onboard-synthetic-brave",
        env: {
          ...env,
          ...backend.env,
          NEMOCLAW_OPENSHELL_BIN: openshell,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(preload)}`,
        },
        redactionValues,
        timeoutMs: 25 * 60_000,
      },
    );
    expect(onboard.exitCode, resultText(onboard)).toBe(0);
    // These are fixture preconditions: a silently disabled provider cannot count
    // as isolation evidence. The optional egress probe runs only after a real
    // Brave-enabled config with a credential placeholder has been read back.
    expect(await backend.requests()).toEqual([
      { method: "GET", path: "/res/v1/web/search", query: "ping", count: "1", authenticated: true },
    ]);
    expect(fs.readFileSync(path.join(backend.directory, "brave-egress-blocked"), "utf8")).toBe(
      "blocked\n",
    );

    progress.phase("inspect OpenClaw agent command credential isolation");
    const agent = await sandbox.exec(SANDBOX_NAME, ["python3", "-c", BRAVE_AGENT_BOUNDARY], {
      artifactName: "openclaw-agent-brave-isolation",
      env,
      redactionValues,
      timeoutMs: 30_000,
    });
    expect(agent.exitCode, resultText(agent)).toBe(0);

    progress.phase("inspect fresh login shell credential isolation");
    const shell = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(BRAVE_SHELL_BOUNDARY),
      {
        artifactName: "login-shell-brave-isolation",
        env,
        redactionValues,
        timeoutMs: 60_000,
      },
    );
    expect(shell.exitCode, resultText(shell)).toBe(0);
  },
);
