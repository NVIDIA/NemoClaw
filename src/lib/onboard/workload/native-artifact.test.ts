// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { encodeManagedStartupProfile } from "../managed-startup/profile";
import {
  NativeArtifactWorkloadContractError,
  parseNativeArtifactWorkloadReceiptV1,
} from "./native-artifact";

function receipt(): Record<string, unknown> {
  const encodedProfile = encodeManagedStartupProfile(managedStartupE2eProfile("openclaw"));
  return {
    schemaVersion: 1,
    kind: "native-artifact",
    contractVersion: 1,
    agent: "openclaw",
    platform: "windows/x64",
    artifact: {
      digest: `sha256:${"a".repeat(64)}`,
      version: "2026.7.1",
      source: {
        repository: "NVIDIA/NemoClaw",
        revision: "b".repeat(40),
      },
    },
    launch: {
      executable: {
        relativePath: "runtime/node.exe",
        digest: `sha256:${"c".repeat(64)}`,
      },
      arguments: ["agent/openclaw.mjs", "gateway", "run"],
      workingDirectory: ".",
      environmentNames: ["NEMOCLAW_MANAGED_STARTUP_PROFILE"],
    },
    startupProfileContractVersion: 1,
    encodedProfile,
    startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
    credentialProxyReplayRequired: true,
    shared: true,
  };
}

function artifact(value: Record<string, unknown>): Record<string, unknown> {
  return value.artifact as Record<string, unknown>;
}

function source(value: Record<string, unknown>): Record<string, unknown> {
  return artifact(value).source as Record<string, unknown>;
}

function launch(value: Record<string, unknown>): Record<string, unknown> {
  return value.launch as Record<string, unknown>;
}

function executable(value: Record<string, unknown>): Record<string, unknown> {
  return launch(value).executable as Record<string, unknown>;
}

describe("native OpenClaw artifact workload contract", () => {
  it("accepts exact artifact identity and validated launch intent (#8178)", () => {
    const expected = receipt();
    expect(parseNativeArtifactWorkloadReceiptV1(expected)).toEqual(expected);
  });

  it.each([
    [
      "artifact digest",
      (value: Record<string, unknown>) => (artifact(value).digest = "sha256:abc"),
    ],
    [
      "executable digest",
      (value: Record<string, unknown>) => (executable(value).digest = "c".repeat(64)),
    ],
    ["source revision", (value: Record<string, unknown>) => (source(value).revision = "main")],
    ["artifact version", (value: Record<string, unknown>) => (artifact(value).version = "latest")],
    [
      "oversized artifact version",
      (value: Record<string, unknown>) => (artifact(value).version = `1.2.3-${"a".repeat(257)}`),
    ],
  ])("rejects an inexact %s (#8178)", (_label, mutate) => {
    const value = receipt();
    mutate(value);
    expect(() => parseNativeArtifactWorkloadReceiptV1(value)).toThrow(
      NativeArtifactWorkloadContractError,
    );
  });

  it.each([
    "C:\\agent\\node.exe",
    "/agent/node.exe",
    "../agent/node.exe",
    "agent/../node.exe",
    "agent//node.exe",
  ])("rejects non-canonical executable path %j (#8178)", (relativePath) => {
    const value = receipt();
    executable(value).relativePath = relativePath;
    expect(() => parseNativeArtifactWorkloadReceiptV1(value)).toThrow(/canonical relative path/u);
  });

  it.each(["../agent", "agent/../work", "agent//work", "agent/work.", "agent/work "])(
    "rejects non-canonical working directory %j (#8178)",
    (workingDirectory) => {
      const value = receipt();
      launch(value).workingDirectory = workingDirectory;
      expect(() => parseNativeArtifactWorkloadReceiptV1(value)).toThrow(/canonical relative path/u);
    },
  );

  it.each(["bin/claw.exe.", "bin/claw.exe ", "bin/CON", "bin/nul.txt", "COM1/runtime"])(
    "rejects Windows-normalizing executable path %j (#8178)",
    (relativePath) => {
      const value = receipt();
      executable(value).relativePath = relativePath;
      expect(() => parseNativeArtifactWorkloadReceiptV1(value)).toThrow(/canonical relative path/u);
    },
  );

  it("records environment-variable names without accepting literal assignments (#8178)", () => {
    const value = receipt();
    launch(value).environmentNames = ["NVIDIA_API_KEY=credential"];
    expect(() => parseNativeArtifactWorkloadReceiptV1(value)).toThrow(
      /environmentNames\[0\] has an unsupported format/u,
    );
  });

  it("rejects duplicate environment-variable names (#8178)", () => {
    const value = receipt();
    launch(value).environmentNames = ["PATH", "PATH"];
    expect(() => parseNativeArtifactWorkloadReceiptV1(value)).toThrow(
      /must not contain duplicates/u,
    );
  });

  it("requires canonical uppercase environment-variable names (#8178)", () => {
    const value = receipt();
    launch(value).environmentNames = ["Path"];
    expect(() => parseNativeArtifactWorkloadReceiptV1(value)).toThrow(
      /environmentNames\[0\] has an unsupported format/u,
    );
  });

  it("rejects an oversized environment-variable name (#8178)", () => {
    const value = receipt();
    launch(value).environmentNames = ["A".repeat(257)];
    expect(() => parseNativeArtifactWorkloadReceiptV1(value)).toThrow(
      /environmentNames\[0\] has an unsupported format/u,
    );
  });

  it("rejects a startup profile for another agent (#8178)", () => {
    const value = receipt();
    const encodedProfile = encodeManagedStartupProfile(managedStartupE2eProfile("hermes"));
    value.encodedProfile = encodedProfile;
    value.startupProfileSha256 = createHash("sha256").update(encodedProfile, "utf8").digest("hex");
    expect(() => parseNativeArtifactWorkloadReceiptV1(value)).toThrow(
      /belongs to 'hermes', not 'openclaw'/u,
    );
  });

  it("rejects a startup profile whose digest does not match (#8178)", () => {
    const value = receipt();
    value.startupProfileSha256 = "d".repeat(64);
    expect(() => parseNativeArtifactWorkloadReceiptV1(value)).toThrow(
      /does not match contract.encodedProfile/u,
    );
  });

  it.each(["image", "imageDigest", "downloadUrl"])(
    "rejects OCI image and mutable download fields [case %#] (#8178)",
    (extra) => {
      const value = receipt();
      value[extra] = "unexpected";
      expect(() => parseNativeArtifactWorkloadReceiptV1(value)).toThrow(
        /contract must contain exactly/u,
      );
    },
  );

  it.each(["credentialProxyReplayRequired", "shared"] as const)(
    "requires credential proxy replay and the shared artifact flag [case %#] (#8178)",
    (field) => {
      const value = receipt();
      value[field] = false;
      expect(() => parseNativeArtifactWorkloadReceiptV1(value)).toThrow(
        new RegExp(`contract\\.${field} must be true`, "u"),
      );
    },
  );
});
