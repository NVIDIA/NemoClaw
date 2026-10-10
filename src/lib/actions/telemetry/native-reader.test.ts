// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, it, vi } from "vitest";
import { createSupervisedSandboxCommandReader } from "./native-reader";

afterEach(() => vi.restoreAllMocks());

it("preserves process Ctrl+C termination after forwarding to native captures (#12859)", () => {
  const before = new Set(process.listeners("SIGINT"));
  const reader = createSupervisedSandboxCommandReader(new AbortController().signal, true);
  try {
    const forward = process.listeners("SIGINT").find((listener) => !before.has(listener));
    expect(forward).toBeDefined();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

    forward!("SIGINT");

    expect(kill).toHaveBeenCalledWith(process.pid, "SIGINT");
    expect(process.listeners("SIGINT")).not.toContain(forward);
  } finally {
    reader.dispose();
  }
});

it("preserves process SIGTERM termination after forwarding to native captures", () => {
  const before = new Set(process.listeners("SIGTERM"));
  const reader = createSupervisedSandboxCommandReader(new AbortController().signal, true);
  try {
    const forward = process.listeners("SIGTERM").find((listener) => !before.has(listener));
    expect(forward).toBeDefined();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

    forward!("SIGTERM");

    expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
    expect(process.listeners("SIGTERM")).not.toContain(forward);
  } finally {
    reader.dispose();
  }
});

it("does not terminate the process when native evidence is cancelled", () => {
  const controller = new AbortController();
  const reader = createSupervisedSandboxCommandReader(controller.signal, true);
  try {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

    controller.abort();

    expect(kill).not.toHaveBeenCalled();
  } finally {
    reader.dispose();
  }
});
