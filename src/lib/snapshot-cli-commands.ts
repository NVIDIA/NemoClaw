// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- thin oclif wrappers covered through CLI integration tests. */

import { Args, Command, Flags } from "@oclif/core";

import { runSandboxSnapshot } from "./sandbox-runtime-actions";

let runtimeBridgeFactory = () => ({ sandboxSnapshot: runSandboxSnapshot });

export function setSnapshotRuntimeBridgeFactoryForTest(
  factory: () => { sandboxSnapshot: (sandboxName: string, args: string[]) => Promise<void> },
): void {
  runtimeBridgeFactory = factory;
}

function getRuntimeBridge() {
  return runtimeBridgeFactory();
}

const sandboxNameArg = Args.string({
  name: "sandbox",
  description: "Sandbox name",
  required: true,
});

export class SnapshotCommand extends Command {
  static id = "sandbox:snapshot";
  static strict = true;
  static summary = "Show snapshot usage";
  static description = "Show snapshot usage for create, list, and restore subcommands.";
  static usage = ["<name> snapshot <create|list|restore>"];
  static examples = [
    "<%= config.bin %> alpha snapshot create",
    "<%= config.bin %> alpha snapshot list",
    "<%= config.bin %> alpha snapshot restore",
  ];
  static args = {
    sandboxName: sandboxNameArg,
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(SnapshotCommand);
    await getRuntimeBridge().sandboxSnapshot(args.sandboxName, []);
  }
}

export class SnapshotListCommand extends Command {
  static id = "sandbox:snapshot:list";
  static strict = true;
  static summary = "List available snapshots";
  static description = "List available snapshots for a sandbox.";
  static usage = ["<name> snapshot list"];
  static examples = ["<%= config.bin %> alpha snapshot list"];
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

export class SnapshotRestoreCommand extends Command {
  static id = "sandbox:snapshot:restore";
  static strict = true;
  static summary = "Restore state from a snapshot";
  static description = "Restore sandbox workspace state from a snapshot.";
  static usage = ["<name> snapshot restore [selector] [--to <dst>]"];
  static examples = [
    "<%= config.bin %> alpha snapshot restore",
    "<%= config.bin %> alpha snapshot restore v2",
    "<%= config.bin %> alpha snapshot restore before-upgrade --to beta",
  ];
  static args = {
    sandboxName: sandboxNameArg,
    selector: Args.string({
      name: "selector",
      description: "Snapshot version, name, or timestamp",
      required: false,
    }),
  };
  static flags = {
    help: Flags.help({ char: "h" }),
    to: Flags.string({ description: "Restore into another sandbox" }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(SnapshotRestoreCommand);
    const subArgs = ["restore"];
    if (args.selector) subArgs.push(args.selector);
    if (flags.to) subArgs.push("--to", flags.to);
    await getRuntimeBridge().sandboxSnapshot(args.sandboxName, subArgs);
  }
}

export class SnapshotCreateCommand extends Command {
  static id = "sandbox:snapshot:create";
  static strict = true;
  static summary = "Create a snapshot of sandbox state";
  static description = "Create an auto-versioned snapshot of sandbox workspace state.";
  static usage = ["<name> snapshot create [--name <label>]"];
  static examples = [
    "<%= config.bin %> alpha snapshot create",
    "<%= config.bin %> alpha snapshot create --name before-upgrade",
  ];
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
