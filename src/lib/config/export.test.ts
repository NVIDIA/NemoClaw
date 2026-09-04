// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildExportConfig: vi.fn(),
  renderCanonicalNemoClawConfig: vi.fn(),
}));

vi.mock("./canonical", () => ({
  renderCanonicalNemoClawConfig: mocks.renderCanonicalNemoClawConfig,
}));
vi.mock("./export-builder", () => ({ buildExportConfig: mocks.buildExportConfig }));

import { runConfigExport, type ConfigExportDependencies } from "./export";
import { parseNemoClawConfigDocumentName, parseNemoClawConfigDocumentUid } from "./model";
import { YamlExportOutputError } from "./output";

const alphaDocumentName = parseNemoClawConfigDocumentName("alpha");
const teamDocumentName = parseNemoClawConfigDocumentName("team");
const documentUid = parseNemoClawConfigDocumentUid("123e4567-e89b-42d3-a456-426614174000");

function dependencies(): ConfigExportDependencies {
  const observation = { sandboxName: "alpha" } as never;
  mocks.buildExportConfig.mockReset().mockReturnValue({} as never);
  mocks.renderCanonicalNemoClawConfig.mockReset().mockReturnValue({
    yaml: "kind: NemoClawConfig\n",
    documentDigest: "doc",
    specDigest: "spec",
  });
  return {
    observe: vi.fn(async () => ({ ok: true, source: observation, attempts: 1 }) as const),
    createDocumentUid: vi.fn(() => documentUid),
    publish: vi.fn(() => "/tmp/alpha.yaml"),
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
          documentDigest: "doc",
          specDigest: "spec",
        },
      },
    });
    expect(mocks.buildExportConfig).toHaveBeenCalledWith(expect.anything(), {
      documentName: "team",
      documentUid: "123e4567-e89b-42d3-a456-426614174000",
    });
    expect(deps.publish).toHaveBeenCalledWith("/tmp/alpha.yaml", "kind: NemoClawConfig\n", true);
  });

  it("waits for stdout completion and returns a sanitized write failure", async () => {
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
        diagnostic: "The export could not be written to stdout.",
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
    {
      name: "typed",
      error: new YamlExportOutputError(
        "output-conflict",
        "/private/raw-path.yaml",
        "CANARY: /private/raw-path.yaml",
      ),
      category: "output-conflict",
      fileState: { publication: "not-published", stagingCleanup: "complete" },
      diagnostic: "The output path already exists.",
    },
    {
      name: "conflict with residual staging file",
      error: new YamlExportOutputError(
        "output-conflict",
        "/private/raw-path.yaml",
        "CANARY: /private/raw-path.yaml",
        {
          publication: "not-published",
          stagingCleanup: "incomplete",
        },
      ),
      category: "unsafe-output",
      fileState: {
        publication: "not-published",
        stagingCleanup: "incomplete",
      },
      diagnostic: "The export was not published, and its staging file could not be removed.",
    },
    {
      name: "committed",
      error: new YamlExportOutputError(
        "unsafe-output",
        "/private/raw-path.yaml",
        "CANARY: /private/raw-path.yaml",
        {
          publication: "published",
          durability: "confirmed",
          location: "confirmed",
          stagingCleanup: "incomplete",
        },
      ),
      category: "unsafe-output",
      fileState: {
        publication: "published",
        durability: "confirmed",
        location: "confirmed",
        stagingCleanup: "incomplete",
      },
      diagnostic: "The export was written, but staging cleanup could not be confirmed.",
    },
    {
      name: "durability",
      error: new YamlExportOutputError(
        "unsafe-output",
        "/private/raw-path.yaml",
        "CANARY: /private/raw-path.yaml",
        {
          publication: "published",
          durability: "unknown",
          location: "confirmed",
          stagingCleanup: "complete",
        },
      ),
      category: "unsafe-output",
      fileState: {
        publication: "published",
        durability: "unknown",
        location: "confirmed",
        stagingCleanup: "complete",
      },
      diagnostic: "The export was written, but filesystem durability could not be confirmed.",
    },
    {
      name: "location",
      error: new YamlExportOutputError(
        "unsafe-output",
        "/private/raw-path.yaml",
        "CANARY: /private/raw-path.yaml",
        {
          publication: "published",
          durability: "confirmed",
          location: "unknown",
          stagingCleanup: "complete",
        },
      ),
      category: "unsafe-output",
      fileState: {
        publication: "published",
        durability: "confirmed",
        location: "unknown",
        stagingCleanup: "complete",
      },
      diagnostic: "The export was written, but the final output location could not be confirmed.",
    },
    {
      name: "ambiguous publication",
      error: new YamlExportOutputError(
        "unsafe-output",
        "/private/raw-path.yaml",
        "CANARY: /private/raw-path.yaml",
        {
          publication: "unknown",
          stagingCleanup: "complete",
        },
      ),
      category: "unsafe-output",
      fileState: {
        publication: "unknown",
        stagingCleanup: "complete",
      },
      diagnostic: "The export may have been written, but its publication state could not be confirmed.",
    },
    {
      name: "unknown",
      error: new Error("CANARY: /private/raw-path.yaml"),
      category: "unsafe-output",
      fileState: "unknown",
      diagnostic: "The export publication state could not be determined safely.",
    },
  ] as const)(
    "sanitizes $name publication errors",
    async ({ error, category, fileState, diagnostic }) => {
      const deps = {
        ...dependencies(),
        publish: vi.fn(() => {
          throw error;
        }),
      };

      const outcome = await runConfigExport(
        {
          sandboxName: "alpha",
          documentName: alphaDocumentName,
          target: { kind: "file", outputPath: "/private/raw-path.yaml", force: false },
        },
        deps,
      );

      expect(outcome).toEqual({
        ok: false,
        failure: { kind: "output", target: "file", fileState, category, diagnostic },
      });
      expect(JSON.stringify(outcome)).not.toMatch(/CANARY|\/private\/raw-path\.yaml/u);
    },
  );
});
