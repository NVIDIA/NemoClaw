// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { YamlExportOutputError } from "../../lib/config/output";

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
    mocks.observeLiveExportSource.mockReset().mockResolvedValue({
      ok: true,
      source: { sandboxName: "alpha" },
      attempts: 1,
    });
    mocks.buildExportConfig.mockReset().mockReturnValue({ kind: "NemoClawConfig" });
    mocks.renderCanonicalNemoClawConfig.mockReset().mockReturnValue({
      yaml: "kind: NemoClawConfig\n",
      documentDigest: "sha256:document",
      specDigest: "sha256:spec",
    });
    mocks.publishExportFile.mockReset().mockReturnValue("/tmp/alpha.yaml");
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
    expect(mocks.observeLiveExportSource).toHaveBeenCalledWith("alpha");
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
    expect(mocks.observeLiveExportSource).not.toHaveBeenCalled();
  });

  it("rejects force on YAML stdout before reading source state (#10938)", async () => {
    await expect(
      ConfigExportCommand.run(["alpha", "--output", "-", "--force"], process.cwd()),
    ).rejects.toThrow("--force cannot be used when --output is stdout (-)");
    expect(mocks.observeLiveExportSource).not.toHaveBeenCalled();
  });

  it("rejects an invalid document name before reading source state (#10938)", async () => {
    await expect(
      ConfigExportCommand.run(["alpha", "--output", "-", "--name", "Not Valid"], process.cwd()),
    ).rejects.toThrow("config name is invalid");
    expect(mocks.observeLiveExportSource).not.toHaveBeenCalled();
  });

  it("displays a returned observation failure without building the document", async () => {
    mocks.observeLiveExportSource.mockResolvedValue({
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
    expect(mocks.observeLiveExportSource).not.toHaveBeenCalled();
  });

  it("composes live observation through file publication and JSON result (#10938)", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
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

  it.each([
    {
      name: "typed",
      error: new YamlExportOutputError(
        "output-conflict",
        "/private/raw-path.yaml",
        "CANARY: /private/raw-path.yaml",
      ),
      diagnostic: "Config export failed (output-conflict): The output path already exists.",
    },
    {
      name: "unknown",
      error: new Error("CANARY: /private/raw-path.yaml"),
      diagnostic:
        "Config export failed (unsafe-output): The export publication state could not be determined safely.",
    },
  ] as const)("displays a sanitized $name publication error", async ({ error, diagnostic }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    mocks.publishExportFile.mockImplementation(() => {
      throw error;
    });

    const result = await ConfigExportCommand.run(
      ["alpha", "--output", "/private/raw-path.yaml"],
      process.cwd(),
    ).catch((caught: unknown) => caught);

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain(diagnostic);
    expect((result as Error).message).not.toMatch(/CANARY|\/private\/raw-path\.yaml/u);
  });

  it("declares the required output and safe replacement flags (#10938)", () => {
    expect(ConfigExportCommand.flags).toMatchObject({
      output: { char: "o", required: true },
      name: {},
      force: { default: false },
    });
  });
});
