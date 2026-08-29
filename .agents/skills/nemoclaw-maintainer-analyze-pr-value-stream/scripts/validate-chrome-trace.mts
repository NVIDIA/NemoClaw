// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";

type Event = {
  name?: unknown;
  ph?: unknown;
  ts?: unknown;
  dur?: unknown;
  pid?: unknown;
  tid?: unknown;
};

export async function validateChromeTrace(file: string): Promise<{
  events: number;
  tracks: number;
}> {
  const payload = JSON.parse(await readFile(file, "utf8")) as { traceEvents?: unknown };
  if (!Array.isArray(payload.traceEvents)) throw new Error("traceEvents must be an array");
  const tracks = new Map<string, { ts: number; dur: number; name: string }[]>();
  const metadata = new Set<string>();
  for (const raw of payload.traceEvents as Event[]) {
    if (typeof raw.name !== "string" || !["M", "i", "X"].includes(String(raw.ph)))
      throw new Error("trace event used an unsupported Chrome trace phase");
    if (!Number.isSafeInteger(raw.pid) || !Number.isSafeInteger(raw.tid))
      throw new Error("trace event pid and tid must be safe integers");
    if (raw.ph === "M") {
      const key = raw.name + ":" + raw.pid + ":" + raw.tid;
      if (metadata.has(key)) throw new Error("duplicate trace metadata event " + key);
      metadata.add(key);
      continue;
    }
    if (!Number.isSafeInteger(raw.ts))
      throw new Error("timed trace event must have a safe timestamp");
    if (raw.ph !== "X") continue;
    if (!Number.isSafeInteger(raw.dur) || Number(raw.dur) < 0)
      throw new Error("complete trace event must have a nonnegative safe duration");
    const key = raw.pid + ":" + raw.tid;
    const track = tracks.get(key) ?? [];
    track.push({ ts: Number(raw.ts), dur: Number(raw.dur), name: raw.name });
    tracks.set(key, track);
  }
  for (const [key, events] of tracks) {
    events.sort((left, right) => left.ts - right.ts || right.dur - left.dur);
    const stack: typeof events = [];
    for (const event of events) {
      while (stack.length > 0 && event.ts >= stack.at(-1)!.ts + stack.at(-1)!.dur) stack.pop();
      if (stack.length > 0 && event.ts + event.dur > stack.at(-1)!.ts + stack.at(-1)!.dur)
        throw new Error("crossing complete events on trace track " + key);
      stack.push(event);
    }
  }
  return { events: payload.traceEvents.length, tracks: tracks.size };
}
