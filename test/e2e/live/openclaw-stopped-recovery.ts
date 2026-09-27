// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { shellQuote } from "../../../src/lib/core/shell-quote.ts";
import { waitUntilAsync } from "../../../src/lib/core/wait.ts";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertExitZero } from "../fixtures/clients/command.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import type { RuntimeProviderPrerequisite } from "../fixtures/runtime-provider.ts";

/** Live 0.0.116 regression: a dead source must retain data and restore usable agent state. */
export async function proveKilledDockerOpenClawRecovery(
  sandbox: SandboxClient,
  runtime: RuntimeProviderPrerequisite,
  artifacts: ArtifactSink,
  sandboxName: string,
  rebuildAndProveState: () => Promise<void>,
  restorationProof: "provider-backed-mcp" | "native-readiness",
): Promise<void> {
  if (
    runtime.id !== "docker" ||
    process.env.NEMOCLAW_EXPERIMENTAL_PROFILE ||
    process.env.E2E_TARGET_ID === "mcp-bridge-dev"
  ) {
    await artifacts.writeJson("openclaw-stopped-source-recovery.json", {
      applicable: false,
      reason: "This added compatibility proof owns the pinned native Docker OpenClaw target.",
    });
    return;
  }
  assert(sandboxName.startsWith("e2e-"), "Container disruption requires a test-owned sandbox name");
  const gateway = process.env.OPENSHELL_GATEWAY ?? "nemoclaw";
  const env = buildAvailabilityProbeEnv();
  let observation = 0;
  const readSource = async (): Promise<{ id: string; phase: string }> => {
    const result = await sandbox.openshell(["sandbox", "list", "-g", gateway, "-o", "json"], {
      artifactName: `openclaw-stopped-source-observation-${observation++}`,
      env,
      timeoutMs: 10_000,
    });
    assertExitZero(result, "observe the test-owned sandbox lifecycle");
    const rows = JSON.parse(result.stdout) as Array<{ id: string; name: string; phase: string }>;
    const selected = rows.filter((row) => row.name === sandboxName);
    assert.equal(selected.length, 1);
    return selected[0]!;
  };
  const source = await readSource();
  assert(typeof source.id === "string" && /^[A-Za-z0-9._-]{1,512}$/u.test(source.id));
  assert.equal(source.phase, "Ready");
  const container = await runtime.resolveSandboxResourceHandle(sandboxName, {
    artifactName: "openclaw-stopped-source-container",
  });
  assert.match(container, /^[a-f0-9]{64}$/u);
  const identity = await runtime.command(
    [
      "inspect",
      "--type",
      "container",
      "--format",
      "[{{json .Id}},{{json .Config.Labels}},{{json .State.Running}}]",
      container,
    ],
    { artifactName: "openclaw-stopped-source-identity" },
  );
  assertExitZero(identity, "verify the exact runtime before fault injection");
  const [observedId, labels, running] = JSON.parse(identity.stdout);
  assert.equal(observedId, container);
  assert.equal(labels["openshell.ai/managed-by"], "openshell");
  assert.equal(labels["openshell.ai/sandbox-name"], sandboxName);
  assert.equal(labels["openshell.ai/sandbox-id"], source.id);
  assert.equal(running, true);
  const marker = `stopped-source-${Date.now()}`;
  const markerPath = "/sandbox/.openclaw/workspace/.stopped-recovery-marker";
  assertExitZero(
    await sandbox.exec(
      sandboxName,
      [
        "sh",
        "-c",
        `umask 077; printf '%s' ${shellQuote(marker)} > ${shellQuote(markerPath)}; sync`,
      ],
      { artifactName: "openclaw-stopped-source-write-marker", env },
    ),
    "write stopped-recovery marker",
  );
  assertExitZero(
    await runtime.command(["kill", container], {
      artifactName: "openclaw-stopped-source-kill",
      timeoutMs: 30_000,
    }),
    "kill the identified test container once",
  );
  const terminal = await waitUntilAsync(
    async () => {
      const current = await readSource();
      assert.equal(current.id, source.id, "The source identity changed while awaiting Error");
      return current.phase === "Error";
    },
    { deadlineMs: Date.now() + 60_000, initialIntervalMs: 1_000, maxAttempts: 30 },
  );
  assert(terminal, "OpenShell did not report the killed source as Error");
  await rebuildAndProveState();
  const replacement = await runtime.resolveSandboxResourceHandle(sandboxName, {
    artifactName: "openclaw-stopped-replacement-container",
  });
  assert.notEqual(replacement, container);
  const restored = await sandbox.exec(sandboxName, ["cat", markerPath], {
    artifactName: "openclaw-stopped-source-restored-marker",
    env,
  });
  assertExitZero(restored, "read restored workspace state");
  assert.equal(restored.stdout.trim(), marker);
  await artifacts.writeJson("openclaw-stopped-source-recovery.json", {
    applicable: true,
    sourceContainerId: container,
    replacementContainerId: replacement,
    sourcePhase: "Error",
    workspacePreserved: true,
    restorationProof,
  });
}
