// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildExportConfig: vi.fn(),
  renderCanonicalNemoClawConfig: vi.fn(),
  validateNemoClawConfig: vi.fn(),
}));

vi.mock("../../config/canonical", () => ({
  renderCanonicalNemoClawConfig: mocks.renderCanonicalNemoClawConfig,
}));
vi.mock("../../domain/config/export-document", () => ({
  buildExportConfig: mocks.buildExportConfig,
}));
vi.mock("../../config/schema", () => ({
  validateNemoClawConfig: mocks.validateNemoClawConfig,
}));

import { Check } from "typebox/value";
import { runConfigExport, ConfigExportResultSchema, type ConfigExportDependencies } from "./export";

import {
  parseNemoClawConfigDocumentName,
  parseNemoClawConfigDocumentUid,
} from "../../config/model";

const alphaDocumentName = parseNemoClawConfigDocumentName("alpha");
const teamDocumentName = parseNemoClawConfigDocumentName("team");
const documentUid = parseNemoClawConfigDocumentUid("123e4567-e89b-42d3-a456-426614174000");

function dependencies(): ConfigExportDependencies {
  const observation = { sandboxName: "alpha" } as never;
  const config = { kind: "NemoClawConfig" } as never;
  mocks.buildExportConfig.mockReset().mockReturnValue(config);
  mocks.validateNemoClawConfig.mockReset().mockReturnValue(config);
  mocks.renderCanonicalNemoClawConfig.mockReset().mockReturnValue({
    yaml: "kind: NemoClawConfig\n",
    documentDigest: "sha256:" + "a".repeat(64),
    specDigest: "sha256:" + "b".repeat(64),
  });
  return {
    observe: vi.fn(async () => ({ ok: true, source: observation, attempts: 1 }) as const),
    createDocumentUid: vi.fn(() => documentUid),
    publish: vi.fn(() => ({ ok: true, outputPath: "/tmp/alpha.yaml" }) as const),
    writeStdout: vi.fn(async () => undefined),
  };
}

describe("runConfigExport", () => {
  it("writes canonical YAML for a stdout target", async () => {
    const deps = dependencies();
    await expect(
      runConfigExport(
        { sandboxName: "alpha", documentName: alphaDocumentName, target: { kind: "stdout" } },
        deps,
      ),
    ).resolves.toEqual({ ok: true, completion: { kind: "stdout" } });
    expect(deps.writeStdout).toHaveBeenCalledWith("kind: NemoClawConfig\n");
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it("publishes a file and returns the versioned result", async () => {
    const deps = dependencies();
    await expect(
      runConfigExport(
        {
          sandboxName: "alpha",
          documentName: teamDocumentName,
          target: { kind: "file", outputPath: "/tmp/alpha.yaml", force: true },
        },
        deps,
      ),
    ).resolves.toEqual({
      ok: true,
      completion: {
        kind: "file",
        result: {
          version: 1,
          status: "succeeded",
          sourceSandbox: "alpha",
          outputPath: "/tmp/alpha.yaml",
          documentDigest: "sha256:" + "a".repeat(64),
          specDigest: "sha256:" + "b".repeat(64),
        },
      },
    });
    expect(mocks.buildExportConfig).toHaveBeenCalledWith(expect.anything(), {
      documentName: "team",
      documentUid: "123e4567-e89b-42d3-a456-426614174000",
    });
    expect(mocks.validateNemoClawConfig).toHaveBeenCalledWith({ kind: "NemoClawConfig" });
    expect(deps.publish).toHaveBeenCalledWith("/tmp/alpha.yaml", "kind: NemoClawConfig\n", true);
  });

  it.each([
    { version: 2 },
    { status: "failed" },
    { sourceSandbox: "invalid sandbox" },
    { outputPath: "" },
    { outputPath: "relative.yaml" },
    { documentDigest: "sha256:document" },
    { specDigest: "sha256:" + "a".repeat(64) + "\n" },
    { unexpected: "extra" },
  ])("rejects a malformed JSON result: %j", (invalid) => {
    expect(
      Check(ConfigExportResultSchema, {
        version: 1,
        status: "succeeded",
        sourceSandbox: "alpha",
        outputPath: "/tmp/alpha.yaml",
        documentDigest: "sha256:" + "a".repeat(64),
        specDigest: "sha256:" + "b".repeat(64),
        ...invalid,
      }),
    ).toBe(false);
  });

  it("returns a stdout failure without exposing the rejected write error", async () => {
    const canary = "CANARY: stdout failure";
    const deps = {
      ...dependencies(),
      writeStdout: vi.fn(async () => {
        throw new Error(canary);
      }),
    };

    const outcome = await runConfigExport(
      { sandboxName: "alpha", documentName: alphaDocumentName, target: { kind: "stdout" } },
      deps,
    );

    expect(outcome).toEqual({
      ok: false,
      failure: {
        kind: "output",
        target: "stdout",
        category: "unsafe-output",
      },
    });
    expect(JSON.stringify(outcome)).not.toContain(canary);
  });

  it("returns an observation failure without building or publishing", async () => {
    const deps = dependencies();
    const finding = {
      field: "source.registry",
      category: "not-found",
      diagnostic: "The sandbox was not found.",
    } as const;
    vi.mocked(deps.observe).mockResolvedValue({
      ok: false,
      findings: [finding],
      attempts: 1,
    });

    await expect(
      runConfigExport(
        { sandboxName: "alpha", documentName: alphaDocumentName, target: { kind: "stdout" } },
        deps,
      ),
    ).resolves.toEqual({
      ok: false,
      failure: { kind: "observation", findings: [finding], attempts: 1 },
    });
    expect(mocks.buildExportConfig).not.toHaveBeenCalled();
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it.each([
    { publication: "not-published", stagingCleanup: "complete" },
    {
      publication: "published",
      durability: "unknown",
      location: "confirmed",
      stagingCleanup: "complete",
    },
  ] as const)(
    "passes through a $publication output failure without reclassifying it",
    async (fileState) => {
      const deps = dependencies();
      const failure = { category: "unsafe-output", fileState, stagingReference: null } as const;
      vi.mocked(deps.publish).mockReturnValue({ ok: false, failure });

      await expect(
        runConfigExport(
          {
            sandboxName: "alpha",
            documentName: alphaDocumentName,
            target: { kind: "file", outputPath: "/tmp/alpha.yaml", force: false },
          },
          deps,
        ),
      ).resolves.toEqual({
        ok: false,
        failure: { kind: "output", target: "file", ...failure },
      });
      expect(deps.writeStdout).not.toHaveBeenCalled();
    },
  );
});
