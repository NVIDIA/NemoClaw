// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendFileSync: vi.fn(),
  execFileSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: mocks.execFileSync,
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  appendFileSync: mocks.appendFileSync,
  readFileSync: mocks.readFileSync,
}));

import { parseDcodeSandboxBaseImageResolutionLabels } from "../../../src/lib/sandbox-base-image/label-codec.ts";
import { SANDBOX_BASE_RESOLUTION_LABEL } from "../../../src/lib/sandbox-base-image/types.ts";
import { exportDcodeBaseResolutionLabel } from "../../../scripts/checks/export-dcode-base-resolution-label.mts";

const IMAGE = "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base";
const DIGEST = `sha256:${"a".repeat(64)}`;
const SOURCE_REVISION = "b".repeat(40);
const REFERENCE = `${IMAGE}@${DIGEST}`;
const OUTPUT = "/tmp/dcode-base-resolution-output";
const LOCAL_RECEIPT_ROOT = "/tmp/dcode-base.oci";
const LOCAL_RECEIPT = `${LOCAL_RECEIPT_ROOT}@${DIGEST}`;
let dockerOutputs = new Map<string, string>();

function exporterArguments(overrides: { inspectReference?: string; extra?: string[] } = {}) {
  return [
    "--reference",
    REFERENCE,
    "--inspect-reference",
    overrides.inspectReference ?? REFERENCE,
    "--platform",
    "linux/amd64",
    "--output",
    OUTPUT,
    "--expected-source-revision",
    SOURCE_REVISION,
    ...(overrides.extra ?? []),
  ];
}

function inspectOutput(sourceRevision: string | null = SOURCE_REVISION): string {
  return JSON.stringify([
    {
      Id: `sha256:${"c".repeat(64)}`,
      Os: "linux",
      Architecture: "amd64",
      Config: {
        Labels:
          sourceRevision === null ? {} : { "org.opencontainers.image.revision": sourceRevision },
      },
    },
  ]);
}

function emittedResolutionLabel(): string {
  const output = String(mocks.appendFileSync.mock.calls[0]?.[1] ?? "");
  return /^resolution_label=(\S+)$/mu.exec(output)?.[1] ?? "";
}

function dockerOutput(args: string[]): string {
  const key = args.slice(0, 2).join(" ");
  return (
    dockerOutputs.get(key) ??
    (() => {
      throw new Error(`Unexpected docker arguments: ${args.join(" ")}`);
    })()
  );
}

describe("Deep Agents Code managed-image base resolution label", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readFileSync.mockReturnValue(JSON.stringify({ manifests: [{ digest: DIGEST }] }));
    dockerOutputs = new Map([
      ["pull --platform", ""],
      ["image inspect", inspectOutput()],
      ["run --rm", "glibc 2.41"],
    ]);
    mocks.execFileSync.mockImplementation((_command: string, args: string[]) => dockerOutput(args));
  });

  it("exports remote receipt authority into a parseable final-image label (#9386)", () => {
    const metadata = exportDcodeBaseResolutionLabel(exporterArguments());

    expect(
      parseDcodeSandboxBaseImageResolutionLabels({
        [SANDBOX_BASE_RESOLUTION_LABEL]: emittedResolutionLabel(),
      }),
    ).toEqual(metadata);
    expect(metadata).toMatchObject({
      imageName: IMAGE,
      ref: REFERENCE,
      digest: DIGEST,
      sourceRevision: SOURCE_REVISION,
      os: "linux",
      architecture: "amd64",
      source: "override",
    });
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      "docker",
      ["pull", "--platform", "linux/amd64", REFERENCE],
      expect.anything(),
    );
  });

  it("exports a mutable local inspection only from its exact OCI receipt (#9386)", () => {
    const localReference = "nemoclaw-managed-pr/dcode-base:test";
    const metadata = exportDcodeBaseResolutionLabel(
      exporterArguments({
        inspectReference: localReference,
        extra: ["--local-oci-receipt", LOCAL_RECEIPT],
      }),
    );

    expect(metadata).toMatchObject({ ref: REFERENCE, sourceRevision: SOURCE_REVISION });
    expect(mocks.readFileSync).toHaveBeenCalledWith(`${LOCAL_RECEIPT_ROOT}/index.json`, "utf8");
    expect(mocks.execFileSync).not.toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["pull"]),
      expect.anything(),
    );
  });

  it.each([
    ["missing", undefined],
    ["malformed", "main"],
  ])("rejects %s source revision while parsing the untrusted label (#9386)", (_label, value) => {
    const metadata = exportDcodeBaseResolutionLabel(exporterArguments());
    const encoded = Buffer.from(
      JSON.stringify({ ...metadata, sourceRevision: value }),
      "utf8",
    ).toString("base64url");

    expect(
      parseDcodeSandboxBaseImageResolutionLabels({ [SANDBOX_BASE_RESOLUTION_LABEL]: encoded }),
    ).toBeNull();
  });

  it("rejects a mutable inspection reference without its exact local receipt (#9386)", () => {
    expect(() =>
      exportDcodeBaseResolutionLabel(
        exporterArguments({ inspectReference: "nemoclaw-managed-pr/dcode-base:test" }),
      ),
    ).toThrow(/needs its exact local OCI receipt/u);
  });

  it("rejects a local receipt whose manifest does not match the platform digest (#9386)", () => {
    mocks.readFileSync.mockReturnValue(
      JSON.stringify({ manifests: [{ digest: `sha256:${"d".repeat(64)}` }] }),
    );

    expect(() =>
      exportDcodeBaseResolutionLabel(
        exporterArguments({
          inspectReference: "nemoclaw-managed-pr/dcode-base:test",
          extra: ["--local-oci-receipt", LOCAL_RECEIPT],
        }),
      ),
    ).toThrow(/does not contain the immutable platform manifest/u);
  });

  it("rejects a source revision that differs from the immutable contract (#9386)", () => {
    dockerOutputs.set("image inspect", inspectOutput("d".repeat(40)));

    expect(() => exportDcodeBaseResolutionLabel(exporterArguments())).toThrow(
      /source revision does not match the immutable contract/u,
    );
  });

  it("rejects an exact image that omits its source revision receipt (#9386)", () => {
    dockerOutputs.set("image inspect", inspectOutput(null));

    expect(() => exportDcodeBaseResolutionLabel(exporterArguments())).toThrow(
      /inspected source revision is missing/u,
    );
  });

  it("rejects a base below the declared minimum glibc version (#9386)", () => {
    dockerOutputs.set("run --rm", "glibc 2.38");

    expect(() => exportDcodeBaseResolutionLabel(exporterArguments())).toThrow(
      /glibc version is below the required minimum/u,
    );
  });
});
