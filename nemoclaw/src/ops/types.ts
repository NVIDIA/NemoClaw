// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared type definitions for the Dark NOC ops pipeline.
 *
 * Every agent in the pipeline produces and consumes strongly typed events.
 * These interfaces form the contract between agents and are the foundation
 * for the typed event bus channels.
 */

import type { OpenClawConfig, PluginLogger } from "../index.js";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export type Severity = "info" | "warning" | "critical" | "unknown";

export type EventSource =
  | "prometheus"
  | "otel-traces"
  | "otel-logs"
  | "otel-metrics";

export type AnomalyType =
  | "baseline_drift"
  | "spike"
  | "drop"
  | "seasonality_break"
  | "pattern_change";

export type CauseCategory =
  | "cache"
  | "database"
  | "network"
  | "compute"
  | "config"
  | "dependency"
  | "unknown";

export type IncidentPriority = "P1" | "P2" | "P3" | "P4";

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

export interface MetricPayload {
  name: string;
  value: number;
  unit: string;
  aggregation: "instant" | "rate" | "histogram" | "summary";
}

export interface LogPayload {
  level: string;
  message: string;
  traceId?: string;
  spanId?: string;
  attributes: Record<string, string>;
}

export interface TracePayload {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operationName: string;
  durationMs: number;
  status: "ok" | "error" | "unset";
  attributes: Record<string, string>;
}

/** BFF-specific enrichment attached to events from Spring Boot / Micrometer. */
export interface BffContext {
  downstreamService?: string;
  aggregationLatencyMs?: number;
  payloadSizeBytes?: number;
  tokenEndpoint?: string;
  cacheHitRatio?: number;
}

// ---------------------------------------------------------------------------
// Pipeline events (flow through the event bus)
// ---------------------------------------------------------------------------

/** Agent 1 output — normalized signal from Prometheus or OTel. */
export interface OpsEvent {
  id: string;
  timestamp: string;
  source: EventSource;
  cluster: string;
  namespace: string;
  service: string;
  eventType: "metric" | "log" | "trace" | "span";
  severity: Severity;
  payload: MetricPayload | LogPayload | TracePayload;
  labels: Record<string, string>;
  bffContext?: BffContext;
}

/** Agent 2 output — a detected deviation from normal behavior. */
export interface AnomalySignal {
  id: string;
  timestamp: string;
  triggerEvents: string[];
  service: string;
  anomalyType: AnomalyType;
  metric: string;
  expected: number;
  actual: number;
  deviationPct: number;
  confidence: number;
  context: string;
}

/** A single ranked root cause hypothesis. */
export interface RankedCause {
  description: string;
  likelihood: number;
  evidence: string[];
  category: CauseCategory;
}

/** Agent 3 output — correlated anomalies with ranked root causes. */
export interface CorrelationResult {
  id: string;
  timestamp: string;
  signals: string[];
  rootCauses: RankedCause[];
  affectedServices: string[];
  correlationScore: number;
}

/** A single entry in an incident timeline. */
export interface TimelineEntry {
  timestamp: string;
  description: string;
  service: string;
  metric?: string;
}

/** Agent 4 output — human-readable incident narrative. */
export interface Incident {
  id: string;
  timestamp: string;
  correlationId: string;
  title: string;
  narrative: string;
  severity: Severity;
  suggestedPriority: IncidentPriority;
  affectedServices: string[];
  timeline: TimelineEntry[];
}

/** A runbook scored by vector similarity. */
export interface ScoredRunbook {
  runbookId: string;
  title: string;
  similarity: number;
  steps: string[];
  source: "sop-library" | "past-incident";
  lastUsed: string | null;
  successRate: number | null;
}

/** Agent 5 output — matched runbooks for an incident. */
export interface RunbookMatch {
  incidentId: string;
  matches: ScoredRunbook[];
}

/** Inbound request from Teams to the L2 Copilot. */
export interface CopilotRequest {
  id: string;
  timestamp: string;
  senderId: string;
  senderName: string;
  question: string;
  incidentId?: string;
  threadId?: string;
}

/** L2 Copilot response back to Teams. */
export interface CopilotResponse {
  requestId: string;
  answer: string;
  suggestedQueries?: string[];
  relatedRunbooks?: string[];
}

// ---------------------------------------------------------------------------
// Event bus channel map (type-safe channel → payload mapping)
// ---------------------------------------------------------------------------

export interface OpsChannelMap {
  "ops:events": OpsEvent;
  "ops:anomalies": AnomalySignal;
  "ops:correlations": CorrelationResult;
  "ops:incidents": Incident;
  "ops:runbook-matches": RunbookMatch;
  "ops:copilot-requests": CopilotRequest;
}

export type OpsChannel = keyof OpsChannelMap;

// ---------------------------------------------------------------------------
// Agent contract
// ---------------------------------------------------------------------------

/** Inference client wrapping the NemoClaw-registered provider. */
export interface InferenceClient {
  chat(messages: ChatMessage[]): Promise<string>;
  embed(texts: string[]): Promise<number[][]>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AgentHealth {
  status: "healthy" | "degraded" | "stopped";
  lastProcessedAt: string | null;
  eventsProcessed: number;
  errorsCount: number;
}

/** Context injected into every agent at startup. */
export interface OpsAgentContext {
  bus: OpsEventBus;
  config: OpsConfig;
  logger: PluginLogger;
  inference: InferenceClient;
}

/** Lifecycle interface every ops agent implements. */
export interface OpsAgent {
  readonly id: string;
  readonly name: string;
  start(ctx: OpsAgentContext): Promise<void>;
  stop(): Promise<void>;
  health(): AgentHealth;
}

// ---------------------------------------------------------------------------
// Event bus interface (implemented in event-bus.ts)
// ---------------------------------------------------------------------------

export interface OpsEventBus {
  emit<C extends OpsChannel>(channel: C, payload: OpsChannelMap[C]): void;
  on<C extends OpsChannel>(
    channel: C,
    handler: (payload: OpsChannelMap[C]) => void,
  ): void;
  off<C extends OpsChannel>(
    channel: C,
    handler: (payload: OpsChannelMap[C]) => void,
  ): void;
  metrics(): BusMetrics;
}

export interface BusMetrics {
  emitted: Record<string, number>;
  dropped: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Ops pipeline configuration (loaded from ops-config.yaml)
// ---------------------------------------------------------------------------

export interface PrometheusQuery {
  name: string;
  promql: string;
  service: string;
}

export interface PrometheusSourceConfig {
  endpoint: string;
  scrapeIntervalSeconds: number;
  bearerTokenEnv?: string;
  queries: PrometheusQuery[];
}

export interface OtelSourceConfig {
  grpcEndpoint: string;
  httpEndpoint?: string;
  receiveTraces: boolean;
  receiveLogs: boolean;
  receiveMetrics: boolean;
}

export interface AnomalyDetectionConfig {
  windowSize: number;
  deviationThreshold: number;
  aiAssist: boolean;
  aiCheckIntervalSeconds: number;
}

export interface CorrelationConfig {
  timeWindowSeconds: number;
  minSignals: number;
  serviceGraph: Record<string, string[]>;
}

export interface IncidentConfig {
  autoSeverity: boolean;
  minCorrelationScore: number;
}

export interface VectorDbConfig {
  type: "qdrant";
  endpoint: string;
  collection: string;
  embeddingModel: string;
  apiKeyEnv?: string;
}

export interface RunbookConfig {
  vectorDb: VectorDbConfig;
  directory: string;
  similarityThreshold: number;
}

export interface TeamsConfig {
  tenantId: string;
  clientId: string;
  clientSecretEnv: string;
  teamId: string;
  channelId: string;
  botId?: string;
  notificationMode: "text" | "adaptive-card";
}

export interface OpsConfig {
  pipeline: {
    enabled: boolean;
    mode: "observe" | "suggest" | "auto";
  };
  sources: {
    prometheus: PrometheusSourceConfig;
    otelCollector?: OtelSourceConfig;
  };
  anomalyDetection: AnomalyDetectionConfig;
  correlation: CorrelationConfig;
  incident: IncidentConfig;
  runbooks: RunbookConfig;
  teams: TeamsConfig;
}
