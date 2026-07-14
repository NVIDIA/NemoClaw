// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ChannelHookOutputSpec,
  ChannelHookSpec,
  MessagingSerializableValue,
} from "../manifest";
import { MessagingHookRegistry } from "./registry";
import type {
  MessagingHookOutputMap,
  MessagingHookOutputValue,
  MessagingHookRunContext,
  MessagingHookRunResult,
} from "./types";

const EMPTY_OUTPUTS: MessagingHookOutputMap = Object.freeze({});

export async function runMessagingHook(
  hook: ChannelHookSpec,
  registry: MessagingHookRegistry,
  context: MessagingHookRunContext,
): Promise<MessagingHookRunResult> {
  const handler = registry.require(hook.handler);
  const result = await handler(buildHandlerContext(hook, context));
  const outputs = result.outputs ?? EMPTY_OUTPUTS;

  assertHookOutputsMatchDeclaration(hook, outputs);

  return {
    hookId: hook.id,
    handlerId: hook.handler,
    phase: hook.phase,
    outputs,
  };
}

export function runMessagingHookSync(
  hook: ChannelHookSpec,
  registry: MessagingHookRegistry,
  context: MessagingHookRunContext,
): MessagingHookRunResult {
  const handler = registry.require(hook.handler);
  const result = handler(buildHandlerContext(hook, context));
  if (isPromiseLike(result)) {
    throw new Error(`Messaging hook '${hook.id}' returned a Promise in a synchronous phase.`);
  }
  const outputs = result.outputs ?? EMPTY_OUTPUTS;

  assertHookOutputsMatchDeclaration(hook, outputs);

  return {
    hookId: hook.id,
    handlerId: hook.handler,
    phase: hook.phase,
    outputs,
  };
}

function buildHandlerContext(hook: ChannelHookSpec, context: MessagingHookRunContext) {
  return {
    channelId: context.channelId,
    hookId: hook.id,
    phase: hook.phase,
    ...(typeof context.isInteractive === "boolean" ? { isInteractive: context.isInteractive } : {}),
    inputs: context.inputs,
    outputDeclarations: hook.outputs,
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function assertHookOutputsMatchDeclaration(
  hook: ChannelHookSpec,
  outputs: MessagingHookOutputMap,
): void {
  const declarations = new Map((hook.outputs ?? []).map((output) => [output.id, output]));

  for (const declaration of hook.outputs ?? []) {
    if (declaration.required && !Object.hasOwn(outputs, declaration.id)) {
      throw new Error(`Hook '${hook.id}' missing required output '${declaration.id}'`);
    }
  }

  for (const [outputId, output] of Object.entries(outputs)) {
    const declaration = declarations.get(outputId);
    if (!declaration) {
      throw new Error(`Hook '${hook.id}' returned undeclared output '${outputId}'`);
    }
    assertOutputMatchesDeclaration(hook, outputId, output, declaration);
  }
}

function assertOutputMatchesDeclaration(
  hook: ChannelHookSpec,
  outputId: string,
  output: MessagingHookOutputValue,
  declaration: ChannelHookOutputSpec,
): void {
  if (output.kind !== declaration.kind) {
    throw new Error(
      `Hook '${hook.id}' output '${outputId}' kind '${output.kind}' does not match declared kind '${declaration.kind}'`,
    );
  }
  if (!isMessagingSerializableValue(output.value)) {
    throw new Error(`Hook '${hook.id}' output '${outputId}' is not serializable`);
  }
}

function isMessagingSerializableValue(
  value: unknown,
  visiting: WeakSet<object> = new WeakSet(),
): value is MessagingSerializableValue {
  if (value === null) return true;

  const valueType = typeof value;
  if (valueType === "string" || valueType === "boolean") return true;
  if (valueType === "number") return Number.isFinite(value);
  if (valueType !== "object") return false;

  const objectValue = value as object;
  if (visiting.has(objectValue)) return false;
  visiting.add(objectValue);

  try {
    if (Array.isArray(value)) {
      return value.every((entry) => isMessagingSerializableValue(entry, visiting));
    }

    const prototype = Object.getPrototypeOf(objectValue);
    if (prototype !== Object.prototype && prototype !== null) return false;

    return Object.values(objectValue).every((entry) =>
      isMessagingSerializableValue(entry, visiting),
    );
  } finally {
    visiting.delete(objectValue);
  }
}
