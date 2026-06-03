// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { redactSensitiveText } from "../../security/redact";
import {
  addOnboardMachineEventListener,
  emitOnboardMachineEvent,
  sanitizeOnboardMachineEventMetadata,
  type OnboardMachineEvent,
  type OnboardMachineEventListener,
} from "./events";

export interface OnboardHook {
  name?: string;
  onEvent?(event: OnboardMachineEvent): Promise<void> | void;
}

export interface OnboardHookDispatchOptions {
  warn?: (message: string) => void;
  emitEvent?: (event: OnboardMachineEvent) => void;
  now?: () => string;
}

export interface OnboardHookRegistrationOptions extends OnboardHookDispatchOptions {
  includeHookEvents?: boolean;
}

function hookName(hook: OnboardHook, index: number): string {
  const name = typeof hook.name === "string" ? hook.name.trim() : "";
  return name || `hook-${index + 1}`;
}

function hookLifecycleEvent(
  source: OnboardMachineEvent,
  type: "hook.started" | "hook.completed" | "hook.failed",
  hook: OnboardHook,
  index: number,
  options: {
    occurredAt: string;
    error?: unknown;
    metadata?: Record<string, unknown>;
  },
): OnboardMachineEvent {
  return {
    version: 1,
    type,
    occurredAt: options.occurredAt,
    sessionId: source.sessionId,
    state: source.state,
    step: source.step,
    context: source.context,
    error: redactSensitiveText(options.error instanceof Error ? options.error.message : options.error),
    metadata: sanitizeOnboardMachineEventMetadata({
      hook: hookName(hook, index),
      sourceType: source.type,
      ...options.metadata,
    }),
  };
}

function isHookLifecycleEvent(event: OnboardMachineEvent): boolean {
  return event.type === "hook.started" || event.type === "hook.completed" || event.type === "hook.failed";
}

export class OnboardHookDispatcher {
  private readonly hooks: readonly OnboardHook[];
  private readonly warn: (message: string) => void;
  private readonly emitEvent: (event: OnboardMachineEvent) => void;
  private readonly now: () => string;

  constructor(hooks: readonly OnboardHook[], options: OnboardHookDispatchOptions = {}) {
    this.hooks = hooks;
    this.warn = options.warn ?? ((message) => console.warn(message));
    this.emitEvent = options.emitEvent ?? emitOnboardMachineEvent;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async dispatch(event: OnboardMachineEvent): Promise<void> {
    const shouldEmitLifecycle = !isHookLifecycleEvent(event);
    for (const [index, hook] of this.hooks.entries()) {
      if (typeof hook.onEvent !== "function") continue;
      if (shouldEmitLifecycle) {
        this.emitEvent(
          hookLifecycleEvent(event, "hook.started", hook, index, {
            occurredAt: this.now(),
          }),
        );
      }
      try {
        await hook.onEvent(event);
        if (shouldEmitLifecycle) {
          this.emitEvent(
            hookLifecycleEvent(event, "hook.completed", hook, index, {
              occurredAt: this.now(),
            }),
          );
        }
      } catch (error) {
        const name = hookName(hook, index);
        const message = error instanceof Error ? error.message : String(error);
        this.warn(`Onboard hook '${name}' failed: ${redactSensitiveText(message) ?? "<redacted>"}`);
        if (shouldEmitLifecycle) {
          this.emitEvent(
            hookLifecycleEvent(event, "hook.failed", hook, index, {
              occurredAt: this.now(),
              error: message,
            }),
          );
        }
      }
    }
  }
}

export function registerOnboardHooks(
  hooks: readonly OnboardHook[],
  options: OnboardHookRegistrationOptions = {},
): () => void {
  const dispatcher = new OnboardHookDispatcher(hooks, options);
  const listener: OnboardMachineEventListener = (event) => {
    if (options.includeHookEvents !== true && isHookLifecycleEvent(event)) return;
    void dispatcher.dispatch(event);
  };
  return addOnboardMachineEventListener(listener);
}

export function createJsonlOnboardHook(filePath: string): OnboardHook {
  const resolvedPath = path.resolve(filePath);
  return {
    name: "jsonl",
    onEvent(event) {
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true, mode: 0o700 });
      fs.appendFileSync(resolvedPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    },
  };
}
