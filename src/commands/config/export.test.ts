// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ observeLiveExportSource: vi.fn() }));

vi.mock("../../lib/config/export-live-adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/config/export-live-adapters")>()),
  observeLiveExportSource: mocks.observeLiveExportSource,
}));

import ConfigExportCommand from "./export";

describe("config export command", () => {
  beforeEach(() => {
    mocks.observeLiveExportSource.mockReset();
  });

  it("rejects JSON on YAML stdout before reading source state (#10938)", async () => {
    await expect(
      ConfigExportCommand.run(["alpha", "--output", "-", "--json"], process.cwd()),
    ).resolves.toBeUndefined();
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(mocks.observeLiveExportSource).not.toHaveBeenCalled();
  });

  it("rejects an invalid document name before reading source state (#10938)", async () => {
    await expect(
      ConfigExportCommand.run(["alpha", "--output", "-", "--name", "Not Valid"], process.cwd()),
    ).rejects.toThrow("config name is invalid");
    expect(mocks.observeLiveExportSource).not.toHaveBeenCalled();
  });

  it("declares the required output and safe replacement flags (#10938)", () => {
    expect(ConfigExportCommand.flags).toMatchObject({
      output: { char: "o", required: true },
      name: {},
      force: { default: false },
    });
    expect(ConfigExportCommand.flags.json).toMatchObject({ default: false });
  });
});
