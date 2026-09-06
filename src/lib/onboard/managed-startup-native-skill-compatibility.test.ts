// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMock = vi.hoisted(() => ({
  spawnSync: vi.fn(),
}));
vi.mock("node:child_process", () => childProcessMock);

import { applyManagedStartupNativeSkillCompatibility } from "./managed-startup/image-runtime";

describe("managed startup native skill compatibility", () => {
  beforeEach(() => {
    childProcessMock.spawnSync.mockReset().mockReturnValue({ error: undefined, status: 0 });
  });

  it.each([
    ["openclaw", "/usr/local/bin/node", "scripts/openclaw/patch-skill-remove.mts"],
    ["hermes", "/usr/bin/python3", "agents/hermes/patch-native-skill-import.py"],
    [
      "langchain-deepagents-code",
      "/opt/venv/bin/python3",
      "agents/langchain-deepagents-code/patch-native-skill-import.py",
    ],
  ] as const)(
    "applies %s native skill compatibility through managed onboarding",
    (agent, executable, sourcePath) => {
      expect(
        applyManagedStartupNativeSkillCompatibility(
          agent,
          {},
          { exportEnvironment: {}, unsetEnvironment: [] },
        ),
      ).toBe(true);
      expect(childProcessMock.spawnSync).toHaveBeenCalledWith(
        executable,
        expect.arrayContaining([expect.stringContaining(sourcePath)]),
        expect.objectContaining({
          killSignal: "SIGKILL",
          stdio: "inherit",
          timeout: 30_000,
        }),
      );
    },
  );

  it("does not invent native skill compatibility for Pi", () => {
    expect(
      applyManagedStartupNativeSkillCompatibility(
        "pi",
        {},
        { exportEnvironment: {}, unsetEnvironment: [] },
      ),
    ).toBe(false);
    expect(childProcessMock.spawnSync).not.toHaveBeenCalled();
  });

  it("terminates a stalled native skill compatibility patch", () => {
    childProcessMock.spawnSync.mockReturnValueOnce({
      error: Object.assign(new Error("spawnSync timed out"), { code: "ETIMEDOUT" }),
      signal: "SIGKILL",
      status: null,
    });

    expect(() =>
      applyManagedStartupNativeSkillCompatibility(
        "hermes",
        {},
        { exportEnvironment: {}, unsetEnvironment: [] },
      ),
    ).toThrow(
      "Managed startup native skill compatibility for 'hermes' did not complete within 30 seconds and was terminated; repair or rebuild the sandbox before retrying.",
    );
    expect(childProcessMock.spawnSync).toHaveBeenCalledWith(
      "/usr/bin/python3",
      expect.any(Array),
      expect.objectContaining({ killSignal: "SIGKILL", timeout: 30_000 }),
    );
  });
});
