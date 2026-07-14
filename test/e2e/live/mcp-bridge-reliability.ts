// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const HERMES_RESTART_TRANSPORT_FAILURE =
  /h2 protocol error: error reading a body[\s\S]*stream closed because of a broken pipe/iu;

export function isHermesRestartTransportFailure(adapter: string, diagnostic: string): boolean {
  return adapter === "hermes-config" && HERMES_RESTART_TRANSPORT_FAILURE.test(diagnostic);
}

export async function retryAfterHermesRestartTransportFailure<T>(options: {
  adapter: string;
  diagnostic: string;
  originalResult: T;
  retry: () => Promise<T>;
}): Promise<T> {
  if (/already exists/iu.test(options.diagnostic)) return options.originalResult;
  if (!isHermesRestartTransportFailure(options.adapter, options.diagnostic)) {
    throw new Error("rejected concurrent add was not a known Hermes restart transport failure");
  }
  return options.retry();
}
