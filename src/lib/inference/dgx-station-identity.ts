// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Match the product identifiers reported by supported DGX Station GB300 firmware. */
export function isDgxStationGb300Product(productName: string): boolean {
  return (
    /(?<![A-Za-z0-9])P3830(?![A-Za-z0-9])/i.test(productName) ||
    /DGX[_\s-]+Station/i.test(productName) ||
    (/Station/i.test(productName) && /GB300/i.test(productName))
  );
}
