// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES.
// All rights reserved. SPDX-License-Identifier: Apache-2.0

// Original adapter code using TPDE's public LLVMCompiler API. See
// PROVENANCE.md.
#include <llvm/Config/llvm-config.h>
#include <llvm/IR/LLVMContext.h>
#include <llvm/IR/Metadata.h>
#include <llvm/IR/Module.h>
#include <llvm/IR/Verifier.h>
#include <llvm/IRReader/IRReader.h>
#include <llvm/Support/SourceMgr.h>
#include <llvm/Support/raw_ostream.h>
#include <llvm/TargetParser/Triple.h>
#include <tpde-llvm/LLVMCompiler.hpp>

#include "leaf_export.hpp"
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <string>
#include <vector>

static std::string one_line(llvm::StringRef value) {
  std::string result;
  for (char c : value) {
    if (c == '\n')
      result += "\\n";
    else if (c == '\r')
      result += "\\r";
    else
      result += c;
  }
  return result;
}

int main(int argc, char **argv) {
  const std::string mode = argc > 1 ? argv[1] : "";
  if (mode == "--probe" && argc == 2) {
    std::cout << "protocol=1\ntpde_revision=" << NEMO_TPDE_REVISION
              << "\nllvm_version=" << LLVM_VERSION_STRING << '\n';
    return 0;
  }
  if ((mode != "--inspect" || argc != 3) &&
      (mode != "--compile" || argc != 4) &&
      (mode != "--export-leaf" || argc != 4)) {
    std::cerr << "usage: tpde-rust-bridge --probe | --inspect IR | --compile "
                 "IR OBJECT | --export-leaf IR PACKET\n";
    return 1;
  }
  if (mode == "--export-leaf") {
    std::error_code error;
    const auto size = std::filesystem::file_size(argv[2], error);
    if (error || size > 2 * 1024 * 1024) {
      std::cerr << "leaf input is unavailable or exceeds 2 MiB\n";
      return 20;
    }
  }
  llvm::LLVMContext context;
  llvm::SMDiagnostic diagnostic;
  std::unique_ptr<llvm::Module> module =
      llvm::parseIRFile(argv[2], diagnostic, context);
  if (!module) {
    diagnostic.print(argv[0], llvm::errs());
    return 21;
  }
  if (llvm::verifyModule(*module, &llvm::errs())) {
    std::cerr << "input LLVM module failed verification\n";
    return 22;
  }
  const auto triple = module->getTargetTriple();
  if (triple.str().empty()) {
    std::cerr
        << "input must declare its target triple; host inference is disabled\n";
    return 21;
  }
  if (mode == "--inspect") {
    std::cout << "target=" << one_line(triple.str()) << '\n';
    if (const auto *ident = module->getNamedMetadata("llvm.ident")) {
      for (const auto *node : ident->operands()) {
        for (const auto &operand : node->operands()) {
          const auto *text =
              llvm::dyn_cast_or_null<llvm::MDString>(operand.get());
          if (text && text->getString().starts_with("rustc version ")) {
            std::cout << "rustc_ident=" << one_line(text->getString()) << '\n';
            return 0;
          }
        }
      }
    }
    return 0;
  }
  if (mode == "--export-leaf") {
    std::vector<uint8_t> packet;
    std::string error;
    if (!exportLeafModule(*module, packet, error)) {
      std::cerr << "GPU leaf export rejected: " << error << '\n';
      return 20;
    }
    std::ofstream output(argv[3], std::ios::binary);
    output.write(reinterpret_cast<const char *>(packet.data()), packet.size());
    output.flush();
    if (!output) {
      std::cerr << "writing GEM1 packet failed\n";
      return 24;
    }
    return 0;
  }
  // TPDE emits Linux ELF; an Apple target must never receive an ELF object.
  if (!triple.isOSLinux()) {
    std::cerr << "TPDE target is unsupported: " << triple.str() << '\n';
    return 20;
  }
  auto compiler = tpde_llvm::LLVMCompiler::create(triple);
  if (!compiler) {
    std::cerr << "TPDE target is unsupported: " << triple.str() << '\n';
    return 20;
  }
  std::vector<uint8_t> bytes;
  if (!compiler->compile_to_elf(*module, bytes)) {
    std::cerr << "TPDE rejected an LLVM construct; original input remains "
                 "available for fallback\n";
    return 23;
  }
  std::ofstream output(argv[3], std::ios::binary);
  output.write(reinterpret_cast<const char *>(bytes.data()), bytes.size());
  output.flush();
  if (!output) {
    std::cerr << "writing emitted object failed\n";
    return 24;
  }
  return 0;
}
