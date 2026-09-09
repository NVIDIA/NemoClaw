// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  snapshotReader: { read: vi.fn() },
  createLiveExportSnapshotReader: vi.fn(),
  observeStableExportSource: vi.fn(),
  buildExportConfig: vi.fn(),
  renderCanonicalNemoClawConfig: vi.fn(),
  validateNemoClawConfig: vi.fn(),
  publishExportFile: vi.fn(),
}));

vi.mock("../../lib/config/canonical", () => ({
  renderCanonicalNemoClawConfig: mocks.renderCanonicalNemoClawConfig,
}));
vi.mock("../../lib/domain/config/export-document", () => ({
  buildExportConfig: mocks.buildExportConfig,
}));
vi.mock("../../lib/config/schema", () => ({
  validateNemoClawConfig: mocks.validateNemoClawConfig,
}));
vi.mock("../../lib/adapters/fs/config-export-file", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/adapters/fs/config-export-file")>()),
  publishExportFile: mocks.publishExportFile,
}));
vi.mock("../../lib/adapters/config/live-export-source", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/adapters/config/live-export-source")>()),
  createLiveExportSnapshotReader: mocks.createLiveExportSnapshotReader,
}));
vi.mock("../../lib/actions/config/observe-export-source", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/actions/config/observe-export-source")>()),
  observeStableExportSource: mocks.observeStableExportSource,
}));

import { Check } from "typebox/value";
import { ConfigExportResultSchema } from "../../lib/actions/config/export";
import ConfigExportCommand from "./export";

const documentDigest = "sha256:" + "a".repeat(64);
const specDigest = "sha256:" + "b".repeat(64);

describe("config export command", () => {
  beforeEach(() => {
    mocks.createLiveExportSnapshotReader.mockReset().mockReturnValue(mocks.snapshotReader);
    mocks.observeStableExportSource.mockReset().mockResolvedValue({
      ok: true,
      source: { sandboxName: "alpha" },
      attempts: 1,
    });
    mocks.buildExportConfig.mockReset().mockReturnValue({ kind: "NemoClawConfig" });
    mocks.validateNemoClawConfig.mockReset().mockReturnValue({ kind: "NemoClawConfig" });
    mocks.renderCanonicalNemoClawConfig.mockReset().mockReturnValue({
      yaml: "kind: NemoClawConfig\n",
      documentDigest,
      specDigest,
    });
    mocks.publishExportFile
      .mockReset()
      .mockReturnValue({ ok: true, outputPath: "/tmp/alpha.yaml" });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it("composes live observation through canonical YAML stdout (#10938)", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((
      _: string,
      callback?: (error?: Error | null) => void,
    ) => {
      callback?.();
      return true;
    }) as typeof process.stdout.write);
    await expect(
      ConfigExportCommand.run(["alpha", "--output", "-", "--name", "team.alpha"], process.cwd()),
    ).resolves.toBeUndefined();
    expect(mocks.observeStableExportSource).toHaveBeenCalledWith("alpha", mocks.snapshotReader);
    expect(mocks.buildExportConfig).toHaveBeenCalledWith(
      { sandboxName: "alpha" },
      expect.objectContaining({ documentName: "team.alpha", documentUid: expect.any(String) }),
    );
    expect(write).toHaveBeenCalledWith("kind: NemoClawConfig\n", expect.any(Function));
    expect(mocks.publishExportFile).not.toHaveBeenCalled();
  });

  it("rejects JSON on YAML stdout before reading source state (#10938)", async () => {
    await expect(
      ConfigExportCommand.run(["alpha", "--output", "-", "--json"], process.cwd()),
    ).resolves.toBeUndefined();
    expect(mocks.observeStableExportSource).not.toHaveBeenCalled();
  });

  it("rejects force on YAML stdout before reading source state (#10938)", async () => {
    await expect(
      ConfigExportCommand.run(["alpha", "--output", "-", "--force"], process.cwd()),
    ).rejects.toThrow("--force cannot be used when --output is stdout (-)");
    expect(mocks.observeStableExportSource).not.toHaveBeenCalled();
  });

  it("rejects an invalid document name before reading source state (#10938)", async () => {
    await expect(
      ConfigExportCommand.run(["alpha", "--output", "-", "--name", "Not Valid"], process.cwd()),
    ).rejects.toThrow("config name is invalid");
    expect(mocks.observeStableExportSource).not.toHaveBeenCalled();
  });

  it("displays a returned observation failure without building the document", async () => {
    mocks.observeStableExportSource.mockResolvedValue({
      ok: false,
      findings: [
        {
          field: "source.registry",
          category: "not-found",
          diagnostic: "The sandbox was not found.",
        },
      ],
      attempts: 1,
    });

    await expect(
      ConfigExportCommand.run(["alpha", "--output", "-"], process.cwd()),
    ).rejects.toThrow("Config export failed (not-found).\nThe sandbox was not found.");
    expect(mocks.buildExportConfig).not.toHaveBeenCalled();
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
    expect(mocks.observeStableExportSource).not.toHaveBeenCalled();
  });

  it("composes live observation through file publication and JSON result (#10938)", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await ConfigExportCommand.run(
      ["alpha", "--output", "/tmp/alpha.yaml", "--json"],
      process.cwd(),
    );
    expect(result).toEqual({
      version: 1,
      status: "succeeded",
      sourceSandbox: "alpha",
      outputPath: "/tmp/alpha.yaml",
      documentDigest,
      specDigest,
    });
    expect(log).toHaveBeenCalledTimes(1);
    const emitted: unknown = JSON.parse(log.mock.calls[0]![0]);
    expect(Check(ConfigExportResultSchema, emitted)).toBe(true);
    expect(emitted).toEqual(result);
    expect(mocks.publishExportFile).toHaveBeenCalledWith(
      "/tmp/alpha.yaml",
      "kind: NemoClawConfig\n",
      false,
    );
  });

  it.each([
    {
      name: "conflicting",
      failure: {
        category: "output-conflict",
        fileState: { publication: "not-published", stagingCleanup: "complete" },
        stagingReference: null,
      },
      diagnostic: "Config export failed (output-conflict): The output path already exists.",
    },
    {
      name: "uncertain",
      failure: {
        category: "unsafe-output",
        fileState: { publication: "unknown", stagingCleanup: "complete" },
        stagingReference: null,
      },
      diagnostic:
        "Config export failed (unsafe-output): The export may have been written, but its publication state could not be confirmed.",
    },
  ] as const)(
    "displays a $name publication failure without the requested path",
    async ({ failure, diagnostic }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      mocks.publishExportFile.mockReturnValue({ ok: false, failure });
      const result = await ConfigExportCommand.run(
        ["alpha", "--output", "/private/raw-path.yaml"],
        process.cwd(),
      ).catch((caught: unknown) => caught);
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain(diagnostic);
      expect((result as Error).message).not.toContain("/private/raw-path.yaml");
    },
  );

  it("declares the required output and safe replacement flags (#10938)", () => {
    expect(ConfigExportCommand.flags).toMatchObject({
      output: { char: "o", required: true },
      name: {},
      force: { default: false },
    });
  });
});
