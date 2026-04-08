// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pipeline orchestrator for the Dark NOC ops agents.
 *
 * Registered as a {@link PluginService} via `api.registerService()`.
 * Creates the event bus, instantiates each agent, manages lifecycle
 * (start / stop), and exposes aggregate health.
 */

import { readFileSync } from "node:fs";

import YAML from "yaml";

import type {
  OpenClawConfig,
  PluginLogger,
  PluginService,
} from "../index.js";
import { createEventBus } from "./event-bus.js";
import type {
  AgentHealth,
  InferenceClient,
  OpsAgent,
  OpsAgentContext,
  OpsConfig,
  OpsEventBus,
} from "./types.js";

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG_PATH = "/etc/nemoclaw/ops-config.yaml";

function resolveEnvVars(raw: string): string {
  return raw.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
    return process.env[name] ?? "";
  });
}

export function loadOpsConfig(configPath?: string): OpsConfig {
  const path = configPath ?? DEFAULT_CONFIG_PATH;
  const raw = readFileSync(path, "utf-8");
  const resolved = resolveEnvVars(raw);
  return YAML.parse(resolved) as OpsConfig;
}

// ---------------------------------------------------------------------------
// Inference client stub (delegates to the sandbox's inference endpoint)
// ---------------------------------------------------------------------------

export function createInferenceClient(
  config: OpsConfig,
  logger: PluginLogger,
): InferenceClient {
  const endpoint =
    process.env["INFERENCE_ENDPOINT"] ?? "http://localhost:18789/v1";
  const apiKey = process.env["INFERENCE_API_KEY"] ?? "";

  return {
    async chat(messages) {
      const res = await fetch(`${endpoint}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ messages, max_tokens: 2048 }),
      });

      if (!res.ok) {
        const body = await res.text();
        logger.error(`Inference request failed (${res.status}): ${body}`);
        throw new Error(`Inference error ${res.status}`);
      }

      const data = (await res.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      return data.choices[0]?.message?.content ?? "";
    },

    async embed(texts) {
      const res = await fetch(`${endpoint}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          input: texts,
          model: config.runbooks.vectorDb.embeddingModel,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        logger.error(`Embedding request failed (${res.status}): ${body}`);
        throw new Error(`Embedding error ${res.status}`);
      }

      const data = (await res.json()) as {
        data: Array<{ embedding: number[] }>;
      };
      return data.data.map((d) => d.embedding);
    },
  };
}

// ---------------------------------------------------------------------------
// Pipeline service
// ---------------------------------------------------------------------------

export interface PipelineState {
  bus: OpsEventBus;
  agents: OpsAgent[];
  running: boolean;
}

export function createOpsPipeline(
  agents: OpsAgent[],
  configPath?: string,
): PluginService {
  let state: PipelineState | null = null;

  return {
    id: "ops-pipeline",

    async start(ctx: { config: OpenClawConfig; logger: PluginLogger }) {
      const opsConfig = loadOpsConfig(configPath);

      if (!opsConfig.pipeline.enabled) {
        ctx.logger.info("Ops pipeline disabled in config — skipping start");
        return;
      }

      const bus = createEventBus();
      const inference = createInferenceClient(opsConfig, ctx.logger);

      const agentCtx: OpsAgentContext = {
        bus,
        config: opsConfig,
        logger: ctx.logger,
        inference,
      };

      ctx.logger.info(
        `Starting ops pipeline with ${agents.length} agent(s) in "${opsConfig.pipeline.mode}" mode`,
      );

      for (const agent of agents) {
        ctx.logger.info(`  Starting agent: ${agent.name}`);
        await agent.start(agentCtx);
      }

      state = { bus, agents, running: true };
      ctx.logger.info("Ops pipeline started");
    },

    async stop(ctx: { config: OpenClawConfig; logger: PluginLogger }) {
      if (!state?.running) return;

      ctx.logger.info("Stopping ops pipeline");
      for (const agent of [...state.agents].reverse()) {
        ctx.logger.info(`  Stopping agent: ${agent.name}`);
        await agent.stop();
      }

      state.running = false;
      ctx.logger.info("Ops pipeline stopped");
    },
  };
}

/** Retrieve health for all agents in a running pipeline. */
export function getPipelineHealth(
  pipelineState: PipelineState | null,
): AgentHealth[] {
  if (!pipelineState?.running) return [];
  return pipelineState.agents.map((a) => a.health());
}
