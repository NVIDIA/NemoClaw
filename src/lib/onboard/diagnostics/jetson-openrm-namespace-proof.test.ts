// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { runJetsonOpenRmNamespaceProof } from "./jetson-openrm-namespace-proof";

describe("Jetson OpenRM namespace proof", () => {
  it("isolates the OpenShell network namespace from direct Docker execution (#7610)", () => {
    const dockerRun = vi.fn((args: readonly string[]) => ({
      status: 0,
      stdout: `cuInit(0)=${args.at(-1) === "net-namespace" ? "801" : "0"}`,
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    runJetsonOpenRmNamespaceProof("a".repeat(64), dockerRun);

    expect(dockerRun).toHaveBeenCalledTimes(8);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("net-namespace"));
  });

  it("reports missing namespace probes with their exact mode (#7610)", () => {
    const dockerRun = vi.fn(() => ({ status: 1, stderr: "setns denied" }));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    runJetsonOpenRmNamespaceProof("b".repeat(64), dockerRun);

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("namespace_case_error[net-namespace]"),
    );
    expect(error).toHaveBeenCalledWith(expect.stringContaining("baseline did not pass"));
  });
});
