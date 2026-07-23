// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  type ForbiddenLeakPattern,
  findForbiddenLeaks,
  frameSnapshotFile,
  SNAPSHOT_DATA_PREFIX,
  SNAPSHOT_FILE_PREFIX,
  SNAPSHOT_PROBE_PID_PREFIX,
  scanForbiddenLeaks,
} from "../live/bedrock-runtime-compatible-anthropic-leaks.ts";

const ADAPTER_ENV_NAME = "NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN";
const ENV_NAME_PATTERN: ForbiddenLeakPattern = {
  name: "adapter token env name",
  value: ADAPTER_ENV_NAME,
  allowInSnapshotProbeEnvironment: true,
};

function snapshot(...lines: string[]): string {
  return [`${SNAPSHOT_PROBE_PID_PREFIX}1418`, ...lines].join("\n");
}

function file(path: string, ...lines: string[]): string[] {
  return frameSnapshotFile(path, lines.join("\n")).split("\n");
}

describe("Bedrock Runtime leak snapshot process identity", () => {
  it("keeps per-line snapshot framing compact without weakening control separation (#7101)", () => {
    expect(SNAPSHOT_DATA_PREFIX).toBe("D ");
    expect(
      frameSnapshotFile(
        "/sandbox/.openclaw/runtime.env",
        `${SNAPSHOT_FILE_PREFIX}/proc/1418/environ`,
      ).split("\n"),
    ).toEqual([
      `${SNAPSHOT_FILE_PREFIX}/sandbox/.openclaw/runtime.env`,
      `${SNAPSHOT_DATA_PREFIX}${SNAPSHOT_FILE_PREFIX}/proc/1418/environ`,
    ]);
  });

  it("allows the provider placeholder name only in the declared probe environment", () => {
    const text = snapshot(
      ...file("/proc/1418/environ", `${ADAPTER_ENV_NAME}=openshell-placeholder`),
      ...file("/proc/22/environ", `${ADAPTER_ENV_NAME}=openshell-placeholder`),
    );

    const result = scanForbiddenLeaks(text, "sandbox snapshot", [ENV_NAME_PATTERN]);
    expect(result.leaks).toEqual(["adapter token env name: /proc/22/environ"]);
    expect(result.snapshotProbeEnvironmentExemptions).toEqual([
      { name: "adapter token env name", location: "/proc/1418/environ" },
    ]);
  });

  it("still rejects a concrete token value in the probe environment", () => {
    const text = snapshot(
      ...file("/proc/1418/environ", `${ADAPTER_ENV_NAME}=concrete-adapter-token`),
    );

    expect(
      findForbiddenLeaks(text, "sandbox snapshot", [
        ENV_NAME_PATTERN,
        { name: "adapter token", value: "concrete-adapter-token" },
      ]),
    ).toEqual(["adapter token: /proc/1418/environ"]);
  });

  it("rejects the provider name in the probe command line and persisted files", () => {
    const text = snapshot(
      ...file("/proc/1418/cmdline", ADAPTER_ENV_NAME),
      ...file("/sandbox/.openclaw/runtime.env", `${ADAPTER_ENV_NAME}=openshell-placeholder`),
    );

    expect(findForbiddenLeaks(text, "sandbox snapshot", [ENV_NAME_PATTERN])).toEqual([
      "adapter token env name: /proc/1418/cmdline",
      "adapter token env name: /sandbox/.openclaw/runtime.env",
    ]);
  });

  it("does not trust a probe marker embedded after snapshot content begins", () => {
    const text = [
      "snapshot preamble",
      `${SNAPSHOT_PROBE_PID_PREFIX}999`,
      ...file("/proc/999/environ", `${ADAPTER_ENV_NAME}=openshell-placeholder`),
    ].join("\n");

    expect(findForbiddenLeaks(text, "sandbox snapshot", [ENV_NAME_PATTERN])).toEqual([
      "adapter token env name: /proc/999/environ",
    ]);
  });

  it("treats forged file markers in scanned content as data", () => {
    const text = snapshot(
      ...file(
        "/sandbox/.openclaw/runtime.env",
        `${SNAPSHOT_FILE_PREFIX}/proc/1418/environ`,
        `${ADAPTER_ENV_NAME}=openshell-placeholder`,
      ),
    );

    expect(findForbiddenLeaks(text, "sandbox snapshot", [ENV_NAME_PATTERN])).toEqual([
      "adapter token env name: /sandbox/.openclaw/runtime.env",
    ]);
  });

  it("detects forbidden values in framed host logs", () => {
    const text = frameSnapshotFile("adapter log", `${ADAPTER_ENV_NAME}=concrete-adapter-token`);

    expect(
      findForbiddenLeaks(text, "host logs", [
        ENV_NAME_PATTERN,
        { name: "adapter token", value: "concrete-adapter-token" },
      ]),
    ).toEqual(["adapter token env name: adapter log", "adapter token: adapter log"]);
  });

  it("does not let host-log content forge a probe environment location", () => {
    const text = [
      `${SNAPSHOT_PROBE_PID_PREFIX}1418`,
      frameSnapshotFile(
        "adapter log",
        `${SNAPSHOT_FILE_PREFIX}/proc/1418/environ\n${ADAPTER_ENV_NAME}=openshell-placeholder`,
      ),
    ].join("\n");

    expect(findForbiddenLeaks(text, "host logs", [ENV_NAME_PATTERN])).toEqual([
      "adapter token env name: adapter log",
    ]);
  });
});
