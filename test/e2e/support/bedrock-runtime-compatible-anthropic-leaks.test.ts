// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  type ForbiddenLeakPattern,
  findForbiddenLeaks,
  SNAPSHOT_PROBE_PID_PREFIX,
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

describe("Bedrock Runtime leak snapshot process identity", () => {
  it("allows the provider placeholder name only in the declared probe environment", () => {
    const text = snapshot(
      "@@NEMOCLAW_E2E_FILE@@ /proc/1418/environ",
      `${ADAPTER_ENV_NAME}=openshell-placeholder`,
      "@@NEMOCLAW_E2E_FILE@@ /proc/22/environ",
      `${ADAPTER_ENV_NAME}=openshell-placeholder`,
    );

    expect(findForbiddenLeaks(text, "sandbox snapshot", [ENV_NAME_PATTERN])).toEqual([
      "adapter token env name: /proc/22/environ",
    ]);
  });

  it("still rejects a concrete token value in the probe environment", () => {
    const text = snapshot(
      "@@NEMOCLAW_E2E_FILE@@ /proc/1418/environ",
      `${ADAPTER_ENV_NAME}=concrete-adapter-token`,
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
      "@@NEMOCLAW_E2E_FILE@@ /proc/1418/cmdline",
      ADAPTER_ENV_NAME,
      "@@NEMOCLAW_E2E_FILE@@ /sandbox/.openclaw/runtime.env",
      `${ADAPTER_ENV_NAME}=openshell-placeholder`,
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
      "@@NEMOCLAW_E2E_FILE@@ /proc/999/environ",
      `${ADAPTER_ENV_NAME}=openshell-placeholder`,
    ].join("\n");

    expect(findForbiddenLeaks(text, "sandbox snapshot", [ENV_NAME_PATTERN])).toEqual([
      "adapter token env name: /proc/999/environ",
    ]);
  });
});
