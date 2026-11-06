// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const installer = path.join(import.meta.dirname, "../..", "scripts", "install.sh");

it("limits prepared upgrade guidance to eligible gateways and preserves legacy state", async () => {
  const { stderr, stdout } = await promisify(execFile)("bash", [installer, "--help"], {
    encoding: "utf-8",
    env: process.env,
  });
  expect(stderr).toBe("");
  expect(stdout).toContain(
    "the installed OpenShell version must be verifiable and within the supported range",
  );
  expect(stdout).toContain(
    "This flag does not migrate registered sandboxes from an out-of-range OpenShell version",
  );
  expect(stdout).toContain("Retained NemoClaw sandbox records still block component replacement");
  expect(stdout).toContain("Preserve the legacy gateway, registrations, sandbox records, and data");
  expect(stdout).not.toContain("openshell gateway destroy");
  expect(stdout).not.toContain("nemoclaw backup-all --retire-legacy-forwards");
});
