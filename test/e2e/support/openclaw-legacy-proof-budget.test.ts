// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  LEGACY_MIGRATION_PROOF_OUTER_TIMEOUT_MS,
  LEGACY_MIGRATION_PROOF_TIMEOUT_MS,
  proveRealLegacyMigrationBridges,
  runLegacyMigrationProofCommand,
  type LegacyMigrationProofOptions,
} from "../../helpers/openclaw-real-legacy-migration-proof.ts";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

let options: LegacyMigrationProofOptions;
let clock: number;

beforeEach(() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-proof-budget-"));
  options = {
    home,
    nodeExecutable: process.execPath,
    runtime95: path.join(home, "native95"),
    runtime97: path.join(home, "native97"),
    targetRuntime: path.join(home, "native105"),
  };
  clock = 100;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.mocked(spawnSync).mockReturnValue({
    pid: 0,
    status: 0,
    signal: null,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(options.home, { recursive: true, force: true });
});

it("uses the remaining proof budget without extending a command limit", () => {
  const deadline = clock + 1_000;
  runLegacyMigrationProofCommand(options, ["first"], 300, deadline);
  clock += 900;
  runLegacyMigrationProofCommand(options, ["second"], 300, deadline);
  expect(vi.mocked(spawnSync).mock.calls.map((call) => call[2]?.timeout)).toEqual([300, 100]);
});

it("refuses to start another command after the proof deadline", () => {
  expect(() => runLegacyMigrationProofCommand(options, ["late"], 300, clock)).toThrow(
    "exhausted its shared deadline",
  );
  expect(spawnSync).not.toHaveBeenCalled();
});

it.skipIf(process.platform === "win32")(
  "retains timeout output before throwing and kills the owned POSIX process group",
  () => {
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    vi.mocked(spawnSync).mockReturnValue({
      pid: 42_001,
      status: null,
      signal: "SIGKILL",
      error: Object.assign(new Error("fixture timeout"), { code: "ETIMEDOUT" }),
      output: [null, "fixture progress", "fixture timeout details"],
      stdout: "fixture progress",
      stderr: "fixture timeout details",
    });
    expect(() => runLegacyMigrationProofCommand(options, ["slow"], 300, clock + 200)).toThrow(
      "failed to finish",
    );
    expect(fs.readFileSync(path.join(options.home, "last-native-command.log"), "utf8")).toBe(
      "fixture progress\nfixture timeout details",
    );
    expect(kill).toHaveBeenCalledWith(-42_001, "SIGKILL");
  },
);

it("keeps a native refusal status available to the negative migration assertions", () => {
  vi.mocked(spawnSync).mockReturnValue({
    pid: 0,
    status: 43,
    signal: null,
    output: [null, "", "retired state refused"],
    stdout: "",
    stderr: "retired state refused",
  });
  expect(runLegacyMigrationProofCommand(options, ["refuse"], 300, clock + 500)).toBe(43);
});

it("publishes bounded synthetic diagnostics before the caller removes a failed fixture", () => {
  fs.mkdirSync(options.runtime95);
  fs.writeFileSync(
    path.join(options.runtime95, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.9.5" }),
  );
  fs.mkdirSync(options.runtime97);
  fs.writeFileSync(
    path.join(options.runtime97, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.9.7" }),
  );
  fs.mkdirSync(options.targetRuntime);
  fs.writeFileSync(
    path.join(options.targetRuntime, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.10.5" }),
  );
  const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  vi.mocked(spawnSync).mockReturnValue({
    pid: 0,
    status: null,
    signal: "SIGKILL",
    error: Object.assign(new Error("fixture timeout"), { code: "ETIMEDOUT" }),
    output: [null, "x".repeat(20_000), "synthetic failure tail"],
    stdout: "x".repeat(20_000),
    stderr: "synthetic failure tail",
  });
  expect(() => proveRealLegacyMigrationBridges(options)).toThrow("failed to finish");
  const diagnostics = write.mock.calls.map(([text]) => String(text)).join("");
  expect(diagnostics).toContain("synthetic failure tail");
  expect(diagnostics.length).toBeLessThan(17_000);
  expect(fs.existsSync(path.join(options.home, "last-native-command.log"))).toBe(true);
  expect(LEGACY_MIGRATION_PROOF_OUTER_TIMEOUT_MS).toBe(1_500_000);
  expect(LEGACY_MIGRATION_PROOF_TIMEOUT_MS).toBeLessThan(LEGACY_MIGRATION_PROOF_OUTER_TIMEOUT_MS);
});
