// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type JsonObject = Record<string, unknown>;

export function hermesCronRuntimeFields(job: JsonObject, label: string): JsonObject {
  if (typeof job.state !== "string") throw new Error(`${label} state is not a status string`);
  return job;
}
