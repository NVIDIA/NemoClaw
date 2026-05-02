// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- thin oclif wrappers covered through CLI integration tests. */

import { Args, Command, Flags } from "@oclif/core";

type RuntimeBridge = {
  sandboxSnapshot: (sandboxName: string, subArgs: string[]) => Promise<void>;
};

let runtimeBridgeFactory = (): RuntimeBridge => require("../nemoclaw") as RuntimeBridge;

export function setSnapshotRuntimeBridgeFactoryForTest(factory: () => RuntimeBridge): void {
  runtimeBridgeFactory = factory;
}

function getRuntimeBridge(): RuntimeBridge {
  return runtimeBridgeFactory();
}

const sandboxNameArg = Args.string({
  name: "sandbox",
  description: "Sandbox name",
  required: true,
});

export class SnapshotListCommand extends Command {
  static id = "sandbox:snapshot:list";
  static strict = true;
  static summary = "List available snapshots";
  static description = "List available snapshots for a sandbox.";
  static usage = ["<name> snapshot list"];
  static args = {
    sandboxName: sandboxNameArg,
  };
  static flags = {
    help: Flags.help({ char: "h" }),
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(SnapshotListCommand);
    await getRuntimeBridge().sandboxSnapshot(args.sandboxName, ["list"]);
  }
}

export class SnapshotCreateCommand extends Command {
  static id = "sandbox:snapshot:create";
  static strict = true;
  static summary = "Create a snapshot of sandbox state";
  static description = "Create an auto-versioned snapshot of sandbox workspace state.";
  static usage = ["<name> snapshot create [--name <label>]"];
  static args = {
    sandboxName: sandboxNameArg,
  };
  static flags = {
    help: Flags.help({ char: "h" }),
    name: Flags.string({ description: "Optional snapshot label" }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(SnapshotCreateCommand);
    const subArgs = ["create"];
    if (flags.name) {
      subArgs.push("--name", flags.name);
    }
    await getRuntimeBridge().sandboxSnapshot(args.sandboxName, subArgs);
  }
}
