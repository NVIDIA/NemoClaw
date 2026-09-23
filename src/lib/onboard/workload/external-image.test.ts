// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { RuntimeProviderCommandCapture } from "../runtime-provider/contract";
import { resolveSandboxWorkloadRuntimeCapabilities } from "./runtime";
import type { SandboxWorkloadRuntimeCapabilities } from "./source";
import {
  ExternalImagePreparationError,
  parseExactExternalImageReference,
  prepareExternalImageWorkloadSource,
  resolveExternalImageToolDisclosure,
} from "./external-image";

const DIGEST = "a".repeat(64);
const IMAGE_ID = `sha256:${"b".repeat(64)}`;
const REFERENCE = `registry.example.com:5000/team/openclaw@sha256:${DIGEST}`;
const RUNTIME = {
  driverName: "docker",
  managedImageSelectionPolicy: "require-managed",
  legacyDockerfileBuilds: true,
  managedImages: null,
  portableAgentRuntime: null,
  externalImages: {
    exactDigestReferences: true,
    platforms: ["linux/amd64"],
    agents: ["openclaw", "hermes"],
  },
} as const satisfies SandboxWorkloadRuntimeCapabilities;

function inspectRecord(
  overrides: {
    readonly Id?: unknown;
    readonly Os?: unknown;
    readonly Architecture?: unknown;
    readonly Config?: Record<string, unknown> | null;
  } = {},
): Record<string, unknown> {
  const { Config: configOverrides, ...recordOverrides } = overrides;
  return {
    Id: IMAGE_ID,
    Os: "linux",
    Architecture: "amd64",
    Config: {
      User: "1000:1000",
      WorkingDir: "/sandbox",
      Entrypoint: ["/usr/bin/tini", "--"],
      Cmd: ["node", "server.js"],
      Env: ["NEMOCLAW_TOOL_DISCLOSURE=progressive"],
      Labels: { "io.nvidia.nemoclaw.agent": "openclaw" },
      ...configOverrides,
    },
    ...recordOverrides,
  };
}

function result(
  overrides: Partial<RuntimeProviderCommandCapture> = {},
): RuntimeProviderCommandCapture {
  return { status: 0, stdout: JSON.stringify([inspectRecord()]), stderr: "", ...overrides };
}

function prepare(
  capture: (args: readonly string[]) => RuntimeProviderCommandCapture,
  options: {
    readonly reference?: string;
    readonly agentName?: string;
    readonly runtime?: SandboxWorkloadRuntimeCapabilities;
  } = {},
) {
  return prepareExternalImageWorkloadSource(
    {
      reference: options.reference ?? REFERENCE,
      agentName: options.agentName ?? "openclaw",
      runtime: options.runtime ?? RUNTIME,
    },
    {
      capture: (_operation, args) => capture(args),
    },
  );
}

describe("exact external image references", () => {
  it("accepts a lowercase repository reference with an exact sha256 digest", () => {
    expect(parseExactExternalImageReference(REFERENCE)).toBe(REFERENCE);
    expect(parseExactExternalImageReference(`openclaw@sha256:${DIGEST}`)).toBe(
      `openclaw@sha256:${DIGEST}`,
    );
  });

  it.each([
    ["a mutable tag", "registry.example.com/team/openclaw:latest"],
    ["a tag plus digest", `registry.example.com/team/openclaw:latest@sha256:${DIGEST}`],
    ["an uppercase repository", `registry.example.com/team/OpenClaw@sha256:${DIGEST}`],
    ["an uppercase digest", `registry.example.com/team/openclaw@sha256:${DIGEST.toUpperCase()}`],
    ["a short digest", "registry.example.com/team/openclaw@sha256:abcd"],
    ["a URL", `https://registry.example.com/team/openclaw@sha256:${DIGEST}`],
    ["leading whitespace", ` ${REFERENCE}`],
    ["trailing whitespace", `${REFERENCE} `],
    ["a shell suffix", `${REFERENCE};docker login registry.example.com`],
  ])("rejects %s", (_description, reference) => {
    expect(() => parseExactExternalImageReference(reference)).toThrow(
      "must use repository@sha256:<64 lowercase hexadecimal characters>",
    );
  });

  it("rejects non-string input", () => {
    expect(() => parseExactExternalImageReference(null)).toThrow(
      "--from-image requires an image reference",
    );
  });
});

describe("external image preparation", () => {
  it("uses a locally available image without pulling and returns immutable observed identity", () => {
    const capture = vi.fn(() => result());

    expect(prepare(capture)).toEqual({
      kind: "external-image",
      reference: REFERENCE,
      platform: "linux/amd64",
      runtimeImageContentId: IMAGE_ID,
      toolDisclosure: "progressive",
    });
    expect(capture).toHaveBeenCalledExactlyOnceWith(["image", "inspect", REFERENCE]);
  });

  it("accepts a Hermes image whose optional metadata matches the selected agent", () => {
    const inspect = inspectRecord({
      Config: {
        Env: ["NEMOCLAW_TOOL_DISCLOSURE=direct", "NEMOCLAW_AGENT=hermes"],
        Labels: { "io.nvidia.nemoclaw.agent": "hermes" },
      },
    });

    expect(
      prepare(() => result({ stdout: JSON.stringify([inspect]) }), { agentName: "hermes" }),
    ).toMatchObject({ kind: "external-image", toolDisclosure: "direct" });
  });

  it("pulls an absent exact digest and inspects the local result", () => {
    const capture = vi
      .fn<(args: readonly string[]) => RuntimeProviderCommandCapture>()
      .mockReturnValueOnce(result({ status: 1, stdout: "", stderr: "No such image" }))
      .mockReturnValueOnce(result({ stdout: "pulled", stderr: "" }))
      .mockReturnValueOnce(
        result({
          stdout: JSON.stringify([
            inspectRecord({ Config: { Env: ["NEMOCLAW_TOOL_DISCLOSURE=direct"] } }),
          ]),
        }),
      );

    expect(prepare(capture)).toMatchObject({
      reference: REFERENCE,
      runtimeImageContentId: IMAGE_ID,
      toolDisclosure: "direct",
    });
    expect(capture.mock.calls).toEqual([
      [["image", "inspect", REFERENCE]],
      [["pull", REFERENCE]],
      [["image", "inspect", REFERENCE]],
    ]);
  });

  it("reports an ambient-auth action without exposing engine stderr", () => {
    const capture = vi
      .fn<(args: readonly string[]) => RuntimeProviderCommandCapture>()
      .mockReturnValueOnce(result({ status: 1, stdout: "", stderr: "No such image: absent" }))
      .mockReturnValueOnce(result({ status: 1, stdout: "", stderr: "denied bearer=pull-secret" }));

    let thrown: unknown;
    try {
      prepare(capture);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ExternalImagePreparationError);
    expect(String(thrown)).toContain(
      "Check image visibility or authenticate with Docker, then retry",
    );
    expect(String(thrown)).not.toContain("pull-secret");
  });

  it("does not contact a registry when local inspection fails for a non-missing reason", () => {
    const capture = vi.fn(() =>
      result({ status: 1, stdout: "", stderr: "daemon failed token=inspect-secret" }),
    );

    let thrown: unknown;
    try {
      prepare(capture);
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).toContain("could not inspect the requested image locally");
    expect(String(thrown)).not.toContain("inspect-secret");
    expect(capture).toHaveBeenCalledExactlyOnceWith(["image", "inspect", REFERENCE]);
  });

  it("reports Docker inspection as unavailable without attempting a pull", () => {
    const capture = vi.fn(() =>
      result({ status: 1, stdout: "", stderr: "", error: new Error("spawn docker ENOENT") }),
    );

    expect(() => prepare(capture)).toThrow("Docker image inspection is unavailable");
    expect(capture).toHaveBeenCalledExactlyOnceWith(["image", "inspect", REFERENCE]);
  });

  it.each([
    [
      "platform",
      inspectRecord({ Architecture: "arm64" }),
      "does not match host platform 'linux/amd64'",
    ],
    ["operating system", inspectRecord({ Os: "windows" }), "image platform 'windows/amd64'"],
    [
      "working directory",
      inspectRecord({ Config: { WorkingDir: "/workspace" } }),
      "working directory must be exactly /sandbox",
    ],
    [
      "usable command",
      inspectRecord({ Config: { Entrypoint: [], Cmd: ["", "  "] } }),
      "must declare a usable entrypoint or command",
    ],
    [
      "blank entrypoint executable",
      inspectRecord({ Config: { Entrypoint: [""], Cmd: ["sleep", "infinity"] } }),
      "must declare a usable entrypoint or command",
    ],
    [
      "blank command executable",
      inspectRecord({ Config: { Entrypoint: null, Cmd: ["", "argument"] } }),
      "must declare a usable entrypoint or command",
    ],
    [
      "tool disclosure",
      inspectRecord({ Config: { Env: [] } }),
      "image must set NEMOCLAW_TOOL_DISCLOSURE",
    ],
    [
      "tool disclosure value",
      inspectRecord({ Config: { Env: ["NEMOCLAW_TOOL_DISCLOSURE=verbose"] } }),
      "must be progressive or direct",
    ],
    [
      "agent environment metadata",
      inspectRecord({
        Config: {
          Env: ["NEMOCLAW_TOOL_DISCLOSURE=progressive", "NEMOCLAW_AGENT=hermes"],
        },
      }),
      "does not match selected agent 'openclaw'",
    ],
    [
      "agent label metadata",
      inspectRecord({ Config: { Labels: { "io.nvidia.nemoclaw.agent": "hermes" } } }),
      "does not match selected agent 'openclaw'",
    ],
    [
      "immutable image identity",
      inspectRecord({ Id: "image-id" }),
      "invalid immutable image identity",
    ],
  ])("rejects incompatible %s", (_description, inspect, message) => {
    expect(() => prepare(() => result({ stdout: JSON.stringify([inspect]) }))).toThrow(message);
  });

  it.each([
    "",
    "root",
    "0",
    "00",
    "+0",
    "-0",
    "+00",
    "-00",
    "root:root",
    "root:0",
    "root:1000",
    "0:root",
    "0:0",
    "0:1000",
    "+0:root",
    "+00:1000",
    "-0:root",
    "-00:1000",
  ])("rejects final image user %j", (user) => {
    expect(() =>
      prepare(() =>
        result({ stdout: JSON.stringify([inspectRecord({ Config: { User: user } })]) }),
      ),
    ).toThrow("must declare an explicit non-root final user");
  });

  it("accepts entrypoint-only and command-only images", () => {
    const entrypointOnly = inspectRecord({ Config: { Cmd: null } });
    const commandOnly = inspectRecord({ Config: { Entrypoint: null, Cmd: ["sleep", "infinity"] } });

    expect(() => prepare(() => result({ stdout: JSON.stringify([entrypointOnly]) }))).not.toThrow();
    expect(() => prepare(() => result({ stdout: JSON.stringify([commandOnly]) }))).not.toThrow();
  });

  it.each([
    [
      "NEMOCLAW_TOOL_DISCLOSURE",
      ["NEMOCLAW_TOOL_DISCLOSURE=progressive", "NEMOCLAW_TOOL_DISCLOSURE=direct"],
    ],
    [
      "NEMOCLAW_AGENT",
      [
        "NEMOCLAW_TOOL_DISCLOSURE=progressive",
        "NEMOCLAW_AGENT=openclaw",
        "NEMOCLAW_AGENT=openclaw",
      ],
    ],
  ])("rejects duplicate %s metadata", (name, environment) => {
    expect(() =>
      prepare(() =>
        result({
          stdout: JSON.stringify([inspectRecord({ Config: { Env: environment } })]),
        }),
      ),
    ).toThrow(`duplicate ${name} metadata`);
  });

  it("rejects contradictory environment and label agent metadata", () => {
    expect(() =>
      prepare(() =>
        result({
          stdout: JSON.stringify([
            inspectRecord({
              Config: {
                Env: ["NEMOCLAW_TOOL_DISCLOSURE=progressive", "NEMOCLAW_AGENT=openclaw"],
                Labels: { "io.nvidia.nemoclaw.agent": "hermes" },
              },
            }),
          ]),
        }),
      ),
    ).toThrow("does not match selected agent 'openclaw'");
  });

  it.each([
    ["malformed JSON", "not-json", "malformed image metadata"],
    ["a non-array record", JSON.stringify(inspectRecord()), "exactly one image record"],
    [
      "multiple records",
      JSON.stringify([inspectRecord(), inspectRecord()]),
      "exactly one image record",
    ],
    ["oversized output", " ".repeat(256 * 1024 + 1), "oversized image metadata"],
  ])("rejects %s from Docker inspect", (_description, stdout, message) => {
    expect(() => prepare(() => result({ stdout }))).toThrow(message);
  });

  it.each([
    [
      "a runtime without external-image support",
      { ...RUNTIME, externalImages: null },
      "does not support user-supplied images",
    ],
    [
      "a runtime without exact-digest support",
      { ...RUNTIME, externalImages: { ...RUNTIME.externalImages, exactDigestReferences: false } },
      "does not support user-supplied exact-digest images",
    ],
    [
      "a runtime with ambiguous host platforms",
      {
        ...RUNTIME,
        externalImages: {
          ...RUNTIME.externalImages,
          platforms: ["linux/amd64", "linux/arm64"],
        },
      },
      "does not support user-supplied exact-digest images",
    ],
    [
      "a runtime without the selected agent",
      { ...RUNTIME, externalImages: { ...RUNTIME.externalImages, agents: ["hermes"] } },
      "does not support user-supplied images for 'openclaw'",
    ],
  ] satisfies readonly [string, SandboxWorkloadRuntimeCapabilities, string][])(
    "rejects %s",
    (_description, runtime, message) => {
      expect(() => prepare(() => result(), { runtime })).toThrow(message);
    },
  );
});

describe("external image runtime capability", () => {
  it("projects exact-digest OpenClaw and Hermes support for Docker", () => {
    expect(
      resolveSandboxWorkloadRuntimeCapabilities({ driverName: "docker" }, undefined, "x64")
        .externalImages,
    ).toEqual({
      exactDigestReferences: true,
      platforms: ["linux/amd64"],
      agents: ["openclaw", "hermes"],
    });
  });

  it("keeps external images unsupported for Podman", () => {
    expect(
      resolveSandboxWorkloadRuntimeCapabilities({ driverName: "podman" }, undefined, "x64")
        .externalImages,
    ).toBeNull();
  });
});

describe("external image tool disclosure", () => {
  it("adopts the image declaration when the operator did not choose a mode", () => {
    expect(resolveExternalImageToolDisclosure("direct", null)).toBe("direct");
  });

  it("accepts a matching explicit mode and rejects a contradiction", () => {
    expect(resolveExternalImageToolDisclosure("progressive", "progressive")).toBe("progressive");
    expect(() => resolveExternalImageToolDisclosure("progressive", "direct")).toThrow(
      "does not match image tool disclosure",
    );
  });
});
