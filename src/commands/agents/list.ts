// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { printAgentRuntimeList } from "../../lib/agent/list-command";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";

export default class AgentsListCommand extends NemoClawCommand {
  static id = "agents:list";
  static strict = true;
  static summary = "List available agent runtimes for onboard --agent";
  static description = "List installed agent runtimes that can be selected with onboard --agent.";
  static usage = ["agents list"];
  static examples = ["<%= config.bin %> agents list"];
  static flags = {};

  public async run(): Promise<void> {
    await this.parse(AgentsListCommand);
    printAgentRuntimeList(this.log.bind(this));
  }
}
