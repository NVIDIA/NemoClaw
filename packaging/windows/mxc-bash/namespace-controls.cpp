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
    const char* signalName = "\\\\.\\pipe\\msys-52ddb898ef8d77fd-9784-sigwait";
    const char* maximumPidSignal = "\\\\.\\pipe\\msys-52ddb898ef8d77fd-4294967295-sigwait";
    check(signal_pipe_name(signalName, strlen(signalName), 9784) &&
          signal_pipe_name(maximumPidSignal, strlen(maximumPidSignal), UINT32_MAX),
          "signal-server-writer-exact-own-pid");
    check(!signal_pipe_name(signalName, strlen(signalName), 9785) &&
          !signal_pipe_name(signalName, strlen(signalName), 0), "signal-foreign-pid-refused");
    const char* ordinaryPipe = "\\\\.\\pipe\\msys-52ddb898ef8d77fd-9784-pipe-1";
    const char* childPipe = "\\\\.\\pipe\\msys-52ddb898ef8d77fd-9784-sigwait-child";
    check(!signal_pipe_name(ordinaryPipe, strlen(ordinaryPipe), 9784) &&
          !signal_pipe_name(childPipe, strlen(childPipe), 9784), "signal-other-pipe-roles-refused");
    const char* remotePipe = "\\\\server\\pipe\\msys-52ddb898ef8d77fd-9784-sigwait";
    const char* localPipe = "\\\\.\\pipe\\LOCAL\\msys-52ddb898ef8d77fd-9784-sigwait";
    check(!signal_pipe_name(remotePipe, strlen(remotePipe), 9784) &&
          !signal_pipe_name(localPipe, strlen(localPipe), 9784), "signal-other-prefixes-refused");
    const char* uppercaseKey = "\\\\.\\pipe\\msys-52Ddb898ef8d77fd-9784-sigwait";
    check(!signal_pipe_name(uppercaseKey, strlen(uppercaseKey), 9784) &&
          !signal_pipe_name(signalName, strlen(signalName) + 1, 9784) &&
          !signal_pipe_name(nullptr, 0, 9784) && !signal_pipe_name(signalName, 96, 9784),
          "signal-key-and-counted-bounds");
    const char* paddedPid = "\\\\.\\pipe\\msys-52ddb898ef8d77fd-09784-sigwait";
    const char* overflowPid = "\\\\.\\pipe\\msys-52ddb898ef8d77fd-4294967296-sigwait";
    check(!signal_pipe_name(paddedPid, strlen(paddedPid), 9784) &&
          !signal_pipe_name(overflowPid, strlen(overflowPid), UINT32_MAX), "signal-pid-alias-and-overflow-refused");

    const char* boundKey = "52ddb898ef8d77fd";
    check(owned_signal_pipe(signalName, strlen(signalName), 9784, boundKey, 0x80001, 0xc, 1, 65472, 65472, 0),
          "owned-signal-exact-observed-contract");
    check(!owned_signal_pipe(signalName, strlen(signalName), 9784, "aaaaaaaaaaaaaaaa", 0x80001, 0xc, 1, 65472, 65472, 0) &&
          !owned_signal_pipe(signalName, strlen(signalName), 9784, nullptr, 0x80001, 0xc, 1, 65472, 65472, 0),
          "owned-signal-requires-bound-installation-key");
    check(!owned_signal_pipe(signalName, strlen(signalName), 9784, boundKey, 1, 0xc, 1, 65472, 65472, 0) &&
          !owned_signal_pipe(signalName, strlen(signalName), 9784, boundKey, 0x80003, 0xc, 1, 65472, 65472, 0) &&
          !owned_signal_pipe(signalName, strlen(signalName), 9784, boundKey, 0x80001, 4, 1, 65472, 65472, 0),
          "owned-signal-first-instance-inbound-remote-reject-required");
    check(!owned_signal_pipe(signalName, strlen(signalName), 9784, boundKey, 0x80001, 0xc, 2, 65472, 65472, 0) &&
          !owned_signal_pipe(signalName, strlen(signalName), 9784, boundKey, 0x80001, 0xc, 1, 65536, 65472, 0) &&
          !owned_signal_pipe(signalName, strlen(signalName), 9784, boundKey, 0x80001, 0xc, 1, 65472, 65472, 1),
          "owned-signal-instance-buffer-timeout-fixed");

    const wchar_t* npfs = L"\\Device\\NamedPipe\\";
    check(npfs_root_name(npfs, wcslen(npfs)) && !npfs_root_name(npfs, wcslen(npfs) - 1) &&
          !npfs_root_name(L"\\Device\\NamedPipe\\child", 23), "native-npfs-exact-root-only");
    const wchar_t* ordinary = L"52ddb898ef8d77fd-9784-pipe-nt-0x1";
    const wchar_t* mixedCounter = L"52ddb898ef8d77fd-9784-pipe-nt-0xaBcDeF0123456789";
    check(ordinary_pipe_name(ordinary, wcslen(ordinary), boundKey, 9784) &&
          ordinary_pipe_name(mixedCounter, wcslen(mixedCounter), boundKey, 9784),
          "native-ordinary-server-writer-exact-role");
    check(!ordinary_pipe_name(ordinary, wcslen(ordinary), boundKey, 9785) &&
          !ordinary_pipe_name(ordinary, wcslen(ordinary), "aaaaaaaaaaaaaaaa", 9784),
          "native-ordinary-foreign-key-pid-refused");
    const wchar_t* tooLongCounter = L"52ddb898ef8d77fd-9784-pipe-nt-0x12345678901234567";
    const wchar_t* badCounter = L"52ddb898ef8d77fd-9784-pipe-nt-0xG";
    check(!ordinary_pipe_name(tooLongCounter, wcslen(tooLongCounter), boundKey, 9784) &&
          !ordinary_pipe_name(badCounter, wcslen(badCounter), boundKey, 9784) &&
          !ordinary_pipe_name(ordinary, wcslen(ordinary) - 1, boundKey, 9784),
          "native-ordinary-counter-bounded-hex");
    const wchar_t* ordinaryChild = L"52ddb898ef8d77fd-9784-pipe-nt-0x1\\child";
    const wchar_t* signalRole = L"52ddb898ef8d77fd-9784-sigwait";
    check(!ordinary_pipe_name(ordinaryChild, wcslen(ordinaryChild), boundKey, 9784) &&
          !ordinary_pipe_name(signalRole, wcslen(signalRole), boundKey, 9784),
          "native-ordinary-other-role-and-descendants-refused");
    const wchar_t* ordinaryPadded = L"52ddb898ef8d77fd-09784-pipe-nt-0x1";
    check(!ordinary_pipe_name(ordinaryPadded, wcslen(ordinaryPadded), boundKey, 9784) &&
          !ordinary_pipe_name(nullptr, 0, boundKey, 9784) &&
          !ordinary_pipe_name(ordinary, wcslen(ordinary) + 1, boundKey, 9784) &&
          !ordinary_pipe_name(ordinary, 96, boundKey, 9784), "native-ordinary-counted-name-bounds");

    check(ordinary_create_contract(0x80100100, 3, 2, 0x20, 0, 0, 0, 1, 65536, 65536, true, -500000, 0) &&
          ordinary_create_contract(0x80100100, 3, 2, 0x20, 0, 0, 0, 1, 65536, 65536, true, -500000, 2),
          "ordinary-default-adaptation-preserves-inherit-choice");
    check(!ordinary_create_contract(0x80100100, 3, 1, 0x20, 0, 0, 0, 1, 65536, 65536, true, -500000, 0) &&
          !ordinary_create_contract(0x80100100, 3, 2, 0x20, 0, 0, 0, 2, 65536, 65536, true, -500000, 0) &&
          !ordinary_create_contract(0x80100100, 3, 2, 0x20, 0, 0, 0, 1, 65536, 65536, false, -500000, 0) &&
          !ordinary_create_contract(0x80100100, 3, 2, 0x20, 0, 0, 0, 1, 65536, 65536, true, -500000, 8),
          "ordinary-default-adaptation-refuses-reopen-or-altered-contract");

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
    SECURITY_ATTRIBUTES pipeAttributes = {sizeof(SECURITY_ATTRIBUTES), &original, FALSE};
    PipeSecurityObservation pipeSecurity = {};
    observe_pipe_security(&pipeAttributes, pipeSecurity);
    check(pipeSecurity.complete && pipeSecurity.attributesPresent && pipeSecurity.descriptorPresent &&
          pipeSecurity.daclPresent && !pipeSecurity.nullDacl && pipeSecurity.aceCount == 1 &&
          pipeSecurity.capturedAclBytes == acl->AclSize && memcmp(pipeSecurity.acl, rawAcl, acl->AclSize) == 0 &&
          is_msys_directory_descriptor(&original, world), "windows-pipe-acl-observation-preserves-original");
    PipeSecurityObservation absentSecurity = {}, invalidSecurity = {};
    observe_pipe_security(nullptr, absentSecurity);
    observe_pipe_security(reinterpret_cast<const SECURITY_ATTRIBUTES*>(static_cast<uintptr_t>(1)), invalidSecurity);
    check(absentSecurity.complete && !absentSecurity.attributesPresent && !invalidSecurity.complete,
          "windows-pipe-null-and-invalid-attributes-observed-safely");
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

    // Exact complete88-byte caller DACL from verified50d artifact10190056869.
    const BYTE actualAcl[] = {
        0x02,0x00,0x58,0x00,0x03,0x00,0x00,0x00,0x00,0x00,0x24,0x00,0x00,0x00,0x00,0x10,
        0x01,0x05,0x00,0x00,0x00,0x00,0x00,0x05,0x15,0x00,0x00,0x00,0xd7,0xb5,0xaf,0xe1,
        0x6e,0x23,0x75,0xa7,0x42,0x81,0xce,0x5f,0xf4,0x01,0x00,0x00,0x00,0x00,0x18,0x00,
        0x00,0x00,0x00,0x10,0x01,0x02,0x00,0x00,0x00,0x00,0x00,0x05,0x20,0x00,0x00,0x00,
        0x20,0x02,0x00,0x00,0x00,0x00,0x14,0x00,0x00,0x00,0x00,0x10,0x01,0x01,0x00,0x00,
        0x00,0x00,0x00,0x05,0x12,0x00,0x00,0x00
    };
    PSID actualUser = nullptr;
    check(ConvertStringSidToSidW(L"S-1-5-21-3786388951-2809471854-1607369026-500", &actualUser) != FALSE,
          "windows-actual50d-user-sid");
    PipeSecurityObservation actual = {};
    actual.complete = true; actual.attributesPresent = true; actual.attributesLength = sizeof(SECURITY_ATTRIBUTES);
    actual.descriptorPresent = true; actual.control = SE_DACL_PRESENT; actual.revision = SECURITY_DESCRIPTOR_REVISION;
    actual.daclPresent = TRUE; actual.aclBytes = sizeof(actualAcl); actual.aceCount = 3; actual.capturedAclBytes = sizeof(actualAcl);
    memcpy(actual.acl, actualAcl, sizeof(actualAcl));
    SignalPipeDescriptor adapted = {};
    check(append_signal_container_ace(actual, actualUser, container, adapted), "windows-actual50d-signal-ace-appended");
    auto adaptedAcl = reinterpret_cast<PACL>(adapted.acl);
    void* appendedValue = nullptr;
    check(adaptedAcl->AceCount == 4 && memcmp(adapted.acl + sizeof(ACL), actualAcl + sizeof(ACL), sizeof(actualAcl) - sizeof(ACL)) == 0 &&
          GetAce(adaptedAcl, 3, &appendedValue), "windows-original-three-aces-byte-preserved");
    auto appended = static_cast<ACCESS_ALLOWED_ACE*>(appendedValue);
    check(appended->Header.AceType == ACCESS_ALLOWED_ACE_TYPE && appended->Header.AceFlags == 0 &&
          appended->Mask == (FILE_GENERIC_WRITE | FILE_READ_ATTRIBUTES) && appended->Mask == 0x00120196 &&
          EqualSid(&appended->SidStart, container), "windows-only-actual-container-writer-rights-added");
    SECURITY_DESCRIPTOR_CONTROL adaptedControl = 0; DWORD adaptedRevision = 0;
    check(GetSecurityDescriptorControl(&adapted.descriptor, &adaptedControl, &adaptedRevision) &&
          adaptedControl == SE_DACL_PRESENT && !adapted.attributes.bInheritHandle &&
          memcmp(actual.acl, actualAcl, sizeof(actualAcl)) == 0, "windows-original-descriptor-input-unchanged");
    check(!append_signal_container_ace(actual, user, container, adapted), "windows-foreign-original-user-refused");
    auto changed = actual; changed.acl[12] = 1;
    check(!append_signal_container_ace(changed, actualUser, container, adapted), "windows-other-original-mask-refused");
    changed = actual; changed.acl[9] = INHERITED_ACE;
    check(!append_signal_container_ace(changed, actualUser, container, adapted), "windows-original-inherited-ace-refused");
    changed = actual; changed.control |= SE_DACL_PROTECTED;
    check(!append_signal_container_ace(changed, actualUser, container, adapted), "windows-other-original-control-refused");
    changed = actual; changed.ownerPresent = true;
    check(!append_signal_container_ace(changed, actualUser, container, adapted), "windows-original-owner-refused");
    changed = actual; changed.acl[2] = 0xff; changed.acl[3] = 0xff;
    check(!append_signal_container_ace(changed, actualUser, container, adapted), "windows-raced-acl-size-refused-before-walk");
    LocalFree(actualUser);
    LocalFree(user);
    LocalFree(container);
#endif
    printf("NEMOCLAW_MSYS_NAMESPACE_CONTROLS=%u\n", passed);
    return 0;
}
