// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import net, { type Socket } from "node:net";

export const BROKER_CONNECTION_LIMIT = 32;
export const BROKER_FRAME_BYTES = 64 * 1024;
const WINDOW = 8;
const QUEUED_BYTES = 1024 * 1024;
const STALL_MS = 30_000;
const MAX_SEQUENCE = 9_999_999_999;
const SLOT = /^stream-[0-9a-f]{16}$/u;
const GENERATION = /^[0-9a-f]{32}$/u;

export interface BrokerRelayFiles {
  read(name: string): Promise<Buffer | null>;
  write(name: string, bytes: string | Buffer): Promise<void>;
  unlink(name: string): Promise<void>;
  list(name: string): Promise<string[]>;
}

type Side = "host" | "sandbox";
type Marker = {
  generation: string;
  kind: "open" | "fin" | "closed";
  sequence: number;
  aborted: boolean;
  token?: string;
};
type Stream = {
  slot: string;
  generation: string;
  socket: Socket;
  connected: boolean;
  acknowledged: boolean;
  tx: number;
  rx: number;
  pending: Buffer[];
  pendingBytes: number;
  blocked: boolean;
  ended: boolean;
  closed: boolean;
  aborted: boolean;
  finSent: boolean;
  closedSent: boolean;
  peerFin?: Marker;
  peerClosed?: Marker;
  peerEnded: boolean;
  outstanding: number;
  lastProgress: number;
};

function invalid(): never {
  throw new Error("The native broker transport rejected an invalid frame or lifecycle transition.");
}
export function validateBrokerRelayIdentity(root: string, token: string) {
  if (!root || !/^[A-Za-z0-9_-]{32,128}$/u.test(token)) invalid();
}
function decode(bytes: Buffer, generation: string, kind: Marker["kind"]): Marker {
  if (bytes.length > 4096) invalid();
  let value: Marker;
  try {
    value = JSON.parse(bytes.toString("utf8")) as Marker;
  } catch {
    return invalid();
  }
  if (
    !value ||
    value.generation !== generation ||
    value.kind !== kind ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    value.sequence > MAX_SEQUENCE ||
    typeof value.aborted !== "boolean"
  )
    invalid();
  return value;
}
const frame = (side: Side, sequence: number) => `${side}-${String(sequence).padStart(10, "0")}.bin`;
const control = (side: Side) => frame(side, 0);
const delay = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, 10);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });

export async function createBrokerRelayPeer(options: {
  files: BrokerRelayFiles;
  token: string;
  slots: string[];
  side: Side;
  brokerPort?: number;
  signal?: AbortSignal;
}) {
  if (options.signal?.aborted)
    throw new Error("The native broker transport was stopped before startup.");
  const { files, token, slots, side } = options;
  if (!/^[A-Za-z0-9_-]{32,128}$/u.test(token)) invalid();
  if (
    slots.length !== BROKER_CONNECTION_LIMIT ||
    new Set(slots).size !== slots.length ||
    slots.some((slot) => !SLOT.test(slot))
  )
    invalid();
  if (
    side === "host" &&
    (!Number.isInteger(options.brokerPort) ||
      options.brokerPort! < 1 ||
      options.brokerPort! > 65535)
  )
    invalid();
  const peer: Side = side === "host" ? "sandbox" : "host";
  const states = new Map<string, Stream>();
  const offers = new Map<string, string>();
  const used = new Map<string, string>();
  const claims = new Set<Promise<void>>();
  const controller = new AbortController();
  let stopped = false;
  let failure: Error | undefined;
  let rejectFailure!: (error: Error) => void;
  const failed = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  void failed.catch(() => {});
  let server: net.Server | undefined;
  let serverClosed = Promise.resolve();
  let pump: Promise<void> = Promise.resolve();
  let closing: Promise<void> | undefined;
  let opened = 0;
  let completed = 0;
  let rejected = 0;
  let maximumQueued = 0;
  let maximumOutstanding = 0;
  const progress = (state: Stream) => {
    state.lastProgress = performance.now();
  };
  const abortStream = (state: Stream) => {
    state.aborted = true;
    state.pending.length = 0;
    state.pendingBytes = 0;
    state.ended = true;
    state.socket.destroy();
    progress(state);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    controller.abort();
    if (server)
      serverClosed = new Promise<void>((resolve) => {
        server!.close(() => resolve());
      });
    for (const state of states.values()) state.socket.destroy();
  };
  const fail = (error: unknown) => {
    if (stopped) return;
    failure = error instanceof Error ? error : new Error("The native broker transport failed.");
    rejectFailure(failure);
    stop();
  };
  const marker = (state: Stream, kind: Marker["kind"]): string =>
    JSON.stringify({
      generation: state.generation,
      kind,
      sequence: state.tx,
      aborted: state.aborted,
    });
  const attach = (slot: string, generation: string, socket: Socket, connected: boolean): Stream => {
    const state: Stream = {
      slot,
      generation,
      socket,
      connected,
      acknowledged: false,
      tx: 1,
      rx: 1,
      pending: [],
      pendingBytes: 0,
      blocked: false,
      ended: false,
      closed: false,
      aborted: false,
      finSent: false,
      closedSent: false,
      peerEnded: false,
      outstanding: 0,
      lastProgress: performance.now(),
    };
    socket.pause();
    socket.setNoDelay(true);
    socket.on("data", (bytes: Buffer) => {
      socket.pause();
      if (stopped || state.closed || state.aborted) return;
      if (state.pendingBytes + bytes.length > QUEUED_BYTES) {
        fail(new Error("The native broker queued-byte limit was exceeded."));
        return;
      }
      for (let offset = 0; offset < bytes.length; offset += BROKER_FRAME_BYTES)
        state.pending.push(bytes.subarray(offset, offset + BROKER_FRAME_BYTES));
      state.pendingBytes += bytes.length;
      maximumQueued = Math.max(maximumQueued, state.pendingBytes);
      progress(state);
    });
    socket.on("drain", () => {
      state.blocked = false;
      progress(state);
    });
    socket.once("connect", () => {
      state.connected = true;
      progress(state);
    });
    socket.once("end", () => {
      state.ended = true;
      progress(state);
    });
    socket.once("error", () => {
      state.connected = true;
      abortStream(state);
    });
    socket.once("close", (hadError) => {
      if (hadError || !state.ended || !socket.writableFinished) state.aborted = true;
      state.ended = true;
      state.closed = true;
      if (state.aborted) {
        state.pending.length = 0;
        state.pendingBytes = 0;
      }
      progress(state);
    });
    states.set(slot, state);
    opened++;
    return state;
  };
  const offer = async (slot: string) => {
    const generation = randomBytes(16).toString("hex");
    offers.set(slot, generation);
    await files.write(`${slot}/open`, JSON.stringify({ generation }));
  };
  const loadOffer = async (slot: string) => {
    const bytes = await files.read(`${slot}/open`);
    if (bytes === null) return;
    if (bytes.length > 256) invalid();
    let generation: unknown;
    try {
      generation = (JSON.parse(bytes.toString("utf8")) as { generation?: unknown }).generation;
    } catch {
      invalid();
    }
    if (typeof generation !== "string" || !GENERATION.test(generation)) invalid();
    offers.set(slot, generation);
  };
  const pumpStream = async (state: Stream) => {
    const name = (leaf: string) => `${state.slot}/${leaf}`;
    let entries = await files.list(state.slot);
    if (stopped) return;
    if (entries.length > 2 * WINDOW + 5) invalid();
    const outgoing = entries.filter(
      (entry) =>
        new RegExp(`^${side}-[0-9]{10}\\.bin$`, "u").test(entry) && entry !== control(side),
    );
    if (outgoing.length > WINDOW) invalid();
    state.outstanding = outgoing.length;
    if (side === "host" && !state.acknowledged && state.connected) {
      await files.write(name(control(side)), marker(state, "open"));
      state.acknowledged = true;
      progress(state);
    }
    const peerControl = await files.read(name(control(peer)));
    if (peerControl !== null) {
      if (side === "sandbox" && !state.acknowledged) {
        decode(peerControl, state.generation, "open");
        state.acknowledged = true;
      } else {
        if (state.peerClosed) invalid();
        state.peerClosed = decode(peerControl, state.generation, "closed");
        if (state.peerClosed.aborted) abortStream(state);
      }
      await files.unlink(name(control(peer)));
      progress(state);
    }
    if (!state.acknowledged) {
      if (performance.now() - state.lastProgress > STALL_MS)
        throw new Error("The native broker connection handshake stalled.");
      return;
    }
    while (!stopped && !state.aborted && state.pending.length && state.outstanding < WINDOW) {
      const bytes = state.pending.shift()!;
      state.pendingBytes -= bytes.length;
      if (state.tx >= MAX_SEQUENCE) invalid();
      await files.write(
        name(frame(side, state.tx)),
        Buffer.concat([Buffer.from(state.generation, "ascii"), bytes]),
      );
      state.tx++;
      state.outstanding++;
      maximumOutstanding = Math.max(maximumOutstanding, state.outstanding);
      progress(state);
    }
    if (state.ended && state.pending.length === 0 && !state.finSent) {
      await files.write(name(`${side}-close`), marker(state, "fin"));
      state.finSent = true;
      progress(state);
    }
    if (!state.peerFin) {
      const bytes = await files.read(name(`${peer}-close`));
      if (bytes !== null) {
        state.peerFin = decode(bytes, state.generation, "fin");
        if (state.peerFin.sequence < state.rx) invalid();
        if (state.peerFin.aborted) abortStream(state);
        progress(state);
      }
    }
    for (let count = 0; count < WINDOW && !stopped && (!state.blocked || state.aborted); count++) {
      const leaf = frame(peer, state.rx);
      const bytes = await files.read(name(leaf));
      if (bytes === null) {
        if (state.peerFin && state.rx < state.peerFin.sequence) invalid();
        break;
      }
      if (
        bytes.length <= 32 ||
        bytes.length > BROKER_FRAME_BYTES + 32 ||
        !bytes.subarray(0, 32).equals(Buffer.from(state.generation, "ascii"))
      )
        invalid();
      if (state.peerFin && state.rx >= state.peerFin.sequence) invalid();
      if (!state.aborted && !state.closed) state.blocked = !state.socket.write(bytes.subarray(32));
      await files.unlink(name(leaf));
      state.rx++;
      progress(state);
    }
    if (state.peerFin && state.rx === state.peerFin.sequence && !state.peerEnded) {
      state.peerEnded = true;
      if (!state.closed && !state.aborted) state.socket.end();
      progress(state);
    }
    entries = await files.list(state.slot);
    state.outstanding = entries.filter(
      (entry) => entry.startsWith(`${side}-`) && entry.endsWith(".bin") && entry !== control(side),
    ).length;
    // A closed acknowledgement lets the peer retire these files. Consume its
    // final sequence first so retirement cannot erase a FIN we still need.
    if (
      state.closed &&
      state.finSent &&
      state.peerEnded &&
      !state.closedSent &&
      !entries.includes(control(side))
    ) {
      await files.write(name(control(side)), marker(state, "closed"));
      state.closedSent = true;
      progress(state);
    }
    if (state.peerClosed && state.peerFin && state.peerClosed.sequence !== state.peerFin.sequence)
      invalid();
    if (
      state.closed &&
      state.closedSent &&
      state.peerClosed &&
      state.peerEnded &&
      state.rx === state.peerClosed.sequence &&
      state.outstanding === 0 &&
      !(await files.list(state.slot)).some((entry) => entry.endsWith(".bin"))
    ) {
      states.delete(state.slot);
      completed++;
      if (side === "host") {
        for (const leaf of ["open", "host-close", "sandbox-close"]) await files.unlink(name(leaf));
        await offer(state.slot);
      }
      return;
    }
    if (
      !state.closed &&
      !state.ended &&
      !state.aborted &&
      state.pendingBytes === 0 &&
      state.outstanding < WINDOW
    )
      state.socket.resume();
    if (
      (state.outstanding > 0 || state.pendingBytes > 0 || state.closed) &&
      performance.now() - state.lastProgress > STALL_MS
    )
      throw new Error("The native broker peer stopped acknowledging bounded traffic.");
  };
  const tick = async () => {
    if (side === "sandbox") {
      const shutdown = await files.read("shutdown");
      if (shutdown !== null) {
        if (shutdown.toString("utf8") !== token) invalid();
        stop();
        return;
      }
    }
    const results = await Promise.allSettled(
      slots.map(async (slot) => {
        const state = states.get(slot);
        if (state) {
          await pumpStream(state);
          return;
        }
        if (side === "sandbox") {
          await loadOffer(slot);
          return;
        }
        const generation = offers.get(slot)!;
        const bytes = await files.read(`${slot}/${control(peer)}`);
        if (bytes === null || stopped) return;
        const claim = decode(bytes, generation, "open");
        if (claim.token !== token || claim.sequence !== 1 || claim.aborted) invalid();
        await files.unlink(`${slot}/${control(peer)}`);
        if (stopped) return;
        const socket = net.createConnection({
          host: "127.0.0.1",
          port: options.brokerPort!,
          allowHalfOpen: true,
        });
        attach(slot, generation, socket, false);
      }),
    );
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected?.status === "rejected") throw rejected.reason;
  };
  const externalAbort = () => stop();
  options.signal?.addEventListener("abort", externalAbort, { once: true });
  try {
    if (side === "host") {
      for (const slot of slots) {
        if (stopped || options.signal?.aborted)
          throw new Error("The native broker transport was stopped during startup.");
        await offer(slot);
      }
    } else {
      await Promise.all(slots.map(loadOffer));
      if (stopped) throw new Error("The native broker transport was stopped during startup.");
      server = net.createServer(
        { allowHalfOpen: true, pauseOnConnect: true, highWaterMark: BROKER_FRAME_BYTES },
        (socket) => {
          const slot = slots.find(
            (candidate) =>
              !states.has(candidate) &&
              offers.has(candidate) &&
              used.get(candidate) !== offers.get(candidate),
          );
          if (stopped || !slot) {
            rejected++;
            socket.destroy();
            return;
          }
          const generation = offers.get(slot)!;
          used.set(slot, generation);
          const state = attach(slot, generation, socket, true);
          const claim = files
            .write(
              `${slot}/${control(side)}`,
              JSON.stringify({ generation, kind: "open", sequence: 1, aborted: false, token }),
            )
            .catch(fail)
            .finally(() => claims.delete(claim));
          claims.add(claim);
          progress(state);
        },
      );
      server.on("error", fail);
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          controller.signal.removeEventListener("abort", aborted);
          server!.removeListener("error", rejected);
        };
        const aborted = () => {
          cleanup();
          reject(failure ?? new Error("The native broker transport was stopped during startup."));
        };
        const rejected = (error: Error) => {
          cleanup();
          reject(error);
        };
        controller.signal.addEventListener("abort", aborted, { once: true });
        server!.once("error", rejected);
        server!.listen(0, "127.0.0.1", () => {
          cleanup();
          if (stopped) aborted();
          else resolve();
        });
        if (controller.signal.aborted) aborted();
      });
    }
    if (options.signal?.aborted) stop();
    pump = (async () => {
      while (!stopped) {
        await tick();
        if (!stopped) await delay(controller.signal);
      }
    })().catch(fail);
  } catch (error) {
    fail(error);
    await serverClosed;
    options.signal?.removeEventListener("abort", externalAbort);
    throw error;
  }
  const address = server?.address();
  return {
    host: "127.0.0.1" as const,
    port: address && typeof address === "object" ? address.port : null,
    failure: failed,
    diagnostics() {
      return {
        transport: "guarded-file-tcp" as const,
        activeConnections: states.size,
        openedConnections: opened,
        completedConnections: completed,
        rejectedConnections: rejected,
        maximumQueuedBytesPerConnection: maximumQueued,
        maximumOutstandingFramesPerConnection: maximumOutstanding,
        connectionLimit: BROKER_CONNECTION_LIMIT,
        frameBytes: BROKER_FRAME_BYTES,
        frameWindow: WINDOW,
        stopped,
      };
    },
    close() {
      closing ??= (async () => {
        stop();
        await pump;
        await Promise.all(claims);
        await serverClosed;
        states.clear();
        options.signal?.removeEventListener("abort", externalAbort);
        if (failure) throw failure;
      })();
      return closing;
    },
  };
}
