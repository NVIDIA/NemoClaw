// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";
import type { ContainerEngineCommandCapture } from "../../src/lib/adapters/container-engine";

function contextInspection(host: string) {
  return {
    status: 0,
    stdout: JSON.stringify({
      Endpoints: { docker: { Host: host, SkipTLSVerify: false } },
      TLSMaterial: { docker: [] },
    }),
    stderr: "",
  };
}

export function createContextCapture(
  host: string,
): ReturnType<typeof vi.fn<ContainerEngineCommandCapture>> {
  return vi.fn<ContainerEngineCommandCapture>((_executable, args) => {
    if (args.includes("inspect")) return contextInspection(host);
    return { status: 0, stdout: "", stderr: "" };
  });
}

export function createDriftingContextCapture(): ReturnType<
  typeof vi.fn<ContainerEngineCommandCapture>
> {
  let inspections = 0;
  return vi.fn<ContainerEngineCommandCapture>((_executable, args) => {
    if (args.includes("inspect")) {
      inspections += 1;
      return contextInspection(`ssh://nvidia@spark-${String(inspections)}.example.test`);
    }
    return { status: 0, stdout: "", stderr: "" };
  });
}
