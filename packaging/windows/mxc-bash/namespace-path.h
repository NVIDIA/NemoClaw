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

} // namespace nemoclaw_msys
