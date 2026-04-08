// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import YAML from "yaml";

import type { OpenClawConfig, PluginLogger } from "../index.js";
import { createOpsPipeline, getPipelineHealth } from "./pipeline.js";
import type { AgentHealth, OpsAgent, OpsAgentContext, OpsConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockLogger(): PluginLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createMockAgent(id: string, name: string): OpsAgent & {
  startMock: ReturnType<typeof vi.fn>;
  stopMock: ReturnType<typeof vi.fn>;
} {
  const startMock = vi.fn<[OpsAgentContext], Promise<void>>().mockResolvedValue(undefined);
  const stopMock = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);
  let started = false;

  return {
    id,
    name,
    startMock,
    stopMock,
    async start(ctx: OpsAgentContext) {
      started = true;
      return startMock(ctx);
    },
    async stop() {
      started = false;
      return stopMock();
    },
    health(): AgentHealth {
      return {
        status: started ? "healthy" : "stopped",
        lastProcessedAt: null,
        eventsProcessed: 0,
        errorsCount: 0,
      };
    },
  };
}

function minimalOpsConfig(overrides?: Partial<OpsConfig>): OpsConfig {
  return {
    pipeline: { enabled: true, mode: "observe" },
    sources: {
      prometheus: {
        endpoint: "http://localhost:9090",
        scrapeIntervalSeconds: 30,
        queries: [],
      },
    },
    anomalyDetection: {
      windowSize: 60,
      deviationThreshold: 2.5,
      aiAssist: false,
      aiCheckIntervalSeconds: 300,
    },
    correlation: {
      timeWindowSeconds: 300,
      minSignals: 2,
      serviceGraph: {},
    },
    incident: { autoSeverity: true, minCorrelationScore: 0.6 },
    runbooks: {
      vectorDb: {
        type: "qdrant",
        endpoint: "http://localhost:6333",
        collection: "test",
        embeddingModel: "test-model",
      },
      directory: "/tmp/runbooks",
      similarityThreshold: 0.7,
    },
    teams: {
      tenantId: "test-tenant",
      clientId: "test-client",
      clientSecretEnv: "TEST_SECRET",
      teamId: "test-team",
      channelId: "test-channel",
      notificationMode: "text",
    },
    ...overrides,
  };
}

let configDir: string;
let configPath: string;

function writeConfig(config: OpsConfig): void {
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  writeFileSync(configPath, YAML.stringify(config));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createOpsPipeline", () => {
  beforeEach(() => {
    configDir = join(tmpdir(), `ops-test-${Date.now()}`);
    configPath = join(configDir, "ops-config.yaml");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts all agents in order", async () => {
    const config = minimalOpsConfig();
    writeConfig(config);

    const agent1 = createMockAgent("signal", "Signal Aggregator");
    const agent2 = createMockAgent("anomaly", "Anomaly Detector");
    const pipeline = createOpsPipeline([agent1, agent2], configPath);

    await pipeline.start!({ config: {} as OpenClawConfig, logger: createMockLogger() });

    expect(agent1.startMock).toHaveBeenCalledOnce();
    expect(agent2.startMock).toHaveBeenCalledOnce();

    const call1Order = agent1.startMock.mock.invocationCallOrder[0];
    const call2Order = agent2.startMock.mock.invocationCallOrder[0];
    expect(call1Order).toBeLessThan(call2Order!);
  });

  it("stops agents in reverse order", async () => {
    const config = minimalOpsConfig();
    writeConfig(config);

    const agent1 = createMockAgent("signal", "Signal Aggregator");
    const agent2 = createMockAgent("anomaly", "Anomaly Detector");
    const pipeline = createOpsPipeline([agent1, agent2], configPath);

    const logger = createMockLogger();
    await pipeline.start!({ config: {} as OpenClawConfig, logger });
    await pipeline.stop!({ config: {} as OpenClawConfig, logger });

    expect(agent2.stopMock).toHaveBeenCalledOnce();
    expect(agent1.stopMock).toHaveBeenCalledOnce();

    const stop2Order = agent2.stopMock.mock.invocationCallOrder[0];
    const stop1Order = agent1.stopMock.mock.invocationCallOrder[0];
    expect(stop2Order).toBeLessThan(stop1Order!);
  });

  it("skips start when pipeline.enabled is false", async () => {
    const config = minimalOpsConfig({ pipeline: { enabled: false, mode: "observe" } });
    writeConfig(config);

    const agent = createMockAgent("signal", "Signal Aggregator");
    const pipeline = createOpsPipeline([agent], configPath);

    const logger = createMockLogger();
    await pipeline.start!({ config: {} as OpenClawConfig, logger });

    expect(agent.startMock).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("disabled"),
    );
  });

  it("injects a shared event bus into all agents", async () => {
    const config = minimalOpsConfig();
    writeConfig(config);

    const agent1 = createMockAgent("signal", "Signal Aggregator");
    const agent2 = createMockAgent("anomaly", "Anomaly Detector");
    const pipeline = createOpsPipeline([agent1, agent2], configPath);

    await pipeline.start!({ config: {} as OpenClawConfig, logger: createMockLogger() });

    const ctx1 = agent1.startMock.mock.calls[0]![0] as OpsAgentContext;
    const ctx2 = agent2.startMock.mock.calls[0]![0] as OpsAgentContext;
    expect(ctx1.bus).toBe(ctx2.bus);
  });

  it("provides inference client in agent context", async () => {
    const config = minimalOpsConfig();
    writeConfig(config);

    const agent = createMockAgent("signal", "Signal Aggregator");
    const pipeline = createOpsPipeline([agent], configPath);

    await pipeline.start!({ config: {} as OpenClawConfig, logger: createMockLogger() });

    const ctx = agent.startMock.mock.calls[0]![0] as OpsAgentContext;
    expect(ctx.inference).toBeDefined();
    expect(typeof ctx.inference.chat).toBe("function");
    expect(typeof ctx.inference.embed).toBe("function");
  });
});

describe("getPipelineHealth", () => {
  it("returns empty array when pipeline is not running", () => {
    expect(getPipelineHealth(null)).toEqual([]);
  });

  it("returns health for all agents when running", () => {
    const agent1 = createMockAgent("signal", "Signal Aggregator");
    const agent2 = createMockAgent("anomaly", "Anomaly Detector");

    const health = getPipelineHealth({
      bus: {} as never,
      agents: [agent1, agent2],
      running: true,
    });

    expect(health).toHaveLength(2);
    expect(health[0]!.status).toBe("stopped");
    expect(health[1]!.status).toBe("stopped");
  });
});
