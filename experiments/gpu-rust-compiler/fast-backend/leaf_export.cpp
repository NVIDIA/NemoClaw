// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES.
// All rights reserved. SPDX-License-Identifier: Apache-2.0

#include "leaf_export.hpp"
#include <llvm/ADT/DenseMap.h>
#include <llvm/ADT/SmallVector.h>
#include <llvm/IR/Attributes.h>
#include <llvm/IR/Constants.h>
#include <llvm/IR/Function.h>
#include <llvm/IR/Instructions.h>
#include <llvm/IR/Metadata.h>
#include <llvm/IR/Module.h>
#include <llvm/TargetParser/Triple.h>

#include <algorithm>
#include <limits>
#include <optional>

namespace {
constexpr size_t MaxPacket = 2 * 1024 * 1024;
constexpr uint32_t MaxValues = 256;
constexpr uint32_t NoResult = std::numeric_limits<uint32_t>::max();

struct Instruction {
  uint32_t opcode, result, a, b;
  uint64_t immediate;
};
struct Function {
  std::string name;
  uint32_t parameters, unwind, values;
  std::vector<Instruction> instructions;
};

bool reject(std::string &error, const std::string &reason) {
  error = reason;
  return false;
}
bool utf8(llvm::StringRef text) {
  const auto *s = reinterpret_cast<const unsigned char *>(text.data());
  size_t i = 0;
  while (i < text.size()) {
    const unsigned c = s[i++];
    if (c == 0)
      return false;
    if (c < 0x80)
      continue;
    unsigned count = 0, value = 0, minimum = 0;
    if (c >= 0xc2 && c <= 0xdf) {
      count = 1;
      value = c & 31;
      minimum = 0x80;
    } else if (c >= 0xe0 && c <= 0xef) {
      count = 2;
      value = c & 15;
      minimum = 0x800;
    } else if (c >= 0xf0 && c <= 0xf4) {
      count = 3;
      value = c & 7;
      minimum = 0x10000;
    } else
      return false;
    if (i + count > text.size())
      return false;
    while (count--) {
      const unsigned next = s[i++];
      if ((next & 0xc0) != 0x80)
        return false;
      value = (value << 6) | (next & 63);
    }
    if (value < minimum || value > 0x10ffff ||
        (value >= 0xd800 && value <= 0xdfff))
      return false;
  }
  return true;
}

void u32(std::vector<uint8_t> &out, uint32_t value) {
  for (unsigned shift = 0; shift < 32; shift += 8)
    out.push_back(value >> shift);
}
void u64(std::vector<uint8_t> &out, uint64_t value) {
  for (unsigned shift = 0; shift < 64; shift += 8)
    out.push_back(value >> shift);
}
void text(std::vector<uint8_t> &out, llvm::StringRef value) {
  u32(out, value.size());
  out.insert(out.end(), value.bytes_begin(), value.bytes_end());
}

bool functionAttributes(const llvm::Function &fn, std::string &error) {
  const auto attrs = fn.getAttributes();
  for (const auto attr : attrs.getFnAttrs()) {
    if (attr.isStringAttribute()) {
      const auto key = attr.getKindAsString();
      const auto value = attr.getValueAsString();
      if (key == "target-cpu" || key == "tune-cpu")
        continue;
      if (key == "frame-pointer" &&
          (value == "all" || value == "non-leaf" || value == "none"))
        continue;
      if (key == "probe-stack" && value == "inline-asm")
        continue;
      if (key == "stack-probe-size") {
        uint64_t threshold = 0;
        if (!value.getAsInteger(10, threshold) && threshold >= 4096)
          continue;
      }
      if (key == "target-features") {
        bool protection = false;
        llvm::SmallVector<llvm::StringRef, 16> features;
        value.split(features, ',');
        for (auto feature : features) {
          if (!feature.starts_with("+"))
            continue;
          feature = feature.drop_front();
          if (feature == "bti" || feature == "pauth" || feature == "paca" ||
              feature == "pacg" || feature == "shstk" || feature == "ibt" ||
              feature.starts_with("retpoline"))
            protection = true;
        }
        if (!protection)
          continue;
      }
      return reject(error, "unsupported function attribute " + key.str());
    }
    switch (attr.getKindAsEnum()) {
    case llvm::Attribute::NoUnwind:
    case llvm::Attribute::UWTable:
    case llvm::Attribute::WillReturn:
    case llvm::Attribute::MustProgress:
    case llvm::Attribute::NoFree:
    case llvm::Attribute::NoRecurse:
    case llvm::Attribute::NoSync:
    case llvm::Attribute::Memory:
    case llvm::Attribute::NonLazyBind:
    case llvm::Attribute::NoInline:
    case llvm::Attribute::AlwaysInline:
    case llvm::Attribute::InlineHint:
    case llvm::Attribute::Cold:
    case llvm::Attribute::OptimizeNone:
    case llvm::Attribute::OptimizeForSize:
    case llvm::Attribute::MinSize:
    case llvm::Attribute::Speculatable:
      break;
    default:
      return reject(error,
                    "unsupported function attribute " + attr.getAsString());
    }
  }
  auto abiAttrs = [&](llvm::AttributeSet set) {
    for (const auto attr : set) {
      if (attr.isStringAttribute() ||
          (attr.getKindAsEnum() != llvm::Attribute::NoUndef &&
           attr.getKindAsEnum() != llvm::Attribute::Range))
        return false;
    }
    return true;
  };
  if (!abiAttrs(attrs.getRetAttrs()))
    return reject(error, "unsupported return ABI attribute");
  for (unsigned i = 0; i < fn.arg_size(); ++i) {
    if (!abiAttrs(attrs.getParamAttrs(i)))
      return reject(error, "unsupported parameter ABI attribute");
  }
  return true;
}

bool function(const llvm::Function &fn, uint32_t moduleUnwind, Function &out,
              std::string &error) {
  if (fn.getLinkage() != llvm::GlobalValue::ExternalLinkage ||
      fn.getVisibility() != llvm::GlobalValue::DefaultVisibility ||
      fn.getDLLStorageClass() != llvm::GlobalValue::DefaultStorageClass ||
      fn.getAddressSpace() != 0)
    return reject(error, "function linkage/visibility is not representable");
  if (fn.getCallingConv() != llvm::CallingConv::C || fn.isVarArg() ||
      fn.arg_size() > 1 || !fn.getReturnType()->isIntegerTy(64))
    return reject(
        error,
        "function must use C ABI with zero/one i64 argument and i64 return");
  if (fn.arg_size() == 1 && !fn.arg_begin()->getType()->isIntegerTy(64))
    return reject(error, "function argument is not i64");
  if (fn.size() != 1 || fn.hasPersonalityFn() || fn.hasComdat() ||
      fn.hasSection() || fn.getAlign() || fn.hasPrefixData() ||
      fn.hasPrologueData() || fn.hasMetadata())
    return reject(error,
                  "function control flow or metadata is not representable");
  if (!utf8(fn.getName()) || fn.getName().empty() ||
      fn.getName().size() > 65536)
    return reject(error, "function name is invalid or too large");
  if (!functionAttributes(fn, error))
    return false;
  out.name = fn.getName().str();
  out.parameters = fn.arg_size();
  out.unwind = moduleUnwind || fn.hasFnAttribute(llvm::Attribute::UWTable);
  llvm::DenseMap<const llvm::Value *, uint32_t> ids;
  if (out.parameters) {
    ids[&*fn.arg_begin()] = 0;
    out.instructions.push_back({0, 0, 0, 0, 0});
  }
  auto value = [&](const llvm::Value *v) -> std::optional<uint32_t> {
    if (auto found = ids.find(v); found != ids.end())
      return found->second;
    const auto *constant = llvm::dyn_cast<llvm::ConstantInt>(v);
    if (!constant || !constant->getType()->isIntegerTy(64) ||
        ids.size() >= MaxValues)
      return std::nullopt;
    const auto id = static_cast<uint32_t>(ids.size());
    ids[v] = id;
    out.instructions.push_back({1, id, 0, 0, constant->getZExtValue()});
    return id;
  };
  bool returned = false;
  for (const auto &inst : fn.front()) {
    if (inst.hasMetadata() || inst.hasDbgRecords())
      return reject(error, "instruction/debug metadata is not representable");
    if (const auto *ret = llvm::dyn_cast<llvm::ReturnInst>(&inst)) {
      const auto result = value(ret->getReturnValue());
      if (!result)
        return reject(error,
                      "return value is unsupported or frame limit exceeded");
      out.instructions.push_back({6, NoResult, *result, 0, 0});
      returned = true;
      continue;
    }
    const auto *binary = llvm::dyn_cast<llvm::BinaryOperator>(&inst);
    if (!binary || !binary->getType()->isIntegerTy(64))
      return reject(error, "instruction is outside the scalar leaf subset");
    uint32_t opcode = 0;
    switch (binary->getOpcode()) {
    case llvm::Instruction::Add:
      opcode = 3;
      break;
    case llvm::Instruction::Sub:
      opcode = 4;
      break;
    case llvm::Instruction::Mul:
      opcode = 5;
      break;
    default:
      return reject(error, "arithmetic opcode is unsupported");
    }
    if (binary->hasNoSignedWrap() || binary->hasNoUnsignedWrap())
      return reject(error,
                    "poison-generating arithmetic flags are unsupported");
    const auto a = value(binary->getOperand(0));
    const auto b = value(binary->getOperand(1));
    if (!a || !b || ids.size() >= MaxValues)
      return reject(error, "operand is unsupported or frame limit exceeded");
    const auto id = static_cast<uint32_t>(ids.size());
    ids[binary] = id;
    out.instructions.push_back({opcode, id, *a, *b, 0});
  }
  if (!returned)
    return reject(error, "leaf function has no return");
  out.values = ids.size();
  // The fixed-frame emitter allocates align16(values * 8); this stays below a
  // 4096-byte probe threshold.
  if (((out.values * 8 + 15) & ~15u) > 2048)
    return reject(error, "fixed frame exceeds 2048 bytes");
  return true;
}
} // namespace

bool exportLeafModule(const llvm::Module &module, std::vector<uint8_t> &packet,
                      std::string &error) {
  const auto triple = module.getTargetTriple();
  if ((triple.getArch() != llvm::Triple::x86_64 &&
       triple.getArch() != llvm::Triple::aarch64) ||
      (!triple.isOSLinux() && !triple.isMacOSX()) ||
      !module.getDataLayout().isLittleEndian())
    return reject(error, "unsupported scalar target or byte order");
  if (!module.global_empty() || !module.alias_empty() ||
      !module.ifunc_empty() || !module.getModuleInlineAsm().empty())
    return reject(
        error, "globals, aliases, ifuncs and module assembly are unsupported");
  for (const auto &node : module.named_metadata()) {
    if (node.getName() != "llvm.ident" && node.getName() != "llvm.module.flags")
      return reject(error,
                    "module metadata is unsupported: " + node.getName().str());
  }
  bool producer = false;
  if (const auto *ident = module.getNamedMetadata("llvm.ident")) {
    for (const auto *node : ident->operands()) {
      for (const auto &operand : node->operands()) {
        const auto *name =
            llvm::dyn_cast_or_null<llvm::MDString>(operand.get());
        if (name && name->getString().starts_with("rustc version ")) {
          if (!name->getString().starts_with("rustc version 1.98.1 "))
            return reject(error, "Rust producer does not match 1.98.1");
          producer = true;
        }
      }
    }
  }
  if (!producer)
    return reject(error,
                  "scalar export requires an identified Rust 1.98.1 producer");
  uint32_t moduleUnwind = 0;
  if (const auto *flags = module.getModuleFlagsMetadata()) {
    for (const auto *entry : flags->operands()) {
      if (!entry || entry->getNumOperands() != 3)
        return reject(error, "invalid module flag");
      const auto *key =
          llvm::dyn_cast_or_null<llvm::MDString>(entry->getOperand(1).get());
      const auto *wrapped = llvm::dyn_cast_or_null<llvm::ConstantAsMetadata>(
          entry->getOperand(2).get());
      const auto *val =
          wrapped ? llvm::dyn_cast<llvm::ConstantInt>(wrapped->getValue())
                  : nullptr;
      if (!key || !val || val->getBitWidth() > 64)
        return reject(error, "unsupported module flag");
      const auto name = key->getString();
      // Accepted bodies have no runtime-library calls, so their addressing
      // cannot depend on this flag.
      if (name == "RtLibUseGOT" && val->getZExtValue() <= 1)
        continue;
      if (name != "PIC Level" && name != "PIE Level" && name != "uwtable" &&
          name != "frame-pointer")
        return reject(error, "unsupported module flag " + name.str());
      if (val->getZExtValue() > 2)
        return reject(error, "unsupported module flag value " + name.str());
      if (name == "uwtable")
        moduleUnwind = val->getZExtValue() != 0;
    }
  }
  std::vector<Function> functions;
  for (const auto &fn : module) {
    if (fn.isDeclaration())
      continue;
    Function out;
    if (!function(fn, moduleUnwind, out, error)) {
      error = fn.getName().str() + ": " + error;
      return false;
    }
    functions.push_back(std::move(out));
    if (functions.size() > 65536)
      return reject(error, "function count exceeds limit");
  }
  if (functions.empty())
    return reject(error, "module has no defined functions");
  std::vector<uint8_t> out{'G', 'E', 'M', '1'};
  text(out, triple.str());
  u32(out, functions.size());
  for (const auto &fn : functions) {
    text(out, fn.name);
    for (uint32_t field : {fn.parameters, fn.unwind, fn.values,
                           static_cast<uint32_t>(fn.instructions.size())})
      u32(out, field);
    for (const auto &inst : fn.instructions) {
      for (uint32_t field : {inst.opcode, inst.result, inst.a, inst.b})
        u32(out, field);
      u64(out, inst.immediate);
    }
    if (out.size() > MaxPacket)
      return reject(error, "GEM1 packet exceeds 2 MiB");
  }
  packet = std::move(out);
  return true;
}
