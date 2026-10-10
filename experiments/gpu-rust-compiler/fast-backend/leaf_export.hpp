// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES.
// All rights reserved. SPDX-License-Identifier: Apache-2.0

#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace llvm {
class Module;
}
bool exportLeafModule(const llvm::Module &module, std::vector<uint8_t> &packet,
                      std::string &error);
