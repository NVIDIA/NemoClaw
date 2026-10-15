// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, expect, it, vi } from "vitest";
import { run } from "../runner";
import { startNimContainerByName } from "./nim";

vi.mock("../runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runner")>()),
  run: vi.fn(),
}));

const runMock = vi.mocked(run);
const commandResult = (status: number, stdout = "") =>
  ({ status, stdout: Buffer.from(stdout) }) as ReturnType<typeof run>;
const start = () =>
  startNimContainerByName("nemoclaw-nim-test", "nvidia/nemotron-3-nano-30b-a3b", 8000, {
    ngcApiKey: "nvapi-abc123",
  });

beforeEach(() => runMock.mockReset());

it("removes the named NIM container after an invalid launch receipt", () => {
  runMock
    .mockReturnValueOnce(commandResult(0))
    .mockReturnValueOnce(commandResult(0, "invalid-id\n"))
    .mockReturnValueOnce(commandResult(0));

  expect(start).toThrow("Docker did not return a verifiable ID");
  expect(runMock.mock.calls.map(([argv]) => argv.slice(0, 3))).toEqual([
    ["docker", "rm", "-f"],
    ["docker", "run", "-d"],
    ["docker", "rm", "-f"],
  ]);
  expect(runMock.mock.calls[2]?.[0]).toEqual(["docker", "rm", "-f", "nemoclaw-nim-test"]);
});

it("reports failed cleanup after an invalid NIM launch receipt", () => {
  runMock
    .mockReturnValueOnce(commandResult(0))
    .mockReturnValueOnce(commandResult(0))
    .mockReturnValueOnce(commandResult(1));

  expect(start).toThrow(/Cleanup failed: docker rm -f exited with status 1/);
  expect(runMock.mock.calls[2]?.[0]).toEqual(["docker", "rm", "-f", "nemoclaw-nim-test"]);
});
