// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const HERMES_RESTART_TRANSPORT_FAILURE =
  /h2 protocol error: error reading a body[\s\S]*stream closed because of a broken pipe/iu;

export function isHermesRestartTransportFailure(adapter: string, diagnostic: string): boolean {
  return adapter === "hermes-config" && HERMES_RESTART_TRANSPORT_FAILURE.test(diagnostic);
}
