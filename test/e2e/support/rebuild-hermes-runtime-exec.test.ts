// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildHermesRuntimeExecArgs } from "../live/rebuild-hermes-runtime-exec.ts";

describe("Hermes rebuild direct runtime exec", () => {
  it("uses the managed sandbox user and explicit Hermes state paths", () => {
    expect(
      buildHermesRuntimeExecArgs("container-id", ["hermes", "kanban", "list", "--json"]),
    ).toEqual([
      "exec",
      "--user",
      "sandbox",
      "--env",
      "HOME=/sandbox",
      "--env",
      "HERMES_HOME=/sandbox/.hermes",
      "--env",
      "HERMES_KANBAN_HOME=/sandbox/.hermes",
      "--env",
      "HERMES_KANBAN_DB=/sandbox/.hermes/kanban.db",
      "container-id",
      "hermes",
      "kanban",
      "list",
      "--json",
    ]);
  });
});
