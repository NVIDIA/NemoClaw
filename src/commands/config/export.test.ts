// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  observeLiveExportSource: vi.fn(),
  buildExportConfig: vi.fn(),
  renderCanonicalNemoClawConfig: vi.fn(),
  publishExportFile: vi.fn(),
}));

vi.mock("../../lib/config/canonical", () => ({
  renderCanonicalNemoClawConfig: mocks.renderCanonicalNemoClawConfig,
}));
vi.mock("../../lib/config/export-builder", () => ({ buildExportConfig: mocks.buildExportConfig }));
vi.mock("../../lib/config/output", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/config/output")>()),
  publishExportFile: mocks.publishExportFile,
}));
vi.mock("../../lib/config/export-live-adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/config/export-live-adapters")>()),
  observeLiveExportSource: mocks.observeLiveExportSource,
}));

import ConfigExportCommand from "./export";

describe("config export command", () => {
  beforeEach(() => {
    mocks.observeLiveExportSource.mockReset().mockResolvedValue({ sandboxName: "alpha" });
    mocks.buildExportConfig.mockReset().mockReturnValue({ kind: "NemoClawConfig" });
    mocks.renderCanonicalNemoClawConfig.mockReset().mockReturnValue({
      yaml: "kind: NemoClawConfig\n",
      documentDigest: "sha256:document",
      specDigest: "sha256:spec",
    });
    mocks.publishExportFile.mockReset().mockReturnValue({ path: "/tmp/alpha.yaml" });
  });
  afterEach(() => {
    process.exitCode = 0;
  });

  it("composes live observation through canonical YAML stdout (#10938)", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(
      ConfigExportCommand.run(["alpha", "--output", "-"], process.cwd()),
    ).resolves.toBeUndefined();
    expect(mocks.observeLiveExportSource).toHaveBeenCalledWith("alpha");
    expect(mocks.buildExportConfig).toHaveBeenCalledWith({ sandboxName: "alpha" }, "alpha");
    expect(write).toHaveBeenCalledWith("kind: NemoClawConfig\n");
    expect(mocks.publishExportFile).not.toHaveBeenCalled();
  });

  it("rejects JSON on YAML stdout before reading source state (#10938)", async () => {
    await expect(
      ConfigExportCommand.run(["alpha", "--output", "-", "--json"], process.cwd()),
    ).resolves.toBeUndefined();
    expect(mocks.observeLiveExportSource).not.toHaveBeenCalled();
  });

  it("rejects an invalid document name before reading source state (#10938)", async () => {
    await expect(
      ConfigExportCommand.run(["alpha", "--output", "-", "--name", "Not Valid"], process.cwd()),
    ).rejects.toThrow("config name is invalid");
    expect(mocks.observeLiveExportSource).not.toHaveBeenCalled();
  });

  it("provides short and long command help without reading source state (#10938)", async () => {
    await expect(ConfigExportCommand.run(["alpha", "--help"], process.cwd())).rejects.toMatchObject(
      {
        code: "EEXIT",
        oclif: { exit: 0 },
      },
    );
    await expect(ConfigExportCommand.run(["alpha", "-h"], process.cwd())).rejects.toMatchObject({
      code: "EEXIT",
      oclif: { exit: 0 },
    });
    expect(mocks.observeLiveExportSource).not.toHaveBeenCalled();
  });

  it("composes live observation through file publication and JSON result (#10938)", async () => {
    await expect(
      ConfigExportCommand.run(["alpha", "--output", "/tmp/alpha.yaml", "--json"], process.cwd()),
    ).resolves.toMatchObject({
      status: "succeeded",
      sourceSandbox: "alpha",
      outputPath: "/tmp/alpha.yaml",
      documentDigest: "sha256:document",
      specDigest: "sha256:spec",
    });
    expect(mocks.publishExportFile).toHaveBeenCalledWith(
      "/tmp/alpha.yaml",
      "kind: NemoClawConfig\n",
      false,
    );
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
