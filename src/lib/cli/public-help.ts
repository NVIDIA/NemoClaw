// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CommandHelp, Help, type Command, type Interfaces } from "@oclif/core";

import { sandboxRouteTokens } from "./public-route-metadata";

export const PUBLIC_HELP_SANDBOX_NAME_PROPERTY = "nemoclawPublicSandboxName";

const SANDBOX_COMMAND_PREFIX = "sandbox:";
const COMMAND_EXAMPLE_PREFIX = "<%= config.bin %> ";
const SANDBOX_EXAMPLE_PREFIX = `${COMMAND_EXAMPLE_PREFIX}sandbox `;
const SANDBOX_NAME_PLACEHOLDER = "<name>";
const SANDBOX_NAME_TEMPLATE_VALUE = "NEMOCLAW_SANDBOX_NAME";

function standardCommandId(commandId: string, topicSeparator: string): string {
  return topicSeparator === ":" ? commandId : commandId.replaceAll(topicSeparator, ":");
}

function publicSandboxName(config: Interfaces.Config): string {
  const oclif = config.pjson.oclif as Record<string, unknown> | undefined;
  const name = oclif?.[PUBLIC_HELP_SANDBOX_NAME_PROPERTY];
  return typeof name === "string" && name.length > 0 ? name : SANDBOX_NAME_PLACEHOLDER;
}

function publicCommandId(
  commandId: string,
  sandboxName: string,
  topicSeparator: string,
): string | null {
  const standardId = standardCommandId(commandId, topicSeparator);
  const route = sandboxRouteTokens(standardId);
  return route ? [sandboxName, ...route].join(":") : null;
}

function publicUsageSuffix(usage: string, commandId: string, route: readonly string[]): string {
  const tokens = usage.trim().split(/\s+/);
  const nameIndex = tokens.findIndex((token) => /^<(?:name|sandbox|sandbox-name)>$/i.test(token));
  if (nameIndex !== -1) tokens.splice(nameIndex, 1);

  const standardId = commandId.slice(SANDBOX_COMMAND_PREFIX.length).split(":");
  const prefixes = [route, standardId];
  const prefix = prefixes.find(
    (candidate) =>
      candidate.length > 0 && candidate.every((token, index) => tokens[index] === token),
  );
  if (prefix) tokens.splice(0, prefix.length);
  return tokens.join(" ");
}

function sandboxCommandIds(
  commands: readonly Command.Loadable[],
  currentCommandId: string,
  topicSeparator: string,
): string[] {
  return [currentCommandId, ...commands.map((command) => command.id)]
    .map((commandId) => standardCommandId(commandId, topicSeparator))
    .filter(
      (commandId, index, all) =>
        commandId.startsWith(SANDBOX_COMMAND_PREFIX) && all.indexOf(commandId) === index,
    )
    .sort((left, right) => right.split(":").length - left.split(":").length);
}

function publicExample(
  example: string,
  sandboxName: string,
  commandIds: readonly string[],
): string {
  const markerIndex = example.indexOf(SANDBOX_EXAMPLE_PREFIX);
  if (markerIndex !== -1) {
    const invocation = example.slice(markerIndex + SANDBOX_EXAMPLE_PREFIX.length);
    for (const commandId of commandIds) {
      const nativeRoute = commandId.slice(SANDBOX_COMMAND_PREFIX.length).replaceAll(":", " ");
      if (invocation !== nativeRoute && !invocation.startsWith(`${nativeRoute} `)) continue;

      const remainder = invocation.slice(nativeRoute.length).trimStart();
      const match = remainder.match(/^(\S+)([\s\S]*)$/);
      const route = sandboxRouteTokens(commandId);
      if (!match || !route) continue;

      const exampleSandboxName = sandboxName === SANDBOX_NAME_PLACEHOLDER ? match[1] : sandboxName;
      const replacement = `<%= config.bin %> ${exampleSandboxName} ${route.join(" ")}${match[2]}`;
      return `${example.slice(0, markerIndex)}${replacement}`;
    }
  }

  if (sandboxName === SANDBOX_NAME_PLACEHOLDER) return example;
  const commandMarkerIndex = example.indexOf(COMMAND_EXAMPLE_PREFIX);
  if (commandMarkerIndex === -1) return example;
  const publicInvocation = example.slice(commandMarkerIndex + COMMAND_EXAMPLE_PREFIX.length);
  const publicMatch = publicInvocation.match(/^(\S+)\s+([\s\S]+)$/);
  if (!publicMatch) return example;
  const publicArguments = publicMatch[2];
  const matchesRoute = commandIds.some((commandId) => {
    const route = sandboxRouteTokens(commandId)?.join(" ");
    return route && (publicArguments === route || publicArguments.startsWith(`${route} `));
  });
  if (matchesRoute) {
    return `${example.slice(0, commandMarkerIndex)}${COMMAND_EXAMPLE_PREFIX}${sandboxName} ${publicArguments}`;
  }

  return example;
}

function publicExamples(
  examples: Command.Example[] | undefined,
  sandboxName: string,
  commandIds: readonly string[],
): Command.Example[] | undefined {
  return examples?.map((example) =>
    typeof example === "string"
      ? publicExample(example, sandboxName, commandIds)
      : { ...example, command: publicExample(example.command, sandboxName, commandIds) },
  );
}

class PublicCommandHelp extends CommandHelp {
  public override generate(): string {
    const separator = this.config.topicSeparator || ":";
    const commandId = standardCommandId(this.command.id, separator);
    const route = sandboxRouteTokens(commandId);
    if (!route) return super.generate();

    const sandboxName = publicSandboxName(this.config);
    const originalId = this.command.id;
    const originalUsage = this.command.usage;
    const originalExamples = this.command.examples;
    const commandIds = sandboxCommandIds(this.config.commands, commandId, separator);
    const templateSandboxName =
      sandboxName === SANDBOX_NAME_PLACEHOLDER ? SANDBOX_NAME_TEMPLATE_VALUE : sandboxName;
    this.command.id = [templateSandboxName, ...route].join(separator);
    if (originalUsage) {
      const usages = Array.isArray(originalUsage) ? originalUsage : [originalUsage];
      this.command.usage = usages.map((usage) => publicUsageSuffix(usage, commandId, route));
    }
    this.command.examples = publicExamples(originalExamples, sandboxName, commandIds);

    try {
      return super.generate().replaceAll(SANDBOX_NAME_TEMPLATE_VALUE, SANDBOX_NAME_PLACEHOLDER);
    } finally {
      this.command.id = originalId;
      this.command.usage = originalUsage;
      this.command.examples = originalExamples;
    }
  }
}

export default class PublicHelp extends Help {
  protected override CommandHelpClass = PublicCommandHelp;

  protected override formatCommands(commands: Command.Loadable[]): string {
    const sandboxName = publicSandboxName(this.config);
    const separator = this.config.topicSeparator || ":";
    return super.formatCommands(
      commands.map((command) => {
        const id = publicCommandId(command.id, sandboxName, separator);
        return id ? { ...command, id } : command;
      }),
    );
  }
}
