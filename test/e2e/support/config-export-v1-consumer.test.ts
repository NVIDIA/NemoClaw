// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

const childProcess = vi.hoisted(() => ({
  actualExecFileSync: undefined as typeof execFileSync | undefined,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  childProcess.actualExecFileSync = actual.execFileSync;
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

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
import {
  RevisionMatchedConsumerError,
  revisionMatchedConsumerInputFromLiveSource,
  validateWithRevisionMatchedV1Consumer,
} from "../fixtures/revision-matched-v1-consumer.ts";

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
      const openclawSource = snapshot();
      const openclaw = await rawExport(openclawSource);
      const openclawExplicitSource = tunedSnapshot({
        NEMOCLAW_CONTEXT_WINDOW: "131072",
        NEMOCLAW_MAX_TOKENS: "4096",
        NEMOCLAW_REASONING: "false",
        NEMOCLAW_REASONING_EFFORT: "default",
        NEMOCLAW_AGENT_TIMEOUT: "600",
      });
      const openclawExplicit = await rawExport(openclawExplicitSource);
      const openclawTunedSource = tunedSnapshot();
      const openclawTuned = await rawExport(openclawTunedSource);
      const hermesDisabledSource = hermesSnapshot();
      const hermesDisabled = await rawExport(hermesDisabledSource);
      const hermesTuiDisabledSource = hermesTuiDisabledSnapshot();
      const hermesTuiDisabled = await rawExport(hermesTuiDisabledSource);
      const evidence = validateWithRevisionMatchedV1Consumer([
        revisionMatchedConsumerInputFromLiveSource(openclaw, openclawSource.registry),
        revisionMatchedConsumerInputFromLiveSource(
          openclawExplicit,
          openclawExplicitSource.registry,
        ),
        revisionMatchedConsumerInputFromLiveSource(openclawTuned, openclawTunedSource.registry),
        revisionMatchedConsumerInputFromLiveSource(hermesDisabled, hermesDisabledSource.registry),
        revisionMatchedConsumerInputFromLiveSource(
          hermesTuiDisabled,
          hermesTuiDisabledSource.registry,
        ),
      ]);

      expect(evidence.revision).toBe("88c6600c06b0937907290362eef86912052c4ad0");
      expect(evidence.documents).toHaveLength(5);
      expect(evidence.documents.map(({ harness, sha256 }) => ({ harness, sha256 }))).toEqual(
        [
          ["openclaw", openclaw],
          ["openclaw", openclawExplicit],
          ["openclaw", openclawTuned],
          ["hermes", hermesDisabled],
          ["hermes", hermesTuiDisabled],
        ].map(([harness, raw]) => ({
          harness,
          sha256: createHash("sha256").update(raw).digest("hex"),
        })),
      );
    },
  );

  it("removes the Cargo target directory when native validation fails (#12132)", async () => {
    const source = snapshot();
    const raw = await rawExport(source);
    let cargoTargetDirectory: string | undefined;
    vi.mocked(execFileSync)
      .mockImplementationOnce(childProcess.actualExecFileSync!)
      .mockImplementationOnce(childProcess.actualExecFileSync!)
      .mockImplementationOnce(
        (
          _file: string,
          _args: readonly string[] | undefined,
          options: ExecFileSyncOptions | undefined,
        ) => {
          cargoTargetDirectory = options?.env?.CARGO_TARGET_DIR;
          expect(cargoTargetDirectory).toEqual(expect.any(String));
          fs.mkdirSync(cargoTargetDirectory!, { recursive: true });
          fs.writeFileSync(path.join(cargoTargetDirectory!, "partial-build"), "incomplete");
          throw new Error("native validation failed");
        },
      );

    expect(() =>
      validateWithRevisionMatchedV1Consumer([
        revisionMatchedConsumerInputFromLiveSource(raw, source.registry),
      ]),
    ).toThrow(new RevisionMatchedConsumerError("cargo-test"));
    expect(cargoTargetDirectory).toEqual(expect.any(String));
    expect(fs.existsSync(cargoTargetDirectory!)).toBe(false);
  });
});
