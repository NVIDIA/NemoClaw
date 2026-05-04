// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- thin oclif adapters covered through CLI integration tests. */

import { Command } from "@oclif/core";

import {
  runOnboardAction,
  runSetupAction,
  runSetupJetsonAction,
  runSetupSparkAction,
} from "./global-cli-actions";

export class OnboardCliCommand extends Command {
  static id = "onboard";
  static strict = false;
  static summary = "Configure inference endpoint and credentials";
  static description = "Configure inference, credentials, and sandbox settings.";
  static usage = ["onboard [flags]"];

  public async run(): Promise<void> {
    this.parsed = true;
    await runOnboardAction(this.argv);
  }
}

export class SetupCliCommand extends Command {
  static id = "setup";
  static strict = false;
  static summary = "Deprecated alias for nemoclaw onboard";
  static description = "Deprecated alias for onboard.";
  static usage = ["setup [flags]"];

  public async run(): Promise<void> {
    this.parsed = true;
    await runSetupAction(this.argv);
  }
}

export class SetupSparkCliCommand extends Command {
  static id = "setup-spark";
  static strict = false;
  static summary = "Deprecated alias for nemoclaw onboard";
  static description = "Deprecated alias for onboard.";
  static usage = ["setup-spark [flags]"];

  public async run(): Promise<void> {
    this.parsed = true;
    await runSetupSparkAction(this.argv);
  }
}

export class SetupJetsonCliCommand extends Command {
  static id = "setup-jetson";
  static strict = false;
  static summary = "Set up NVIDIA Jetson host (Docker runtime + iptables-legacy)";
  static description =
    "Configure Docker NVIDIA runtime, kernel modules, and iptables-legacy for k3s on Jetson devices (Orin Nano, Orin NX, AGX Orin, Xavier, Thor). Run with sudo before nemoclaw onboard.";
  static usage = ["setup-jetson"];

  public async run(): Promise<void> {
    this.parsed = true;
    runSetupJetsonAction();
  }
}
