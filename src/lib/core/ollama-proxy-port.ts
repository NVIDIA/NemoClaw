// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseServicePortOverride } from "./service-port-boundary";

export const OLLAMA_PROXY_PORT_ENV = "NEMOCLAW_OLLAMA_PROXY_PORT";
export const DEFAULT_OLLAMA_PROXY_PORT = 11435;
export const OLLAMA_PROXY_PORT = parseServicePortOverride(
  OLLAMA_PROXY_PORT_ENV,
  process.env[OLLAMA_PROXY_PORT_ENV],
  DEFAULT_OLLAMA_PROXY_PORT,
);
