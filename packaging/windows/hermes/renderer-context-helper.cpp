// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// CI debugger companion. Inherited duplicates only; never opens a target by ID.
#include <algorithm>
#include <array>
#include <charconv>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <sstream>
#include <string>
#include <vector>
#ifdef _WIN32
#include <windows.h>
#if !defined(_M_AMD64)
#error Build this context reader for AMD64, not ARM64 or WOW64.
#endif
static_assert(sizeof(CONTEXT) == 1232 && offsetof(CONTEXT, ContextFlags) == 48 &&
              offsetof(CONTEXT, Rsp) == 152 && offsetof(CONTEXT, Rip) == 248);
static_assert(sizeof(PROCESS_MACHINE_INFORMATION) == 8 &&
              offsetof(PROCESS_MACHINE_INFORMATION, MachineAttributes) == 4 &&
              ProcessMachineTypeInfo == 9);
#endif

namespace {
constexpr size_t inputLimit = 64 * 1024;
struct Module { uint64_t base = 0, size = 0; std::string name; };
struct Request {
    uint64_t process = 0, thread = 0, creation = 0;
    uint32_t pid = 0, tid = 0;
    std::vector<Module> modules;
};
struct Candidate { size_t offset; uint64_t address; size_t module; };
struct Result {
    std::string stage = "input", message;
    uint32_t error = 0, pid = 0, tid = 0, threadPid = 0, flags = 0;
    uint16_t processMachine = 0, nativeMachine = 0;
    uint16_t actualMachine = 0, machineReserved = 0;
    uint32_t machineAttributes = 0, machineError = 0, wow64Error = 0;
    bool architectureQueried = false, machineSucceeded = false, wow64Succeeded = false;
    uint64_t creation = 0;
    bool identityMatched = false, contextCaptured = false;
    bool processClosed = false, threadClosed = false, stackComplete = false;
    size_t requestedBytes = 0, readBytes = 0;
    uint32_t stackError = 0;
    std::array<uint64_t, 17> registers{};
    std::vector<Candidate> candidates;
};
bool number(const std::string& text, uint64_t& value, bool hex) {
    const char* first = text.data();
    if (hex) {
        if (text.size() < 3 || text.size() > 18 || text.substr(0, 2) != "0x") return false;
        first += 2;
    } else if (text.empty() || text.size() > 20) return false;
    const auto parsed = std::from_chars(first, text.data() + text.size(), value, hex ? 16 : 10);
    return parsed.ec == std::errc{} && parsed.ptr == text.data() + text.size();
}
bool parse(const std::string& input, Request& result) {
    if (input.size() > inputLimit || input.find('\0') != std::string::npos) return false;
    std::istringstream lines(input); std::string line;
    if (!std::getline(lines, line) || line != "NEMOCLAW_RENDERER_CONTEXT_V1") return false;
    if (!std::getline(lines, line)) return false;
    std::istringstream identity(line); std::array<std::string, 5> fields; std::string extra;
    for (auto& field : fields) if (!(identity >> field)) return false;
    if (identity >> extra) return false;
    uint64_t pid = 0, tid = 0;
    if (!number(fields[0], result.process, true) || !number(fields[1], result.thread, true) ||
        !number(fields[2], pid, false) || !number(fields[3], tid, false) ||
        !number(fields[4], result.creation, false) || !result.process || !result.thread ||
        result.process == result.thread || result.process == UINT64_MAX || result.thread == UINT64_MAX ||
        !pid || pid > UINT32_MAX || !tid || tid > UINT32_MAX || !result.creation) return false;
    result.pid = static_cast<uint32_t>(pid); result.tid = static_cast<uint32_t>(tid);
    uint64_t count = 0;
    if (!std::getline(lines, line) || !number(line, count, false) || count > 256) return false;
    for (uint64_t i = 0; i < count; ++i) {
        if (!std::getline(lines, line)) return false;
        std::istringstream row(line); std::string base, size; Module module;
        if (!(row >> base >> size)) return false;
        std::getline(row >> std::ws, module.name);
        if (!number(base, module.base, true) || !number(size, module.size, true) || !module.size ||
            module.size > UINT32_MAX || module.base > UINT64_MAX - module.size ||
            module.name.empty() || module.name.size() > 128 || module.name.back() == ' ') return false;
        for (unsigned char ch : module.name)
            if (ch < 32 || ch > 126 || ch == '/' || ch == '\\') return false;
        result.modules.push_back(module);
    }
    if (std::getline(lines, line)) return false;
    std::sort(result.modules.begin(), result.modules.end(),
              [](const Module& a, const Module& b) { return a.base < b.base; });
    for (size_t i = 1; i < result.modules.size(); ++i)
        if (result.modules[i - 1].base + result.modules[i - 1].size > result.modules[i].base) return false;
    return true;
}
std::string quoted(const std::string& input) {
    std::string result = "\"";
    for (const char ch : input) { if (ch == '"' || ch == '\\') result += '\\'; result += ch; }
    return result + '"';
}
std::string hex(uint64_t value) { std::ostringstream out; out << "0x" << std::hex << value; return quoted(out.str()); }
const char* boolean(bool value) { return value ? "true" : "false"; }
size_t locate(const Request& request, uint64_t address) {
    for (size_t i = 0; i < request.modules.size(); ++i) {
        const auto& module = request.modules[i];
        if (module.base <= address && address - module.base < module.size) return i;
    }
    return request.modules.size();
}
void location(std::ostringstream& out, const Request& request, uint64_t address, size_t index) {
    if (index >= request.modules.size()) { out << "null"; return; }
    const auto& module = request.modules[index];
    out << "{\"module\":" << quoted(module.name) << ",\"base\":" << hex(module.base)
        << ",\"rva\":" << hex(address - module.base) << '}';
}
std::string json(const Request& request, const Result& result) {
    std::ostringstream out;
    out << "{\"schemaVersion\":1,\"classification\":\"owned-renderer-thread-context\","
        << "\"helperMachine\":\"0x8664\",\"stage\":" << quoted(result.stage)
        << ",\"error\":";
    if (result.message.empty()) out << "null";
    else out << "{\"message\":" << quoted(result.message) << ",\"win32Error\":" << result.error << '}';
    out << ",\"requested\":{\"pid\":" << request.pid << ",\"tid\":" << request.tid
        << ",\"creationFiletime\":" << quoted(std::to_string(request.creation)) << '}'
        << ",\"observed\":{\"pid\":" << result.pid << ",\"tid\":" << result.tid
        << ",\"threadProcessId\":" << result.threadPid
        << ",\"creationFiletime\":" << quoted(std::to_string(result.creation))
        << ",\"processMachine\":" << hex(result.processMachine)
        << ",\"nativeMachine\":" << hex(result.nativeMachine)
        << ",\"wow64QueryAttempted\":" << boolean(result.architectureQueried)
        << ",\"wow64QuerySucceeded\":" << boolean(result.wow64Succeeded)
        << ",\"wow64QueryError\":" << result.wow64Error << '}'
        << ",\"machineTypeInfo\":{\"informationClass\":9,\"bytes\":8,\"queryAttempted\":" << boolean(result.architectureQueried)
        << ",\"querySucceeded\":" << boolean(result.machineSucceeded)
        << ",\"win32Error\":" << result.machineError
        << ",\"processMachine\":" << hex(result.actualMachine)
        << ",\"reserved\":" << result.machineReserved
        << ",\"machineAttributes\":" << hex(result.machineAttributes) << '}'
        << ",\"identityMatched\":" << boolean(result.identityMatched)
        << ",\"contextCaptured\":" << boolean(result.contextCaptured)
        << ",\"context\":{\"bytes\":1232,\"flags\":" << hex(result.flags) << ",\"registers\":{";
    constexpr const char* names[] = {"Rax","Rcx","Rdx","Rbx","Rsp","Rbp","Rsi","Rdi",
                                   "R8","R9","R10","R11","R12","R13","R14","R15","Rip"};
    if (result.contextCaptured) for (size_t i = 0; i < result.registers.size(); ++i) {
        if (i) out << ','; out << quoted(names[i]) << ':' << hex(result.registers[i]);
    }
    out << "}},\"instructionLocation\":";
    if (result.contextCaptured)
        location(out, request, result.registers[16], locate(request, result.registers[16]));
    else out << "null";
    out << ",\"stack\":{\"unwound\":false,\"requestedBytes\":" << result.requestedBytes
        << ",\"readBytes\":" << result.readBytes << ",\"readSucceeded\":" << boolean(result.stackComplete)
        << ",\"win32Error\":" << result.stackError << ",\"candidates\":[";
    for (size_t i = 0; i < result.candidates.size(); ++i) {
        const auto& row = result.candidates[i]; if (i) out << ',';
        out << "{\"stackOffsetBytes\":" << row.offset << ",\"address\":" << hex(row.address)
            << ",\"location\":"; location(out, request, row.address, row.module); out << '}';
    }
    out << "]},\"handlesClosed\":{\"process\":" << boolean(result.processClosed)
        << ",\"thread\":" << boolean(result.threadClosed) << "}}\n";
    return out.str();
}

#ifdef _WIN32
void capture(const Request& request, Result& result) {
    HANDLE process = reinterpret_cast<HANDLE>(static_cast<uintptr_t>(request.process));
    HANDLE thread = reinterpret_cast<HANDLE>(static_cast<uintptr_t>(request.thread));
    const auto failed = [&](const char* message) { result.error = GetLastError(); result.message = message; };
    result.stage = "identity";
    do {
        result.pid = GetProcessId(process); if (!result.pid) { failed("GetProcessId"); break; }
        result.tid = GetThreadId(thread); if (!result.tid) { failed("GetThreadId"); break; }
        result.threadPid = GetProcessIdOfThread(thread); if (!result.threadPid) { failed("GetProcessIdOfThread"); break; }
        FILETIME creation{}, exit{}, kernel{}, user{};
        if (!GetProcessTimes(process, &creation, &exit, &kernel, &user)) { failed("GetProcessTimes"); break; }
        result.creation = (static_cast<uint64_t>(creation.dwHighDateTime) << 32) | creation.dwLowDateTime;
        result.identityMatched = result.pid == request.pid && result.tid == request.tid &&
            result.threadPid == request.pid && result.creation == request.creation;
        if (!result.identityMatched) { result.message = "inherited handle identity mismatch"; break; }
        result.stage = "architecture";
        // An UNKNOWN WOW64 machine is not an ARM64 executable classification.
        // Retain it separately from the documented associated process machine.
        result.architectureQueried = true;
        result.wow64Succeeded = IsWow64Process2(process, &result.processMachine, &result.nativeMachine) != FALSE;
        result.wow64Error = result.wow64Succeeded ? ERROR_SUCCESS : GetLastError();
        PROCESS_MACHINE_INFORMATION machine{};
        result.machineSucceeded = GetProcessInformation(process, ProcessMachineTypeInfo, &machine, sizeof(machine)) != FALSE;
        result.machineError = result.machineSucceeded ? ERROR_SUCCESS : GetLastError();
        result.actualMachine = machine.ProcessMachine;
        result.machineReserved = machine.Res0;
        result.machineAttributes = static_cast<uint32_t>(machine.MachineAttributes);
        if (!result.machineSucceeded) {
            result.error = result.machineError; result.message = "GetProcessInformation(ProcessMachineTypeInfo)"; break;
        }
        if (result.actualMachine != IMAGE_FILE_MACHINE_AMD64) {
            result.message = "ProcessMachineTypeInfo does not identify AMD64 target"; break;
        }
        result.stage = "context";
        CONTEXT context{}; context.ContextFlags = CONTEXT_CONTROL | CONTEXT_INTEGER;
        if (!GetThreadContext(thread, &context)) { failed("GetThreadContext"); break; }
        result.flags = context.ContextFlags;
        if ((context.ContextFlags & (CONTEXT_CONTROL | CONTEXT_INTEGER)) != (CONTEXT_CONTROL | CONTEXT_INTEGER)) {
            result.message = "returned context groups are incomplete"; break;
        }
        result.registers = {context.Rax,context.Rcx,context.Rdx,context.Rbx,context.Rsp,context.Rbp,
            context.Rsi,context.Rdi,context.R8,context.R9,context.R10,context.R11,context.R12,context.R13,
            context.R14,context.R15,context.Rip};
        result.contextCaptured = true;
        result.stage = "stack";
        // Optional prefix: an initially suspended thread may be near StackBase.
        // Eight-byte reads stop at the first unavailable word; total requests≤1KiB.
        for (size_t offset = 0; offset < 1024; offset += sizeof(uint64_t)) {
            if (context.Rsp > UINT64_MAX - offset) { result.stackError = ERROR_INVALID_ADDRESS; break; }
            uint64_t value = 0; SIZE_T read = 0;
            result.requestedBytes += sizeof(value);
            const BOOL ok = ReadProcessMemory(process, reinterpret_cast<const void*>(context.Rsp + offset), &value, sizeof(value), &read);
            const DWORD error = ok ? ERROR_SUCCESS : GetLastError();
            if (read > sizeof(value)) { result.stackError = ERROR_INVALID_DATA; break; }
            result.readBytes += read;
            if (!ok || read != sizeof(value)) { result.stackError = error ? error : ERROR_PARTIAL_COPY; break; }
            const size_t index = locate(request, value);
            if (index < request.modules.size() && result.candidates.size() < 16)
                result.candidates.push_back({offset, value, index});
        }
        result.stackComplete = result.requestedBytes == 1024 && result.readBytes == 1024 && !result.stackError;
        result.stage = "complete";
    } while (false);
    result.processClosed = CloseHandle(process) != FALSE;
    const DWORD processError = result.processClosed ? 0 : GetLastError();
    result.threadClosed = CloseHandle(thread) != FALSE;
    const DWORD threadError = result.threadClosed ? 0 : GetLastError();
    if ((!result.processClosed || !result.threadClosed) && result.message.empty()) {
        result.stage = "close-inherited-handles"; result.message = "CloseHandle";
        result.error = processError ? processError : threadError;
    }
}
#endif
} // namespace

#ifndef NEMOCLAW_CONTEXT_PROTOCOL_TEST
int main() {
    Request request; Result result; std::string input;
#ifdef _WIN32
    std::array<char, 4096> buffer{};
    while (input.size() <= inputLimit) {
        DWORD read = 0;
        const DWORD capacity = static_cast<DWORD>((std::min)(buffer.size(), inputLimit + 1 - input.size()));
        if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), buffer.data(), capacity, &read, nullptr)) {
            const DWORD error = GetLastError();
            if (error != ERROR_BROKEN_PIPE) { result.message = "ReadFile(stdin)"; result.error = error; }
            break;
        }
        if (!read) break;
        input.append(buffer.data(), read);
    }
    if (result.message.empty() && parse(input, request)) capture(request, result);
    else if (result.message.empty()) result.message = "invalid bounded context request";
#else
    result.message = "AMD64 Windows helper required";
#endif
    const auto output = json(request, result);
    if (output.size() > 16 * 1024) return 2;
    if (std::fwrite(output.data(), 1, output.size(), stdout) != output.size()) return 2;
    return result.contextCaptured && result.processClosed && result.threadClosed && result.message.empty() ? 0 : 1;
}
#endif
