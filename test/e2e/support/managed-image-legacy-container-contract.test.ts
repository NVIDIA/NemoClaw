// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";
import {
  isManagedImageHarnessWorkload,
  requireManagedImageHarnessOpenShellVersion,
} from "../../../scripts/checks/managed-image-protected-runtime-contract.ts";
import { gatewayIdForStateDir } from "../../../src/lib/onboard/gateway/process-environment.ts";
import { managedImageHarnessContainerListArgs } from "../../../scripts/checks/run-managed-image-openshell-e2e.ts";

it("requires the exact private network and image for a 0.0.116 workload", () => {
  const expected = {
    sandbox: "nmc-mi-oc-ol",
    stateDir: "/tmp/private/gateway-state",
    networkName: "private-network",
    imageContentId: `sha256:${"a".repeat(64)}`,
    runtimeVersion: "0.0.116" as const,
  };
  const record = {
    Config: {
      Labels: {
        "openshell.ai/managed-by": "openshell",
        "openshell.ai/sandbox-name": expected.sandbox,
      },
    },
    Image: expected.imageContentId,
    NetworkSettings: { Networks: { [expected.networkName]: {} } },
  };
  expect(isManagedImageHarnessWorkload(record, expected)).toBe(true);
  expect(isManagedImageHarnessWorkload(record, { ...expected, networkName: "foreign" })).toBe(
    false,
  );
  expect(isManagedImageHarnessWorkload(record, { ...expected, networkName: undefined })).toBe(
    false,
  );
  expect(
    isManagedImageHarnessWorkload({ ...record, Image: `sha256:${"b".repeat(64)}` }, expected),
  ).toBe(false);
  expect(isManagedImageHarnessWorkload(record, { ...expected, sandbox: "foreign" })).toBe(false);
  expect(
    managedImageHarnessContainerListArgs(expected.sandbox, true, expected.runtimeVersion),
  ).toEqual([
    "docker",
    "ps",
    "-aq",
    "--no-trunc",
    "--filter",
    "label=openshell.ai/managed-by=openshell",
    "--filter",
    `label=openshell.ai/sandbox-name=${expected.sandbox}`,
  ]);
});

it("rejects a runtime without a reviewed container identity contract", () => {
  expect(() => requireManagedImageHarnessOpenShellVersion("9.9.9")).toThrow(
    "Unsupported protected OpenShell runtime version",
  );
});

it("requires the native isolation identity for a 0.1.3 workload", () => {
  const expected = {
    sandbox: "nmc-mi-oc-ol",
    stateDir: "/tmp/private/gateway-state",
    imageContentId: `sha256:${"a".repeat(64)}`,
    runtimeVersion: "0.1.3" as const,
  };
  const record = {
    Config: {
      Labels: {
        "openshell.ai/managed-by": "openshell",
        "openshell.ai/sandbox-name": expected.sandbox,
        "openshell.ai/isolation-role": "sandbox",
        "openshell.ai/sandbox-namespace": gatewayIdForStateDir(expected.stateDir),
      },
    },
    Image: expected.imageContentId,
    HostConfig: { NetworkMode: "none" },
    NetworkSettings: { Networks: { "legacy-network": {} } },
  };
  expect(isManagedImageHarnessWorkload(record, expected)).toBe(true);
  expect(
    isManagedImageHarnessWorkload(
      { ...record, HostConfig: { NetworkMode: "legacy-network" } },
      expected,
    ),
  ).toBe(false);
  expect(
    managedImageHarnessContainerListArgs(expected.sandbox, false, expected.runtimeVersion),
  ).toEqual([
    "docker",
    "ps",
    "-q",
    "--no-trunc",
    "--filter",
    "label=openshell.ai/managed-by=openshell",
    "--filter",
    `label=openshell.ai/sandbox-name=${expected.sandbox}`,
    "--filter",
    "label=openshell.ai/isolation-role=sandbox",
  ]);
});
