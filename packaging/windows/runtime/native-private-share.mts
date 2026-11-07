// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { allowlistedWindowsEnvironment, requiredFile, run } from "./native-command.mts";

function fail(message: string): never {
  throw new Error(`Native Windows private directory failed: ${message}`);
}

export async function createPrivateShareRoot(
  directory: string,
  systemRoot: string,
  ownProcess: (child: ChildProcess) => void,
  ownDirectory: () => void,
) {
  const powershell = requiredFile(
    path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    "Windows PowerShell",
  );
  const script = String.raw`$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# Bind required cmdlets to Windows modules without implicit module discovery.
Import-Module -Name ([IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop
Import-Module -Name ([IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Security', 'Microsoft.PowerShell.Security.psd1')) -ErrorAction Stop
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
public static class NativeShareAccess {
  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {
    public uint Length; public IntPtr Descriptor; public int InheritHandle;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  static extern bool CreateDirectoryW(string path, ref SecurityAttributes attributes);
  public static void Create(string path, byte[] descriptor) {
    var pinned = GCHandle.Alloc(descriptor, GCHandleType.Pinned);
    try {
      var attributes = new SecurityAttributes {
        Length = (uint)Marshal.SizeOf(typeof(SecurityAttributes)),
        Descriptor = pinned.AddrOfPinnedObject(), InheritHandle = 0
      };
      // Unlike Directory.CreateDirectory, this refuses an existing directory.
      if (!CreateDirectoryW(path, ref attributes)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally { pinned.Free(); }
  }
  [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential)] struct Request {
    public uint Access; public IntPtr Self; public IntPtr Types; public uint TypeCount; public IntPtr Arguments;
  }
  [StructLayout(LayoutKind.Sequential)] struct Reply {
    public uint Count; public IntPtr Granted; public IntPtr Sacl; public IntPtr Error;
  }
  [DllImport("authz.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool AuthzInitializeResourceManager(uint flags, IntPtr check, IntPtr groups, IntPtr free, string name, out IntPtr manager);
  [DllImport("authz.dll", SetLastError = true)]
  static extern bool AuthzInitializeContextFromSid(uint flags, byte[] sid, IntPtr manager, IntPtr expiration, Luid id, IntPtr arguments, out IntPtr context);
  [DllImport("authz.dll", SetLastError = true)]
  static extern bool AuthzAccessCheck(uint flags, IntPtr context, ref Request request, IntPtr audit, byte[] descriptor, IntPtr descriptors, uint count, ref Reply reply, IntPtr results);
  [DllImport("authz.dll")] static extern bool AuthzFreeContext(IntPtr context);
  [DllImport("authz.dll")] static extern bool AuthzFreeResourceManager(IntPtr manager);
  public static uint Granted(byte[] descriptor, byte[] sid) {
    IntPtr manager = IntPtr.Zero, context = IntPtr.Zero;
    IntPtr replyBuffer = Marshal.AllocHGlobal(12);
    IntPtr granted = replyBuffer, sacl = IntPtr.Add(replyBuffer, 4), error = IntPtr.Add(replyBuffer, 8);
    try {
      Marshal.WriteInt32(granted, 0); Marshal.WriteInt32(sacl, 0); Marshal.WriteInt32(error, 0);
      // NO_AUDIT avoids requiring SeAuditPrivilege; SKIP_TOKEN_GROUPS prevents account lookup.
      if (!AuthzInitializeResourceManager(1, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, "NemoClaw share ACL", out manager))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      if (!AuthzInitializeContextFromSid(2, sid, manager, IntPtr.Zero, new Luid(), IntPtr.Zero, out context))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      Request request = new Request { Access = 0x02000000 }; // MAXIMUM_ALLOWED
      Reply reply = new Reply { Count = 1, Granted = granted, Sacl = sacl, Error = error };
      if (!AuthzAccessCheck(0, context, ref request, IntPtr.Zero, descriptor, IntPtr.Zero, 0, ref reply, IntPtr.Zero))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      int result = Marshal.ReadInt32(error);
      if (result != 0 && result != 5) throw new Win32Exception(result);
      return unchecked((uint)Marshal.ReadInt32(granted));
    } finally {
      if (context != IntPtr.Zero) AuthzFreeContext(context);
      if (manager != IntPtr.Zero) AuthzFreeResourceManager(manager);
      Marshal.FreeHGlobal(replyBuffer);
    }
  }
}
'@
$target = $env:NEMOCLAW_NATIVE_SHARE_ROOT
if ([IO.Directory]::Exists($target) -or [IO.File]::Exists($target)) { throw 'Private share root already exists.' }
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
$allowed = @(@($owner.Value, 'S-1-5-18') | Select-Object -Unique)
$security = [Security.AccessControl.DirectorySecurity]::new()
$security.SetOwner($owner)
$security.SetAccessRuleProtection($true, $false)
foreach ($value in $allowed) {
  $sid = [Security.Principal.SecurityIdentifier]::new($value)
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $security.AddAccessRule($rule)
}
# Apply the protected DACL during creation, before any offload, home, or temp data exists.
[NativeShareAccess]::Create($target, $security.GetSecurityDescriptorBinaryForm())
[Console]::Out.WriteLine('NEMOCLAW_PRIVATE_SHARE_CREATED')
[Console]::Out.Flush()
$actual = Get-Acl -LiteralPath $target
if (-not $actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $owner.Value) {
  throw 'Private share owner or inheritance differs from the required DACL.'
}
$rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne $allowed.Count -or @($rules | Where-Object {
  $_.IsInherited -or $_.IdentityReference.Value -notin $allowed -or $_.AccessControlType -ne 'Allow' -or
  $_.FileSystemRights -ne 'FullControl' -or $_.InheritanceFlags -ne 'ContainerInherit,ObjectInherit' -or $_.PropagationFlags -ne 'None'
}).Count -ne 0) { throw 'Private share DACL contains an unexpected access grant.' }
$descriptor = $actual.GetSecurityDescriptorBinaryForm()
foreach ($value in $allowed) {
  $sid = [Security.Principal.SecurityIdentifier]::new($value)
  $bytes = New-Object byte[] $sid.BinaryLength
  $sid.GetBinaryForm($bytes, 0)
  if (([NativeShareAccess]::Granted($descriptor, $bytes) -band 7) -ne 7) { throw 'Required host identity cannot access the private share.' }
}
$denied = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545')
foreach ($value in $denied) {
  $sid = [Security.Principal.SecurityIdentifier]::new($value)
  $bytes = New-Object byte[] $sid.BinaryLength
  $sid.GetBinaryForm($bytes, 0)
  if (([NativeShareAccess]::Granted($descriptor, $bytes) -band 7) -ne 0) { throw 'An unprivileged identity can access the private share.' }
}
@{ ownerSid = $owner.Value; serviceSid = 'S-1-5-18'; protected = $true; nonOwnerDataAccess = $false; deniedSids = $denied } | ConvertTo-Json -Compress
`;
  const marker = "NEMOCLAW_PRIVATE_SHARE_CREATED\n";
  let prefix = "";
  let ownershipReported = false;
  const result = await run(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    allowlistedWindowsEnvironment({ NEMOCLAW_NATIVE_SHARE_ROOT: directory }),
    "Creating and checking the private native-agent share",
    60_000,
    {
      capture(channel, chunk) {
        if (channel !== "cli.stdout" || ownershipReported) return;
        prefix = (prefix + chunk.toString()).replaceAll("\r\n", "\n");
        if (prefix.startsWith(marker)) {
          ownershipReported = true;
          ownDirectory();
        }
        prefix = prefix.slice(0, marker.length + 1);
      },
    },
    ownProcess,
  );
  if (!ownershipReported) fail("the private share creator did not confirm ownership");
  return JSON.parse(result.stdout.replaceAll("\r\n", "\n").slice(marker.length));
}
