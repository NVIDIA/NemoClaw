// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include "namespace-path.h"
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <sddl.h>
#include "namespace-security.h"
#endif

using namespace nemoclaw_msys;
static unsigned passed = 0;
static void check(bool condition, const char* label) {
    if (!condition) { fprintf(stderr, "FAIL %s\n", label); exit(1); }
    printf("PASS %s\n", label);
    ++passed;
}
static Match parse(const wchar_t* text, uint32_t session = 2) {
    return match_name(text, wcslen(text), session);
}

int main() {
    const wchar_t* global = L"\\BaseNamedObjects\\msys-2.0S5-5a4ee320dd83b184";
    const wchar_t* session = L"\\Sessions\\BNOLINKS\\2\\msys-2.0S5-5a4ee320dd83b184";
    const auto g = parse(global), s = parse(session);
    check(g.family == Family::global && wcscmp(g.key, L"5a4ee320dd83b184") == 0, "exact-pinned-global");
    check(s.family == Family::session, "exact-current-session");
    check(parse(global, 0).family == Family::global && parse(session, 0).family == Family::none,
          "session-zero-uses-only-global");
    check(parse(session, 3).family == Family::none, "foreign-session-refused");
    check(parse(L"\\Sessions\\BNOLINKS\\02\\msys-2.0S5-5a4ee320dd83b184").family == Family::none &&
          parse(L"\\Sessions\\BNOLINKS\\+2\\msys-2.0S5-5a4ee320dd83b184").family == Family::none,
          "session-aliases-refused");
    check(parse(L"\\Sessions\\BNOLINKS\\4294967295\\msys-2.0S5-5a4ee320dd83b184", UINT32_MAX).family == Family::session &&
          parse(L"\\Sessions\\BNOLINKS\\4294967296\\msys-2.0S5-5a4ee320dd83b184", UINT32_MAX).family == Family::none,
          "session-overflow-refused");
    check(parse(L"\\BaseNamedObjects\\msys-2.0S5-5a4ee320dd83b18").family == Family::none &&
          parse(L"\\BaseNamedObjects\\msys-2.0S5-5a4ee320dd83b1840").family == Family::none &&
          parse(L"\\BaseNamedObjects\\msys-2.0S5-5A4ee320dd83b184").family == Family::none,
          "noncanonical-key-refused");
    check(parse(L"\\BaseNamedObjects\\msys-2.0S5-5a4ee320dd83b184\\event").family == Family::none &&
          parse(L"\\BaseNamedObjects\\msys-2.0S5-5a4ee320dd83b184x").family == Family::none,
          "descendants-and-suffixes-pass-through");
    check(parse(L"BaseNamedObjects\\msys-2.0S5-5a4ee320dd83b184").family == Family::none &&
          parse(L"\\basenamedobjects\\msys-2.0S5-5a4ee320dd83b184").family == Family::none &&
          parse(L"\\BaseNamedObjects\\msys-2.0S6-5a4ee320dd83b184").family == Family::none &&
          parse(L"\\BaseNamedObjects\\..\\msys-2.0S5-5a4ee320dd83b184").family == Family::none,
          "unrelated-and-traversal-paths-pass-through");
    wchar_t embedded[96] = {};
    const size_t originalCount = wcslen(global);
    for (size_t n = 0; n < originalCount; ++n) embedded[n] = global[n];
    embedded[20] = 0;
    check(match_name(embedded, originalCount, 2).family == Family::none &&
          match_name(nullptr, originalCount, 2).family == Family::none &&
          match_name(embedded, 97, 2).family == Family::none, "counted-string-bounds");
    const wchar_t* rootA = L"\\Sessions\\2\\AppContainerNamedObjects\\S-1-15-2-11";
    const wchar_t* rootB = L"\\Sessions\\2\\AppContainerNamedObjects\\S-1-15-2-22";
    wchar_t a[maximum_target_characters] = {}, b[maximum_target_characters] = {};
    const size_t ga = mapped_name(g, 2, rootA, wcslen(rootA), a, maximum_target_characters);
    check(ga && wcscmp(a, L"\\Sessions\\2\\AppContainerNamedObjects\\S-1-15-2-11\\NemoClawMsys-G-msys-2.0S5-5a4ee320dd83b184") == 0,
          "global-exact-private-leaf");
    check(mapped_name(s, 2, rootA, wcslen(rootA), b, maximum_target_characters) &&
          wcscmp(b, L"\\Sessions\\2\\AppContainerNamedObjects\\S-1-15-2-11\\NemoClawMsys-S2-msys-2.0S5-5a4ee320dd83b184") == 0 &&
          wcscmp(a, b) != 0, "global-session-distinct");
    check(mapped_name(g, 2, rootB, wcslen(rootB), b, maximum_target_characters) && wcscmp(a, b) != 0,
          "different-token-roots-distinct");
    wchar_t small[3] = {L'x', L'y', 0};
    check(mapped_name(g, 2, rootA, wcslen(rootA), small, 3) == 0 && small[0] == L'x' && small[1] == L'y',
          "small-buffer-no-partial-write");
    check(mapped_name(g, 2, rootA, wcslen(rootA), b, ga) == 0 &&
          mapped_name(g, 2, rootA, wcslen(rootA), b, ga + 1) == ga,
          "terminator-included-in-capacity");
    check(mapped_name(g, 2, L"relative", 8, b, maximum_target_characters) == 0 &&
          mapped_name(g, 2, L"\\root\\", 6, b, maximum_target_characters) == 0,
          "invalid-api-root-shape-refused");
    const wchar_t* relativeRoot = L"AppContainerNamedObjects\\S-1-15-2-11";
    const char* tokenSid = "S-1-15-2-11";
    const size_t relativeCount = wcslen(relativeRoot);
    const size_t ntCount = private_nt_root(relativeRoot, relativeCount, tokenSid, 2, a, maximum_target_characters);
    check(ntCount && wcscmp(a, rootA) == 0, "token-api-root-to-exact-nt-root");
    check(private_nt_root(relativeRoot, relativeCount, tokenSid, 0, a, maximum_target_characters) &&
          wcscmp(a, L"\\Sessions\\0\\AppContainerNamedObjects\\S-1-15-2-11") == 0 &&
          private_nt_root(relativeRoot, relativeCount, tokenSid, UINT32_MAX, a, maximum_target_characters) &&
          wcscmp(a, L"\\Sessions\\4294967295\\AppContainerNamedObjects\\S-1-15-2-11") == 0,
          "token-session-conversion-bounds");
    check(!private_nt_root(relativeRoot, relativeCount, "S-1-15-2-22", 2, a, maximum_target_characters),
          "api-foreign-token-sid-refused");
    const wchar_t* absoluteRoot = L"\\Sessions\\2\\AppContainerNamedObjects\\S-1-15-2-11";
    const wchar_t* win32Root = L"Global\\Session\\2\\AppContainerNamedObjects\\S-1-15-2-11";
    check(!private_nt_root(absoluteRoot, wcslen(absoluteRoot), tokenSid, 2, a, maximum_target_characters) &&
          !private_nt_root(win32Root, wcslen(win32Root), tokenSid, 2, a, maximum_target_characters),
          "api-prefix-aliases-refused");
    const wchar_t* trailingRoot = L"AppContainerNamedObjects\\S-1-15-2-11\\";
    const wchar_t* descendantRoot = L"AppContainerNamedObjects\\S-1-15-2-11\\child";
    check(!private_nt_root(trailingRoot, wcslen(trailingRoot), tokenSid, 2, a, maximum_target_characters) &&
          !private_nt_root(descendantRoot, wcslen(descendantRoot), tokenSid, 2, a, maximum_target_characters),
          "api-trailing-separator-and-descendant-refused");
    small[0] = L'x';
    check(!private_nt_root(relativeRoot, relativeCount, tokenSid, 2, small, 3) && small[0] == L'x' &&
          !private_nt_root(relativeRoot, relativeCount, tokenSid, 2, a, ntCount) &&
          private_nt_root(relativeRoot, relativeCount, tokenSid, 2, a, ntCount + 1) == ntCount,
          "api-root-output-capacity");

#ifdef _WIN32
    alignas(void*) BYTE world[SECURITY_MAX_SID_SIZE] = {};
    DWORD size = sizeof(world);
    check(CreateWellKnownSid(WinWorldSid, nullptr, world, &size) != FALSE, "windows-world-sid");
    SECURITY_DESCRIPTOR original = {};
    alignas(DWORD) BYTE rawAcl[sizeof(ACL) + sizeof(ACCESS_ALLOWED_ACE) + SECURITY_MAX_SID_SIZE] = {};
    auto acl = reinterpret_cast<PACL>(rawAcl);
    check(InitializeSecurityDescriptor(&original, SECURITY_DESCRIPTOR_REVISION) &&
          InitializeAcl(acl, sizeof(rawAcl), ACL_REVISION) &&
          AddAccessAllowedAceEx(acl, ACL_REVISION, 0, directory_access, world) &&
          SetSecurityDescriptorDacl(&original, TRUE, acl, FALSE), "windows-exact-msys-sd-setup");
    // MSYS RtlFirstFreeAce truncates AclSize to its single ACE's actual extent.
    acl->AclSize = static_cast<WORD>(sizeof(ACL) + offsetof(ACCESS_ALLOWED_ACE, SidStart) + GetLengthSid(world));
    check(is_msys_directory_descriptor(&original, world), "windows-exact-msys-descriptor-admitted");
    auto ace = reinterpret_cast<ACCESS_ALLOWED_ACE*>(rawAcl + sizeof(ACL));
    ace->Mask |= WRITE_DAC;
    check(!is_msys_directory_descriptor(&original, world), "windows-other-mask-refused");
    ace->Mask = directory_access;
    ace->Header.AceFlags = INHERITED_ACE;
    check(!is_msys_directory_descriptor(&original, world), "windows-inherited-ace-refused");
    ace->Header.AceFlags = 0;
    SetSecurityDescriptorControl(&original, SE_DACL_PROTECTED, SE_DACL_PROTECTED);
    check(!is_msys_directory_descriptor(&original, world), "windows-other-control-refused");
    SetSecurityDescriptorControl(&original, SE_DACL_PROTECTED, 0);
    SetSecurityDescriptorDacl(&original, TRUE, nullptr, FALSE);
    check(!is_msys_directory_descriptor(&original, world) && !is_msys_directory_descriptor(nullptr, world),
          "windows-null-dacl-refused");
    SetSecurityDescriptorDacl(&original, TRUE, acl, FALSE);
    SetSecurityDescriptorOwner(&original, world, FALSE);
    check(!is_msys_directory_descriptor(&original, world), "windows-explicit-owner-refused");
    PSID user = nullptr, container = nullptr;
    check(ConvertStringSidToSidW(L"S-1-5-21-1-2-3-1000", &user) &&
          ConvertStringSidToSidW(L"S-1-15-2-1-2-3-4-5-6-7", &container), "windows-test-identity-sids");
    ScopedDescriptor scoped = {};
    const char* failedStage = "not-cleared";
    check(make_scoped_descriptor(user, container, scoped, &failedStage) && failedStage == nullptr,
          "windows-scoped-descriptor-built");
    SECURITY_DESCRIPTOR_CONTROL control = 0;
    DWORD revision = 0;
    PACL scopedAcl = nullptr;
    BOOL present = FALSE, defaulted = TRUE;
    check(GetSecurityDescriptorControl(&scoped.descriptor, &control, &revision) &&
          control == (SE_DACL_PRESENT | SE_DACL_PROTECTED) &&
          GetSecurityDescriptorDacl(&scoped.descriptor, &present, &scopedAcl, &defaulted) &&
          present && !defaulted && scopedAcl && scopedAcl->AceCount == 2,
          "windows-two-ace-protected-dacl");
    for (DWORD n = 0; n < 2; ++n) {
        void* value = nullptr;
        check(GetAce(scopedAcl, n, &value) != FALSE, "windows-scoped-ace-present");
        auto allowed = static_cast<ACCESS_ALLOWED_ACE*>(value);
        check(allowed->Header.AceType == ACCESS_ALLOWED_ACE_TYPE && allowed->Header.AceFlags == 0 &&
              allowed->Mask == directory_access && EqualSid(&allowed->SidStart, n ? container : user) &&
              !EqualSid(&allowed->SidStart, world), "windows-only-exact-user-or-container-access");
    }
    check(!make_scoped_descriptor(user, user, scoped, &failedStage) &&
          failedStage && strcmp(failedStage, "descriptor-identities") == 0 && GetLastError() == ERROR_INVALID_SID,
          "windows-descriptor-failure-stage");
    LocalFree(user);
    LocalFree(container);
#endif
    printf("NEMOCLAW_MSYS_NAMESPACE_CONTROLS=%u\n", passed);
    return 0;
}
