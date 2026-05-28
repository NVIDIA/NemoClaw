// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { GatewayReuseState } from "../state/gateway";
import * as trace from "../trace";

type TraceFn<T> = () => T;

const TRACE_TRUTHY_VALUES = new Set(["1", "true", "yes", "on"]);

export interface OnboardTraceOptions {
  resume?: boolean;
  fresh?: boolean;
  nonInteractive?: boolean;
  agent?: string | null;
}

export interface OnboardTraceHandle {
  collector: ReturnType<typeof trace.getTraceCollector>;
  span: ReturnType<NonNullable<ReturnType<typeof trace.getTraceCollector>>["startSpan"]> | null;
}

export function isTruthyTraceEnv(value: unknown): boolean {
  return TRACE_TRUTHY_VALUES.has(String(value ?? "").trim().toLowerCase());
}

function hasTracePath(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function startOnboardTrace(
  opts: OnboardTraceOptions,
  env: NodeJS.ProcessEnv,
): OnboardTraceHandle {
  const collector = trace.getTraceCollector();
  const span = collector?.startSpan("nemoclaw.onboard", {
    resume: opts.resume === true,
    fresh: opts.fresh === true,
    non_interactive: opts.nonInteractive === true || env.NEMOCLAW_NON_INTERACTIVE === "1",
    agent: opts.agent || env.NEMOCLAW_AGENT || null,
    trace_enabled: isTruthyTraceEnv(env.NEMOCLAW_TRACE),
    trace_file_enabled: hasTracePath(env.NEMOCLAW_TRACE_FILE),
    trace_dir_enabled: hasTracePath(env.NEMOCLAW_TRACE_DIR),
  });
  return { collector, span: span ?? null };
}

export function finishOnboardTrace(handle: OnboardTraceHandle, completed: boolean): void {
  if (!handle.span) return;
  handle.collector?.endSpan(handle.span, completed ? "OK" : "ERROR");
  trace.flushTrace(completed ? "OK" : "ERROR");
}

export function withPreflightTrace<T>(fn: TraceFn<T>): T {
  return trace.withTraceSpan("nemoclaw.onboard.phase.preflight", {}, fn);
}

export function withGatewayTrace<T>(
  reuseState: GatewayReuseState,
  gpuPassthrough: boolean,
  fn: TraceFn<T>,
): T {
  return trace.withTraceSpan(
    "nemoclaw.onboard.phase.gateway",
    { reuse_state: reuseState, gpu_passthrough: gpuPassthrough },
    fn,
  );
}

export function withProviderSelectionTrace<T>(
  sandboxName: string | null,
  agentName: string | null | undefined,
  fn: TraceFn<T>,
): T {
  return trace.withTraceSpan(
    "nemoclaw.onboard.phase.provider_selection",
    { sandbox_name: sandboxName, agent: agentName ?? null },
    fn,
  );
}

export function withInferenceTrace<T>(
  sandboxName: string,
  provider: string,
  model: string,
  credentialEnv: string | null,
  fn: TraceFn<T>,
): T {
  return trace.withTraceSpan(
    "nemoclaw.onboard.phase.inference",
    { sandbox_name: sandboxName, provider, model, credential_env: credentialEnv },
    fn,
  );
}

export function withSandboxPhaseTrace<T>(
  sandboxName: string,
  provider: string,
  model: string,
  agentName: string | null | undefined,
  fn: TraceFn<T>,
): T {
  return trace.withTraceSpan(
    "nemoclaw.onboard.phase.sandbox",
    { sandbox_name: sandboxName, provider, model, agent: agentName ?? null },
    fn,
  );
}

export function withSandboxCreateStreamTrace<T>(
  attrs: {
    sandboxName: string;
    provider: string;
    model: string;
    timeoutSeconds: number;
    fromDockerfile: boolean;
    gpuEnabled: boolean;
  },
  fn: TraceFn<T>,
): T {
  return trace.withTraceSpan(
    "nemoclaw.sandbox.create_stream",
    {
      sandbox_name: attrs.sandboxName,
      provider: attrs.provider,
      model: attrs.model,
      timeout_seconds: attrs.timeoutSeconds,
      from_dockerfile: attrs.fromDockerfile,
      gpu_enabled: attrs.gpuEnabled,
    },
    fn,
  );
}

export function withSandboxReadinessTrace<T>(
  sandboxName: string,
  attrs: Record<string, unknown>,
  fn: TraceFn<T>,
): T {
  return trace.withTraceSpan(
    "nemoclaw.sandbox.readiness_wait",
    { sandbox_name: sandboxName, ...attrs },
    fn,
  );
}

export function withDashboardReadinessTrace<T>(
  sandboxName: string,
  port: string | number,
  attempts: number,
  fn: TraceFn<T>,
): T {
  return trace.withTraceSpan(
    "nemoclaw.dashboard.readiness_wait",
    { sandbox_name: sandboxName, port, attempts },
    fn,
  );
}

export function withPolicyApplicationTrace<T>(
  sandboxName: string,
  options: { selectedPresets?: unknown; provider?: unknown; webSearchSupported?: unknown },
  fn: TraceFn<T>,
): T {
  return trace.withTraceSpan(
    "nemoclaw.policy.application",
    {
      sandbox_name: sandboxName,
      selected_presets: options.selectedPresets ?? null,
      provider: options.provider ?? null,
      web_search_supported: options.webSearchSupported ?? null,
    },
    fn,
  );
}

export const addTraceEvent = trace.addTraceEvent;
