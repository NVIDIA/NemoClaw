#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { parentPort, workerData } from "node:worker_threads";

const ms = Number(workerData?.ms) || 100;
const end = performance.now() + ms;
while (performance.now() < end) {
  /* intentional CPU load for HPA testing */
}
parentPort?.postMessage("ok");
