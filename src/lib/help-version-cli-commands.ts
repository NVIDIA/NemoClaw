// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- thin oclif adapters covered through CLI integration tests. */

import { Command } from "@oclif/core";

import { getNemoClawRuntimeBridge } from "./nemoclaw-runtime-bridge";

export class RootHelpCommand extends Command {
  static id = "root:help";
  static hidden = true;
  static strict = false;
  static summary = "Show help";

  public async run(): Promise<void> {
    this.parsed = true;
    getNemoClawRuntimeBridge().help();
  }
}

export class VersionCommand extends Command {
  static id = "root:version";
  static hidden = true;
  static strict = true;
  static summary = "Show version";

  public async run(): Promise<void> {
    this.parsed = true;
    getNemoClawRuntimeBridge().version();
  }
}
