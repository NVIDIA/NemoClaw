// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test as it } from "../helpers/owned-test-resources";

import { runWithEnv, testTimeoutOptions } from "./helpers";

describe("sandbox help", () => {
  it(
    "renders sandbox-first usage and examples for exec",
    testTimeoutOptions(15_000),
    ({ testHome }) => {
      const result = runWithEnv("my-assistant exec --help", testHome.environment());

      expect(result.code).toBe(0);
      expect(result.out).toContain("$ nemoclaw my-assistant exec [--workdir <dir>]");
      expect(result.out).toContain(
        "$ nemoclaw my-assistant exec -- openclaw agent --agent main -m hi",
      );
      expect(result.out).toContain("printf 'hello' | nemoclaw my-assistant exec --stdin -- cat");
      expect(result.out).not.toContain("nemoclaw sandbox exec");
    },
  );

  it(
    "renders the invoked sandbox name once in nested command usage and examples",
    testTimeoutOptions(15_000),
    ({ testHome }) => {
      const command = runWithEnv("inference-box inference get --help", testHome.environment());

      expect(command.code).toBe(0);
      expect(command.out).toContain("$ nemoclaw inference-box inference get [--json]");
      expect(command.out).toContain("$ nemoclaw inference-box inference get --json");
      expect(command.out).not.toContain("$ nemoclaw sandbox inference get");
      expect(command.out).not.toContain("$ nemoclaw my-assistant inference get");
      expect(command.out).not.toContain("inference get inference get");
    },
  );
});
