// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System.Diagnostics;
using System.Reflection;

namespace Nvidia.NemoClaw.Bootstrapper;

internal static class Program
{
    private static Process StartChild(int? exitCode = null)
    {
        var executable = Environment.ProcessPath ?? throw new InvalidOperationException("The test executable is unavailable.");
        var start = new ProcessStartInfo { FileName = executable, UseShellExecute = false, CreateNoWindow = true };
        if (string.Equals(Path.GetFileNameWithoutExtension(executable), "dotnet", StringComparison.OrdinalIgnoreCase))
            start.ArgumentList.Add(Assembly.GetExecutingAssembly().Location);
        start.ArgumentList.Add(exitCode is null ? "--child" : "--exit");
        if (exitCode is not null) start.ArgumentList.Add(exitCode.Value.ToString());
        return Process.Start(start) ?? throw new InvalidOperationException("The non-exiting maintenance fixture did not start.");
    }

    private static async Task AssertBoundedWaitAsync(bool cancel)
    {
        using var child = StartChild();
        using var cancellation = new CancellationTokenSource();
        if (cancel) cancellation.CancelAfter(TimeSpan.FromMilliseconds(100));
        var cached = @"C:\ProgramData\Package Cache\{maintenance-fixture}\NemoClawSetup.exe";
        try
        {
            await NativeMaintenance.WaitForRelatedActionAsync(child, cached, "uninstall", cancellation.Token,
                cancel ? TimeSpan.FromSeconds(10) : TimeSpan.FromMilliseconds(100));
            throw new InvalidOperationException("A non-exiting maintenance action was accepted.");
        }
        catch (NativeMaintenance.RelatedActionPendingException error)
        {
            var expected = cancel ? "was cancelled" : "exceeded its deadline";
            if (!error.Message.Contains(expected, StringComparison.Ordinal) ||
                !error.Message.Contains("uninstall", StringComparison.Ordinal) ||
                !error.Message.Contains(cached, StringComparison.Ordinal) ||
                !error.Message.Contains("Close this window", StringComparison.Ordinal) || child.HasExited)
                throw new InvalidOperationException("The pending maintenance result lost its action, cache path, close-only instruction, or live-child guarantee.", error);
        }
        finally
        {
            if (!child.WaitForExit(0))
            {
                child.Kill(entireProcessTree: true);
                if (!await Task.Run(() => child.WaitForExit(5000)))
                    throw new InvalidOperationException("The maintenance fixture did not stop.");
            }
        }
    }

    internal static async Task<int> Main(string[] args)
    {
        if (args is ["--diagnostic-exit", var code, var stream, var diagnostic])
        {
            await (stream == "stderr" ? Console.Error : Console.Out).WriteAsync(diagnostic);
            return int.Parse(code);
        }
        if (args is ["--exit", var exitCode]) return int.Parse(exitCode);
        if (args is ["--child"])
        {
            await Task.Delay(Timeout.InfiniteTimeSpan);
            return 0;
        }
        await AssertBoundedWaitAsync(cancel: true);
        await AssertBoundedWaitAsync(cancel: false);
        foreach (var action in new[] { "repair", "uninstall" })
        foreach (var expected in new[] { 0, 7 })
        {
            using var child = StartChild(expected);
            var actual = await NativeMaintenance.WaitForRelatedActionAsync(child, "fixture", action,
                CancellationToken.None, TimeSpan.FromSeconds(10));
            if (actual != expected || !child.WaitForExit(0))
                throw new InvalidOperationException("Completed maintenance lost its exit code or returned before process termination.");
        }
        await AssertHeadlessRoutingAsync();
        await AssertHelperDiagnosticsAsync();
        AssertRelatedCompletion();
        AssertApplyRestartResult();
        AssertInspectionControls();
        AssertHermesUpgradeRouting();
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        foreach (var operation in new Func<Task>[] {
            async () => { await NativeMaintenance.RunRelatedActionAsync(true, cancelled.Token); },
            async () => { await NativeMaintenance.RunRelatedActionAsync(false, cancelled.Token); },
            () => NativeMaintenance.RemoveAgentDataAsync(["hermes"], cancelled.Token),
            () => NativeMaintenance.StopSharedInferenceAsync(cancellation: cancelled.Token),
        })
        {
            try
            {
                await operation();
                throw new InvalidOperationException("Cancelled maintenance reached its external operation.");
            }
            catch (OperationCanceledException error) when (error.CancellationToken == cancelled.Token) { }
        }
        Console.WriteLine("Maintenance controls passed; headless repair and uninstall select the registered product, and unconfirmed completion cannot start another transaction.");
        return 0;
    }

    private static async Task AssertHelperDiagnosticsAsync()
    {
        const string failure = "The maintenance safety check failed.";
        foreach (var scenario in new[] {
            (Code: 2, Stream: "stderr", Text: "runtime-unavailable\r\n", Missing: true, Passed: false),
            (Code: 0, Stream: "stderr", Text: "runtime-unavailable", Missing: false, Passed: true),
            (Code: 1, Stream: "stderr", Text: "runtime-unavailable", Missing: false, Passed: false),
            (Code: 2, Stream: "stdout", Text: "runtime-unavailable", Missing: false, Passed: false),
            (Code: 2, Stream: "stderr", Text: "private-value runtime-unavailable", Missing: false, Passed: false),
            (Code: 2, Stream: "stderr", Text: "runtime-busy", Missing: false, Passed: false),
            (Code: 0, Stream: "stderr", Text: new string('x', 4097), Missing: false, Passed: false),
            (Code: 0, Stream: "stdout", Text: new string('x', 4097), Missing: false, Passed: false),
        })
        {
            var executable = Environment.ProcessPath ?? throw new InvalidOperationException("The test executable is unavailable.");
            var arguments = new List<string>();
            if (string.Equals(Path.GetFileNameWithoutExtension(executable), "dotnet", StringComparison.OrdinalIgnoreCase))
                arguments.Add(Assembly.GetExecutingAssembly().Location);
            arguments.AddRange(["--diagnostic-exit", scenario.Code.ToString(), scenario.Stream, scenario.Text]);
            string? error = null;
            try { await NativeMaintenance.RunOwnedHelperAsync(executable, arguments.ToArray(), failure, CancellationToken.None); }
            catch (InvalidOperationException observed) { error = observed.Message; }
            if (scenario.Passed)
            {
                if (error is not null) throw new InvalidOperationException("A successful maintenance helper was rejected.");
                continue;
            }
            if (error is null) throw new InvalidOperationException("A failed or over-bound helper was accepted.");
            if (scenario.Missing)
            {
                if (!error.Contains("runtime-unavailable", StringComparison.Ordinal) ||
                    !error.Contains("cannot continue", StringComparison.Ordinal))
                    throw new InvalidOperationException("Unavailable runtime was misreported as an active model session.");
            }
            else if (error != failure)
                throw new InvalidOperationException("Unrecognized helper output escaped into the maintenance UI.");
        }
    }

    private static void AssertRelatedCompletion()
    {
        foreach (var uninstall in new[] { false, true })
        foreach (var code in new[] { 0, 3010, 1641, 1603 })
        {
            var calls = new List<string>();
            void Completed()
            {
                if (uninstall) calls.Add("remove-links");
                calls.Add("success");
            }
            void Restart(string message)
            {
                var instruction = code == 1641 ? "reopen the installer after Windows restarts" :
                    "restart Windows before reopening the installer";
                if (!message.Contains("Close this window", StringComparison.Ordinal) ||
                    !message.Contains(instruction, StringComparison.Ordinal))
                    throw new InvalidDataException("Restart-required maintenance lost its close-only recovery guidance.");
                calls.Add("restart");
            }
            try
            {
                NativeMaintenance.CompleteRelatedAction(code, Completed, Restart);
                if (code == 1603) throw new InvalidDataException("Failed maintenance was accepted.");
            }
            catch (InvalidOperationException) when (code == 1603) { }
            var expected = code is 3010 or 1641 ? new[] { "restart" } : code == 1603 ? Array.Empty<string>() :
                uninstall ? new[] { "remove-links", "success" } : new[] { "success" };
            if (!calls.SequenceEqual(expected))
                throw new InvalidDataException("Maintenance completion removed links or showed success before restart, or lost successful completion.");
        }
    }

    private static void AssertApplyRestartResult()
    {
        foreach (var required in new[] { false, true })
        foreach (var initiated in new[] { false, true })
        foreach (var status in new[] { unchecked((int)0x80070643), 0, 1, 3010, 1641 })
        {
            int? expected = status < 0 ? null : initiated || status == 1641 ? 1641 :
                required || status == 3010 ? 3010 : null;
            if (NativeMaintenance.RestartExitCode(status, required, initiated) != expected)
                throw new InvalidDataException("Burn completion lost the restart result or replaced a failed HRESULT.");
        }
    }

    private static async Task AssertHeadlessRoutingAsync()
    {
        foreach (var uninstall in new[] { false, true })
        {
            var calls = new List<string>();
            Task Plan() { calls.Add("plan"); return Task.CompletedTask; }
            bool Related() { calls.Add("inspect"); return true; }
            Task Stop(CancellationToken _) { calls.Add("stop"); return Task.CompletedTask; }
            Task<int> RunRelated(bool requested, CancellationToken _)
            {
                if (requested != uninstall) throw new InvalidOperationException("Headless maintenance changed the requested action.");
                calls.Add("registered");
                return Task.FromResult(3010);
            }
            var code = await NativeMaintenance.PrepareHeadlessActionAsync(false, uninstall, Plan,
                inspectRelated: Related, stopInference: Stop, runRelated: RunRelated);
            if (code != 3010 || !calls.SequenceEqual(new[] { "inspect", "stop", "registered" }))
                throw new InvalidOperationException("Headless maintenance did not select only the registered previous installer.");

            foreach (var exitCode in new[] { 0, 1603, 1223 })
            {
                calls.Clear();
                code = await NativeMaintenance.PrepareHeadlessActionAsync(false, uninstall, Plan,
                    inspectRelated: Related, stopInference: Stop,
                    runRelated: (_, _) => { calls.Add("registered"); return Task.FromResult(exitCode); });
                if (code != exitCode || !calls.SequenceEqual(new[] { "inspect", "stop", "registered" }))
                    throw new InvalidOperationException("Headless maintenance lost the registered installer's exit code or started a second transaction.");
            }

            calls.Clear();
            code = await NativeMaintenance.PrepareHeadlessActionAsync(true, uninstall, Plan,
                inspectRelated: Related, stopInference: Stop, runRelated: RunRelated);
            if (code is not null || !calls.SequenceEqual(new[] { "stop", "plan" }))
                throw new InvalidOperationException("Current-product maintenance did not preserve the current bundle plan.");

            calls.Clear();
            code = await NativeMaintenance.PrepareHeadlessActionAsync(false, uninstall, Plan,
                inspectRelated: () => false, stopInference: Stop, runRelated: RunRelated);
            if (code is not null || !calls.SequenceEqual(new[] { "stop", "plan" }))
                throw new InvalidOperationException("Maintenance without a related product invoked an earlier installer.");

            calls.Clear();
            using var cancellation = new CancellationTokenSource();
            try
            {
                await NativeMaintenance.PrepareHeadlessActionAsync(false, uninstall, Plan, cancellation.Token,
                    Related, _ => { calls.Add("stop"); cancellation.Cancel(); return Task.CompletedTask; }, RunRelated);
                throw new InvalidOperationException("Cancellation started another maintenance transaction.");
            }
            catch (OperationCanceledException error) when (error.CancellationToken == cancellation.Token) { }
            if (!calls.SequenceEqual(new[] { "inspect", "stop" }))
                throw new InvalidOperationException("Cancelled headless maintenance reached a transaction.");

            calls.Clear();
            var pending = new NativeMaintenance.RelatedActionPendingException("completion unconfirmed", new OperationCanceledException());
            try
            {
                await NativeMaintenance.PrepareHeadlessActionAsync(false, uninstall, Plan,
                    inspectRelated: Related, stopInference: Stop,
                    runRelated: (_, _) => { calls.Add("registered"); throw pending; });
                throw new InvalidOperationException("Pending headless maintenance was accepted.");
            }
            catch (NativeMaintenance.RelatedActionPendingException error) when (ReferenceEquals(error, pending)) { }
            if (!calls.SequenceEqual(new[] { "inspect", "stop", "registered" }))
                throw new InvalidOperationException("Unconfirmed maintenance started another transaction.");

            foreach (var failInspection in new[] { true, false })
            {
                calls.Clear();
                var failure = new InvalidOperationException("maintenance prerequisite failed");
                try
                {
                    await NativeMaintenance.PrepareHeadlessActionAsync(false, uninstall, Plan,
                        inspectRelated: () => { calls.Add("inspect"); if (failInspection) throw failure; return true; },
                        stopInference: _ => { calls.Add("stop"); throw failure; }, runRelated: RunRelated);
                    throw new InvalidOperationException("A failed maintenance prerequisite was accepted.");
                }
                catch (InvalidOperationException error) when (ReferenceEquals(error, failure)) { }
                var expected = failInspection ? new[] { "inspect" } : new[] { "inspect", "stop" };
                if (!calls.SequenceEqual(expected))
                    throw new InvalidOperationException("A failed maintenance prerequisite reached another operation.");
            }

            calls.Clear();
            try
            {
                await NativeMaintenance.PrepareHeadlessActionAsync(false, uninstall, Plan, cancellation.Token,
                    Related, Stop, RunRelated);
                throw new InvalidOperationException("Pre-cancelled headless maintenance was accepted.");
            }
            catch (OperationCanceledException error) when (error.CancellationToken == cancellation.Token) { }
            if (calls.Count != 0)
                throw new InvalidOperationException("Pre-cancelled headless maintenance inspected or changed installed state.");
        }
    }

    private static void AssertHermesUpgradeRouting()
    {
        var detection = new NativeHermesUpgrade();
        var inspections = 0;
        bool Immutable() { inspections++; return true; }
        if (detection.CanUpgrade(false, true, true, Immutable) || inspections != 0)
            throw new InvalidOperationException("Missing engine upgrade evidence reached installed inspection.");
        foreach (var version in new[] { "", "invalid" })
        {
            detection.Reset();
            detection.Observe("NemoClawArm64Msi", true, true, version);
            if (detection.CanUpgrade(false, true, true, Immutable) || inspections != 0)
                throw new InvalidOperationException("An invalid related version was admitted for in-place upgrade.");
        }
        foreach (var perMachine in new[] { false, true })
        foreach (var major in new[] { false, true })
        {
            detection.Reset();
            detection.Observe("NemoClawArm64Msi", perMachine, major, "0.1.12");
            if (detection.CanUpgrade(false, true, true, Immutable) != (perMachine && major))
                throw new InvalidOperationException("Engine upgrade direction or installation scope was ignored.");
        }
        detection.Reset();
        detection.Observe("OtherMsi", true, true, "0.1.12");
        if (detection.CanUpgrade(false, true, true, Immutable))
            throw new InvalidOperationException("An unrelated package enabled a Hermes upgrade.");
        detection.Observe("NemoClawArm64Msi", true, true, "0.1.12");
        if (!detection.CanUpgrade(false, true, true, Immutable) ||
            detection.CanUpgrade(true, true, true, Immutable) ||
            detection.CanUpgrade(false, false, true, Immutable) ||
            detection.CanUpgrade(false, true, false, Immutable) ||
            detection.CanUpgrade(false, true, true, () => false))
            throw new InvalidOperationException("Upgrade routing lost current-product, selected-agent or immutable-runtime constraints.");
        var failure = new InvalidDataException("Unreadable immutable runtime.");
        try { detection.CanUpgrade(false, true, true, () => throw failure); throw new InvalidOperationException("Failed upgrade inspection was accepted."); }
        catch (InvalidDataException error) when (ReferenceEquals(error, failure)) { }
        detection.Observe("NemoClawArm64Msi", true, false, "0.1.14");
        if (detection.CanUpgrade(false, true, true, Immutable))
            throw new InvalidOperationException("Mixed related-product evidence enabled upgrade.");
        detection.Reset();
        if (detection.CanUpgrade(false, true, true, Immutable))
            throw new InvalidOperationException("A new Detect cycle reused old upgrade evidence.");
        foreach (var hermes in new[] { false, true })
        foreach (var installed in new[] { false, true })
        foreach (var related in new[] { false, true })
        foreach (var uninstall in new[] { false, true })
            if (NativeHermesUpgrade.RetireSupersededBundle(hermes, installed, related, uninstall) !=
                (hermes && !installed && related && uninstall))
                throw new InvalidOperationException("Superseded bundle retirement crossed its Hermes/engine/product/action boundary.");
        var root = Directory.CreateTempSubdirectory("hermes-upgrade-contract-").FullName;
        try
        {
            var launcher = Path.Combine(root, "fixture-launcher");
            File.WriteAllText(launcher, "inert fixture, never executable");
            var hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(launcher))).ToLowerInvariant();
            foreach (var protocol in new object?[] { null, false, "unknown", "superseded-retirement-v1" })
            {
                var record = new Dictionary<string, object?> {
                    ["schemaVersion"] = 1, ["classification"] = "immutable-package-inputs",
                    ["launcher"] = new { launcherSha256 = hash, capabilities = new {
                        schemaVersion = 1, kind = "native-runtime-capabilities", immutableRuntime = true, guardianEnabled = true } },
                };
                if (protocol is not null) record["hermesBundleUpgradeProtocol"] = protocol;
                File.WriteAllText(Path.Combine(root, "immutable-package-inputs.json"), System.Text.Json.JsonSerializer.Serialize(record));
                if (!NativeMaintenance.SupportsFinishedRuntime(root, launcher) ||
                    NativeMaintenance.SupportsFinishedRuntime(root, launcher, true) != (protocol as string == "superseded-retirement-v1"))
                    throw new InvalidOperationException("Upgrade eligibility ignored the exact installed bundle protocol or changed legacy maintenance.");
            }
            File.AppendAllText(launcher, "changed");
            try { NativeMaintenance.SupportsFinishedRuntime(root, launcher, true); throw new InvalidOperationException("Changed installed launcher accepted for upgrade."); }
            catch (InvalidDataException) { }
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    private static void AssertInspectionControls()
    {
        var calls = new List<string>();
        bool Related() { calls.Add("related"); return true; }
        bool Removal() { calls.Add("removal"); return true; }
        bool Failed() { calls.Add("failed"); throw new InvalidDataException("Unreadable installed command contract."); }

        if (NativeMaintenance.InspectInstallation(true, Related, Removal) != (false, true) ||
            !calls.SequenceEqual(new[] { "removal" }))
            throw new InvalidOperationException("An installed product must not query related installations.");
        calls.Clear();
        if (NativeMaintenance.InspectInstallation(false, Related, Removal) != (true, true) ||
            !calls.SequenceEqual(new[] { "related", "removal" }))
            throw new InvalidOperationException("Related-product inspection lost the data-removal capability.");
        if (NativeMaintenance.InspectInstallation(false, () => false, () => false) != (false, false))
            throw new InvalidOperationException("A fresh installation was not admitted without data removal.");
        calls.Clear();
        if (NativeMaintenance.InspectInstallation(false, Failed, Removal) is not null ||
            !calls.SequenceEqual(new[] { "failed" }))
            throw new InvalidOperationException("Failed related-product inspection continued into maintenance.");
        calls.Clear();
        if (NativeMaintenance.InspectInstallation(false, Related, Failed) is not null ||
            !calls.SequenceEqual(new[] { "related", "failed" }))
            throw new InvalidOperationException("Failed data-removal inspection exposed a partial maintenance result.");
    }
}

internal static class NativeSetupOperations
{
    internal static string InstalledLauncher() => throw new InvalidOperationException("Pre-cancelled maintenance must not inspect the installed launcher.");
}

internal static class NativeOnboarding
{
    internal static int Run(object? _) => 0;
}

internal static class NativeDesktopIntegration
{
    internal static readonly string[] Agents = ["openclaw", "hermes", "langchain-deepagents-code", "pi", "nemocua"];
}
