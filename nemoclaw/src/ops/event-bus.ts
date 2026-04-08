// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed in-process event bus for inter-agent communication.
 *
 * Each channel carries a specific payload type enforced via the
 * {@link OpsChannelMap} generic constraint. Backpressure is handled
 * per-channel with a configurable buffer that drops oldest events
 * when full.
 *
 * Phase 1 keeps everything in-process. The {@link OpsEventBus}
 * interface is the stable contract — Phase 2 can swap in a
 * distributed broker (NATS, Redis Streams) behind the same API.
 */

import { EventEmitter } from "node:events";

import type {
  BusMetrics,
  OpsChannel,
  OpsChannelMap,
  OpsEventBus,
} from "./types.js";

const DEFAULT_BUFFER_SIZE = 1000;

interface ChannelBuffer<T> {
  items: T[];
  maxSize: number;
}

export interface EventBusOptions {
  bufferSize?: number;
}

export function createEventBus(options?: EventBusOptions): OpsEventBus {
  const bufferSize = options?.bufferSize ?? DEFAULT_BUFFER_SIZE;
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);

  const buffers = new Map<string, ChannelBuffer<unknown>>();
  const emittedCounts: Record<string, number> = {};
  const droppedCounts: Record<string, number> = {};

  function ensureBuffer(channel: string): ChannelBuffer<unknown> {
    let buf = buffers.get(channel);
    if (!buf) {
      buf = { items: [], maxSize: bufferSize };
      buffers.set(channel, buf);
    }
    return buf;
  }

  function emit<C extends OpsChannel>(
    channel: C,
    payload: OpsChannelMap[C],
  ): void {
    const buf = ensureBuffer(channel);
    emittedCounts[channel] = (emittedCounts[channel] ?? 0) + 1;

    if (buf.items.length >= buf.maxSize) {
      buf.items.shift();
      droppedCounts[channel] = (droppedCounts[channel] ?? 0) + 1;
    }
    buf.items.push(payload);

    emitter.emit(channel, payload);
  }

  function on<C extends OpsChannel>(
    channel: C,
    handler: (payload: OpsChannelMap[C]) => void,
  ): void {
    emitter.on(channel, handler as (...args: unknown[]) => void);
  }

  function off<C extends OpsChannel>(
    channel: C,
    handler: (payload: OpsChannelMap[C]) => void,
  ): void {
    emitter.off(channel, handler as (...args: unknown[]) => void);
  }

  function metrics(): BusMetrics {
    return {
      emitted: { ...emittedCounts },
      dropped: { ...droppedCounts },
    };
  }

  return { emit, on, off, metrics };
}
