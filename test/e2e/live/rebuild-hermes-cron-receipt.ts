// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type JsonObject = Record<string, unknown>;

export interface HermesCronBeginIdentity {
  pid: number;
  start_time: number;
}

export function hermesCronBeginIdentity(payload: JsonObject): HermesCronBeginIdentity {
  if (
    !Number.isSafeInteger(payload.pid) ||
    Number(payload.pid) <= 0 ||
    !Number.isSafeInteger(payload.start_time) ||
    Number(payload.start_time) < 0 ||
    payload.drain_token !== "<REDACTED>"
  ) {
    throw new Error("Hermes cron begin receipt identity is invalid");
  }
  return { pid: Number(payload.pid), start_time: Number(payload.start_time) };
}
