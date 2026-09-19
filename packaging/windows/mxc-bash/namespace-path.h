// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#pragma once

#include <stddef.h>
#include <stdint.h>

namespace nemoclaw_msys {

constexpr uint32_t directory_access = 0x0002000f;
constexpr size_t maximum_source_characters = 96;
constexpr size_t maximum_root_characters = 512;
constexpr size_t maximum_target_characters = 640;
constexpr size_t maximum_signal_pipe_characters = 96;
constexpr uint32_t signal_writer_access = 0x00120196;

// Pinned sigproc.cc requests "sigwait" with PIPE_ADD_PID. Observe that
// process's exact pipe only, never arbitrary files or other MSYS pipe roles.
inline bool signal_pipe_name(const char* input, size_t count, uint32_t own_pid) {
    if (!input || !own_pid || !count || count >= maximum_signal_pipe_characters) return false;
    constexpr char prefix[] = "\\\\.\\pipe\\msys-";
    size_t at = 0;
    for (size_t n = 0; prefix[n]; ++n)
        if (at == count || input[at++] != prefix[n]) return false;
    for (size_t n = 0; n < 16; ++n) {
        if (at == count) return false;
        const char c = input[at++];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
    }
    if (at == count || input[at++] != '-' || at == count || input[at] < '1' || input[at] > '9') return false;
    uint32_t pid = 0;
    size_t digits = 0;
    while (at < count && input[at] >= '0' && input[at] <= '9') {
        const uint32_t digit = static_cast<uint32_t>(input[at++] - '0');
        if (++digits > 10 || pid > (UINT32_MAX - digit) / 10) return false;
        pid = pid * 10 + digit;
    }
    if (pid != own_pid) return false;
    constexpr char suffix[] = "-sigwait";
    for (size_t n = 0; suffix[n]; ++n)
        if (at == count || input[at++] != suffix[n]) return false;
    return at == count;
}

inline bool owned_signal_pipe(const char* name, size_t count, uint32_t pid, const char* installation_key,
                              uint32_t open_mode, uint32_t pipe_mode, uint32_t instances,
                              uint32_t out_buffer, uint32_t in_buffer, uint32_t timeout) {
    if (!installation_key || !signal_pipe_name(name, count, pid) || open_mode != 0x00080001 ||
        pipe_mode != 0x0000000c || instances != 1 || timeout != 0 ||
        out_buffer != 65472 || in_buffer != 65472) return false;
    // 50d's exact canonical signal-packet buffer and first-instance modes.
    constexpr size_t key_at = sizeof("\\\\.\\pipe\\msys-") - 1;
    for (size_t n = 0; n < 16; ++n)
        if (!installation_key[n] || installation_key[n] != name[key_at + n]) return false;
    return installation_key[16] == 0;
}

inline bool ordinary_pipe_name(const wchar_t* input, size_t count, const char* installation_key, uint32_t own_pid) {
    if (!input || !installation_key || !own_pid || count >= maximum_signal_pipe_characters || count < 16) return false;
    size_t at = 0;
    for (; at < 16; ++at)
        if (!installation_key[at] || input[at] != static_cast<wchar_t>(installation_key[at])) return false;
    if (installation_key[16] || at == count || input[at++] != L'-' ||
        at == count || input[at] < L'1' || input[at] > L'9') return false;
    uint32_t pid = 0;
    size_t digits = 0;
    while (at < count && input[at] >= L'0' && input[at] <= L'9') {
        const uint32_t digit = static_cast<uint32_t>(input[at++] - L'0');
        if (++digits > 10 || pid > (UINT32_MAX - digit) / 10) return false;
        pid = pid * 10 + digit;
    }
    if (pid != own_pid) return false;
    constexpr wchar_t suffix[] = L"-pipe-nt-0x";
    for (size_t n = 0; suffix[n]; ++n)
        if (at == count || input[at++] != suffix[n]) return false;
    const size_t hex_count = count - at;
    if (!hex_count || hex_count > 16) return false;
    for (; at < count; ++at) {
        const wchar_t c = input[at];
        if (!((c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f') || (c >= L'A' && c <= L'F'))) return false;
    }
    return true;
}

inline bool npfs_root_name(const wchar_t* input, size_t count) {
    if (!input) return false;
    constexpr wchar_t expected[] = L"\\Device\\NamedPipe\\";
    if (count != sizeof(expected) / sizeof(wchar_t) - 1) return false;
    for (size_t n = 0; n < count; ++n) if (input[n] != expected[n]) return false;
    return true;
}

inline bool ordinary_create_contract(uint32_t access, uint32_t share, uint32_t disposition,
    uint32_t options, uint32_t pipe_type, uint32_t read_mode, uint32_t completion_mode,
    uint32_t instances, uint32_t inbound, uint32_t outbound, bool timeout_readable,
    int64_t timeout, uint32_t attributes) {
    return access == 0x80100100 && share == 3 && disposition == 2 && options == 0x20 &&
        pipe_type == 0 && read_mode == 0 && completion_mode == 0 && instances == 1 &&
        inbound == 65536 && outbound == 65536 && timeout_readable && timeout == -500000 &&
        (attributes == 0 || attributes == 2); // Preserve canonical OBJ_INHERIT.
}

enum class Family { none, global, session };
struct Match {
    Family family;
    wchar_t key[17];
};

inline size_t length(const wchar_t* text) {
    size_t count = 0;
    while (text[count]) ++count;
    return count;
}

inline bool consume(const wchar_t* input, size_t count, size_t& at, const wchar_t* expected) {
    for (size_t n = 0; expected[n]; ++n) {
        if (at == count || input[at++] != expected[n]) return false;
    }
    return true;
}

// Input is a bounded counted UNICODE_STRING copied by the Windows adapter.
// No root handle, aliases, suffixes, foreign sessions, or case folding.
inline Match match_name(const wchar_t* input, size_t count, uint32_t own_session) {
    Match result = {};
    if (!input || count == 0 || count > maximum_source_characters) return result;
    for (size_t n = 0; n < count; ++n) if (input[n] == 0) return result;
    size_t at = 0;
    if (consume(input, count, at, L"\\BaseNamedObjects\\")) {
        result.family = Family::global;
    } else {
        at = 0;
        if (!consume(input, count, at, L"\\Sessions\\BNOLINKS\\")) return {};
        if (at == count || input[at] < L'1' || input[at] > L'9') return {};
        uint32_t session = 0;
        size_t digits = 0;
        while (at < count && input[at] >= L'0' && input[at] <= L'9') {
            const uint32_t digit = static_cast<uint32_t>(input[at++] - L'0');
            if (++digits > 10 || session > (UINT32_MAX - digit) / 10) return {};
            session = session * 10 + digit;
        }
        if (session != own_session || !consume(input, count, at, L"\\")) return {};
        result.family = Family::session;
    }
    if (!consume(input, count, at, L"msys-2.0S5-") || count - at != 16) return {};
    for (size_t n = 0; n < 16; ++n) {
        const wchar_t value = input[at + n];
        if (!((value >= L'0' && value <= L'9') || (value >= L'a' && value <= L'f'))) return {};
        result.key[n] = value;
    }
    return result;
}

// The adapter supplies only the API-derived current-token root. This helper
// does not discover or accept a namespace from command line or environment.
inline size_t mapped_name(const Match& match, uint32_t session,
                          const wchar_t* root, size_t root_count,
                          wchar_t* output, size_t capacity) {
    if (match.family == Family::none || !root || !output || root_count < 2 ||
        root_count >= maximum_root_characters || root[0] != L'\\' ||
        root[root_count - 1] == L'\\') return 0;
    for (size_t n = 0; n < root_count; ++n) if (!root[n]) return 0;
    wchar_t digits[10];
    size_t digit_count = 0;
    if (match.family == Family::session) {
        if (!session) return 0;
        do {
            digits[digit_count++] = static_cast<wchar_t>(L'0' + session % 10);
            session /= 10;
        } while (session);
    }
    constexpr wchar_t prefix[] = L"\\NemoClawMsys-";
    constexpr wchar_t msys[] = L"-msys-2.0S5-";
    const size_t needed = root_count + length(prefix) + 1 + digit_count + length(msys) + 16;
    if (needed + 1 > capacity || needed >= maximum_target_characters) return 0;
    size_t at = 0;
    for (size_t n = 0; n < root_count; ++n) output[at++] = root[n];
    for (size_t n = 0; prefix[n]; ++n) output[at++] = prefix[n];
    output[at++] = match.family == Family::global ? L'G' : L'S';
    while (digit_count) output[at++] = digits[--digit_count];
    for (size_t n = 0; msys[n]; ++n) output[at++] = msys[n];
    for (size_t n = 0; n < 16; ++n) output[at++] = match.key[n];
    output[at] = 0;
    return at;
}

// GetAppContainerNamedObjectPath returns a Win32-relative object path. Accept
// only the complete current-token SID spelling before constructing its NT
// session root; neither the API nor a caller may select another namespace.
inline size_t private_nt_root(const wchar_t* api_path, size_t count, const char* token_sid,
                              uint32_t session, wchar_t* output, size_t capacity) {
    if (!api_path || !token_sid || !output || !count || count >= maximum_root_characters) return 0;
    constexpr char sid_prefix[] = "S-1-15-2-";
    for (size_t n = 0; sid_prefix[n]; ++n) if (token_sid[n] != sid_prefix[n]) return 0;
    size_t sid_count = 0;
    while (sid_count < 192 && token_sid[sid_count]) ++sid_count;
    if (sid_count <= sizeof(sid_prefix) - 1 || sid_count == 192) return 0;
    size_t at = 0;
    if (!consume(api_path, count, at, L"AppContainerNamedObjects\\") || count - at != sid_count) return 0;
    for (size_t n = 0; n < sid_count; ++n)
        if (api_path[at + n] != static_cast<wchar_t>(token_sid[n])) return 0;
    wchar_t digits[10];
    size_t digit_count = 0;
    do {
        digits[digit_count++] = static_cast<wchar_t>(L'0' + session % 10);
        session /= 10;
    } while (session);
    constexpr wchar_t prefix[] = L"\\Sessions\\";
    const size_t needed = length(prefix) + digit_count + 1 + count;
    if (needed + 1 > capacity || needed >= maximum_root_characters) return 0;
    at = 0;
    for (size_t n = 0; prefix[n]; ++n) output[at++] = prefix[n];
    while (digit_count) output[at++] = digits[--digit_count];
    output[at++] = L'\\';
    for (size_t n = 0; n < count; ++n) output[at++] = api_path[n];
    output[at] = 0;
    return at;
}

} // namespace nemoclaw_msys
