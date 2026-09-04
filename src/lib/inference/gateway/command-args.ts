// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function buildGatewayInferenceGetArgs(gatewayName: string): string[] {
  return ["inference", "get", "-g", gatewayName];
}
