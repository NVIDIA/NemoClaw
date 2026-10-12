// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  snapshotReader: { read: vi.fn() },
  createLiveExportSnapshotReader: vi.fn(),
  observeStableExportSource: vi.fn(),
  buildExportConfig: vi.fn(),
  renderCanonicalNemoClawConfig: vi.fn(),
  publishExportFile: vi.fn(),
}));

vi.mock("../../lib/config/canonical", () => ({
  renderCanonicalNemoClawConfig: mocks.renderCanonicalNemoClawConfig,
}));
vi.mock("../../lib/domain/config/export-document", () => ({
  buildExportConfig: mocks.buildExportConfig,
}));
vi.mock("../../lib/config/v1alpha1-export", () => ({
  isV1Alpha1ExportName: (value: unknown) =>
    typeof value === "string" && /^[a-z][a-z0-9-]{0,39}$/u.test(value),
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
const caOmissionNotice =
  "The source's corporate CA configuration is not included in the exported YAML. Review destination trust requirements before deployment.";
const caStates = [
  { state: "without retained CA", corporateCaOmitted: undefined, notices: [] },
  { state: "with retained CA", corporateCaOmitted: true, notices: [[caOmissionNotice]] },
] as const;

describe("config export command", () => {
  beforeEach(() => {
    mocks.createLiveExportSnapshotReader.mockReset().mockReturnValue(mocks.snapshotReader);
    mocks.observeStableExportSource.mockReset().mockResolvedValue({
      ok: true,
      source: { sandboxName: "alpha" },
      attempts: 1,
    });
    mocks.buildExportConfig.mockReset().mockReturnValue({ kind: "NemoClawConfig" });
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

  it.each(caStates)(
    "writes YAML stdout $state and keeps the CA notice on stderr (#12146)",
    async ({ corporateCaOmitted, notices }) => {
      const notice = vi.spyOn(console, "error").mockImplementation(() => {});
      mocks.observeStableExportSource.mockResolvedValue({
        ok: true,
        source: { sandboxName: "alpha" },
        attempts: 1,
        ...(corporateCaOmitted ? { corporateCaOmitted } : {}),
      });
      const write = vi.spyOn(process.stdout, "write").mockImplementation(((
        _: string,
        callback?: (error?: Error | null) => void,
      ) => {
        callback?.();
        return true;
      }) as typeof process.stdout.write);
      await expect(
        ConfigExportCommand.run(["alpha", "--output", "-", "--name", "team-alpha"], process.cwd()),
      ).resolves.toBeUndefined();
      expect(mocks.observeStableExportSource).toHaveBeenCalledWith("alpha", mocks.snapshotReader);
      expect(mocks.buildExportConfig).toHaveBeenCalledWith(
        { sandboxName: "alpha" },
        expect.objectContaining({ documentName: "team-alpha", documentUid: expect.any(String) }),
      );
      expect(write).toHaveBeenCalledWith("kind: NemoClawConfig\n", expect.any(Function));
      expect(write).toHaveBeenCalledTimes(1);
      expect(notice.mock.calls).toEqual(notices);
      expect(mocks.publishExportFile).not.toHaveBeenCalled();
    },
  );

  it("does not report CA omission when YAML stdout fails (#12146)", async () => {
    const notice = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.observeStableExportSource.mockResolvedValue({
      ok: true,
      source: { sandboxName: "alpha" },
      attempts: 1,
      corporateCaOmitted: true,
    });
    vi.spyOn(process.stdout, "write").mockImplementation(((
      _: string,
      callback?: (error?: Error | null) => void,
    ) => {
      callback?.(new Error("write-failure-canary"));
      return true;
    }) as typeof process.stdout.write);

    await expect(
      ConfigExportCommand.run(["alpha", "--output", "-"], process.cwd()),
    ).rejects.toThrow("The export could not be written to stdout.");
    expect(notice).not.toHaveBeenCalled();
  });

  describe("Gemini refusal (#12551)", () => {
    beforeEach(async () => {
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      const { observeStableExportSource } = await vi.importActual<
        typeof import("../../lib/actions/config/observe-export-source")
      >("../../lib/actions/config/observe-export-source");
      const { geminiSnapshot } = await import("../../lib/domain/config/export-source-test-fixture");
      mocks.snapshotReader.read.mockResolvedValue(geminiSnapshot());
      mocks.observeStableExportSource.mockImplementation(observeStableExportSource);
    });

    it.each([
      ["alpha", "--output", "-"],
      ["alpha", "--output", "/tmp/alpha.yaml"],
      ["alpha", "--output", "/tmp/alpha.yaml", "--force"],
    ])("rejects Gemini without rendering or writing YAML: %j", async (...args) => {
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await expect(ConfigExportCommand.run(args, process.cwd())).rejects.toThrow(
        "V1 cannot consume this provider",
      );
      expect(stdout).not.toHaveBeenCalled();
      expect(mocks.buildExportConfig).not.toHaveBeenCalled();
      expect(mocks.renderCanonicalNemoClawConfig).not.toHaveBeenCalled();
      expect(mocks.publishExportFile).not.toHaveBeenCalled();
    });

    it("reports an unsupported JSON error without replacing the output file", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      process.exitCode = undefined;
      await ConfigExportCommand.run(
        ["alpha", "--output", "/tmp/alpha.yaml", "--force", "--json"],
        process.cwd(),
      );
      expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({
        error: { message: expect.stringContaining("V1 cannot consume this provider") },
      });
      expect(process.exitCode).not.toBe(0);
      expect(mocks.buildExportConfig).not.toHaveBeenCalled();
      expect(mocks.renderCanonicalNemoClawConfig).not.toHaveBeenCalled();
      expect(mocks.publishExportFile).not.toHaveBeenCalled();
    });
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
    ).rejects.toThrow("config name must be a lowercase v1 name");
    expect(mocks.observeStableExportSource).not.toHaveBeenCalled();
  });

  it("rejects a legacy dotted document name at the v1 export boundary (#11977)", async () => {
    await expect(
      ConfigExportCommand.run(["alpha", "--output", "-", "--name", "team.alpha"], process.cwd()),
    ).rejects.toThrow("config name must be a lowercase v1 name");
    expect(mocks.observeStableExportSource).not.toHaveBeenCalled();
  });

  it("displays a returned observation failure without building the document", async () => {
    const notice = vi.spyOn(console, "error").mockImplementation(() => {});
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
    expect(notice).not.toHaveBeenCalled();
  });

  it("reports observation failures in JSON without publishing a document", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.observeStableExportSource.mockResolvedValue({
      ok: false,
      findings: [
        { field: "source.registry", category: "not-found", diagnostic: "Sandbox missing." },
      ],
      attempts: 1,
    });
    process.exitCode = undefined;

    await ConfigExportCommand.run(
      ["alpha", "--output", "/tmp/alpha.yaml", "--json"],
      process.cwd(),
    );

    expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({
      error: { message: "Config export failed (not-found).\nSandbox missing." },
    });
    expect(process.exitCode).not.toBe(0);
    expect(mocks.buildExportConfig).not.toHaveBeenCalled();
    expect(mocks.publishExportFile).not.toHaveBeenCalled();
  });

  it("provides short and long command help without reading source state (#10938)", async () => {
    expect(ConfigExportCommand.flags.name.description).toContain(
      "lowercase, starts with a letter, up to 40 letters, digits, or hyphens",
    );
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

  it.each(caStates)(
    "publishes a file $state without JSON stdout and keeps CA notices on stderr (#12146)",
    async ({ corporateCaOmitted, notices }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      const notice = vi.spyOn(console, "error").mockImplementation(() => {});
      mocks.observeStableExportSource.mockResolvedValue({
        ok: true,
        source: { sandboxName: "alpha" },
        attempts: 1,
        ...(corporateCaOmitted ? { corporateCaOmitted } : {}),
      });
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const result = await ConfigExportCommand.run(
        ["alpha", "--output", "/tmp/alpha.yaml"],
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
      expect(Check(ConfigExportResultSchema, result)).toBe(true);
      expect(log).not.toHaveBeenCalled();
      expect(notice.mock.calls).toEqual(notices);
      expect(mocks.publishExportFile).toHaveBeenCalledWith(
        "/tmp/alpha.yaml",
        "kind: NemoClawConfig\n",
        false,
      );
    },
  );

  it.each(caStates)(
    "publishes a file $state with the version 1 JSON result and separate CA notices (#12146)",
    async ({ corporateCaOmitted, notices }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      const notice = vi.spyOn(console, "error").mockImplementation(() => {});
      mocks.observeStableExportSource.mockResolvedValue({
        ok: true,
        source: { sandboxName: "alpha" },
        attempts: 1,
        ...(corporateCaOmitted ? { corporateCaOmitted } : {}),
      });
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
      expect(Check(ConfigExportResultSchema, result)).toBe(true);
      expect(log).toHaveBeenCalledTimes(1);
      expect(JSON.parse(log.mock.calls[0]![0])).toEqual(result);
      expect(notice.mock.calls).toEqual(notices);
      expect(mocks.publishExportFile).toHaveBeenCalledWith(
        "/tmp/alpha.yaml",
        "kind: NemoClawConfig\n",
        false,
      );
    },
  );

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
      const notice = vi.spyOn(console, "error").mockImplementation(() => {});
      mocks.observeStableExportSource.mockResolvedValue({
        ok: true,
        source: { sandboxName: "alpha" },
        attempts: 1,
        corporateCaOmitted: true,
      });
      mocks.publishExportFile.mockReturnValue({ ok: false, failure });
      const result = await ConfigExportCommand.run(
        ["alpha", "--output", "/private/raw-path.yaml"],
        process.cwd(),
      ).catch((caught: unknown) => caught);
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain(diagnostic);
      expect((result as Error).message).not.toContain("/private/raw-path.yaml");
      expect(notice).not.toHaveBeenCalled();
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
