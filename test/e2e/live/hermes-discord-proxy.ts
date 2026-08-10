// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function hermesDiscordHttpProxyWebSocketUrl(host: string, port: number | string): string {
  return `http://${host}:${port}/gateway`;
}
