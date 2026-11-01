// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System.Diagnostics;
using System.Text.Json;
using Nvidia.NemoClaw.Bootstrapper;

if (args.Length >= 5 && args[0] == "--owner")
    return NativeGatewayProcess.Run(args[1], args[5..], args[2], args[3], args[4]);
if (args.Length == 1 && args[0] == "--descendant")
{
    Console.WriteLine($"DESCENDANT {Environment.ProcessId}");
    Thread.Sleep(15000); // Independent bound if the owner fails.
    return 0;
}
if (args.Length == 2 && args[0] == "--parent")
{
    using var child = Process.Start(new ProcessStartInfo(Environment.ProcessPath!)
    {
        UseShellExecute = false,
        ArgumentList = { "--descendant" }
    })!;
    Console.WriteLine($"PARENT {Environment.ProcessId}");
    if (args[1] == "exit") return 7;
    child.WaitForExit(16000);
    return 0;
}
if (args.Length > 0 && args[0] == "--echo")
{
    Console.WriteLine(JsonSerializer.Serialize(args[1..]));
    return 0;
}
return 2;
