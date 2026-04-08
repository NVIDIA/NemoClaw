// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createEventBus } from "./event-bus.js";
import type { AnomalySignal, OpsEvent } from "./types.js";

function makeOpsEvent(overrides?: Partial<OpsEvent>): OpsEvent {
  return {
    id: "evt-1",
    timestamp: "2026-04-08T10:00:00Z",
    source: "prometheus",
    cluster: "gcp-prod",
    namespace: "payments",
    service: "bff-gateway",
    eventType: "metric",
    severity: "warning",
    payload: { name: "http_request_duration_seconds", value: 1.2, unit: "seconds", aggregation: "instant" },
    labels: { job: "bff" },
    ...overrides,
  };
}

function makeAnomaly(overrides?: Partial<AnomalySignal>): AnomalySignal {
  return {
    id: "anom-1",
    timestamp: "2026-04-08T10:01:00Z",
    triggerEvents: ["evt-1"],
    service: "bff-gateway",
    anomalyType: "spike",
    metric: "http_request_duration_seconds",
    expected: 0.5,
    actual: 1.2,
    deviationPct: 140,
    confidence: 0.85,
    context: "P99 latency spiked 140% above 5-minute baseline",
    ...overrides,
  };
}

describe("createEventBus", () => {
  it("delivers events to subscribers", () => {
    const bus = createEventBus();
    const handler = vi.fn();

    bus.on("ops:events", handler);
    const event = makeOpsEvent();
    bus.emit("ops:events", event);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(event);
  });

  it("supports multiple subscribers on the same channel", () => {
    const bus = createEventBus();
    const h1 = vi.fn();
    const h2 = vi.fn();

    bus.on("ops:events", h1);
    bus.on("ops:events", h2);
    bus.emit("ops:events", makeOpsEvent());

    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it("isolates channels — events on one channel do not leak to another", () => {
    const bus = createEventBus();
    const eventsHandler = vi.fn();
    const anomalyHandler = vi.fn();

    bus.on("ops:events", eventsHandler);
    bus.on("ops:anomalies", anomalyHandler);
    bus.emit("ops:events", makeOpsEvent());

    expect(eventsHandler).toHaveBeenCalledOnce();
    expect(anomalyHandler).not.toHaveBeenCalled();
  });

  it("removes subscriber with off()", () => {
    const bus = createEventBus();
    const handler = vi.fn();

    bus.on("ops:events", handler);
    bus.off("ops:events", handler);
    bus.emit("ops:events", makeOpsEvent());

    expect(handler).not.toHaveBeenCalled();
  });

  it("tracks emitted counts in metrics", () => {
    const bus = createEventBus();

    bus.emit("ops:events", makeOpsEvent());
    bus.emit("ops:events", makeOpsEvent({ id: "evt-2" }));
    bus.emit("ops:anomalies", makeAnomaly());

    const m = bus.metrics();
    expect(m.emitted["ops:events"]).toBe(2);
    expect(m.emitted["ops:anomalies"]).toBe(1);
  });

  it("drops oldest events when buffer is full", () => {
    const bus = createEventBus({ bufferSize: 2 });
    const handler = vi.fn();

    bus.on("ops:events", handler);
    bus.emit("ops:events", makeOpsEvent({ id: "evt-1" }));
    bus.emit("ops:events", makeOpsEvent({ id: "evt-2" }));
    bus.emit("ops:events", makeOpsEvent({ id: "evt-3" }));

    const m = bus.metrics();
    expect(m.emitted["ops:events"]).toBe(3);
    expect(m.dropped["ops:events"]).toBe(1);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it("returns a snapshot of metrics (not a live reference)", () => {
    const bus = createEventBus();

    bus.emit("ops:events", makeOpsEvent());
    const snapshot = bus.metrics();
    bus.emit("ops:events", makeOpsEvent({ id: "evt-2" }));

    expect(snapshot.emitted["ops:events"]).toBe(1);
    expect(bus.metrics().emitted["ops:events"]).toBe(2);
  });
});
