// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

declare module "convert-source-map" {
  interface ConvertSourceMap {
    fromSource: (source: string) => unknown;
  }

  const convertSourceMap: ConvertSourceMap;
  export default convertSourceMap;
}
