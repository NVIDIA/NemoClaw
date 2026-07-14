// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Process-wide registry of in-flight asynchronous terminal prompts.
 *
 * Async prompts (readline-based) yield the event loop while waiting for the
 * user, so unrelated timers — like the onboarding phase heartbeat — can write
 * to the terminal mid-prompt and corrupt the menu the user is answering
 * (#6651). Prompt implementations register here for the lifetime of each
 * question so background writers can hold their output while a prompt owns
 * the terminal.
 *
 * Synchronous prompts (`core/stdin.ts`) block the event loop outright and
 * cannot be interrupted by timers, so they do not need to register.
 */

let activePromptCount = 0;

/**
 * Record that an async prompt now owns the terminal. Returns a release
 * function that must be called exactly once when the prompt settles;
 * duplicate releases are ignored so error paths can call it defensively.
 */
export function markPromptActive(): () => void {
  activePromptCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activePromptCount = Math.max(0, activePromptCount - 1);
  };
}

/**
 * Register prompt activity and release it before running terminal cleanup.
 * Releasing first lets cleanup callbacks safely observe the settled state.
 */
export function createPromptActivityCleanup(cleanup: () => void): () => void {
  const releasePromptActivity = markPromptActive();
  return () => {
    releasePromptActivity();
    cleanup();
  };
}

/** True while any registered async prompt is awaiting user input. */
export function isAnyPromptActive(): boolean {
  return activePromptCount > 0;
}
