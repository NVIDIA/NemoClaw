// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System.Text.Json;

namespace Nvidia.NemoClaw.Bootstrapper;

internal static class Program
{
    private const string ValidPreparation = "{\"schemaVersion\":1,\"inference\":null,\"services\":{},\"localModel\":{}}";

    private static NativeSetupConfiguration LocalConfiguration() =>
        new("openclaw", "local", null, NativeExpressSetup.Model, false) { LocalModel = NativeExpressSetup.Id };

    private static void ResetFixtureState()
    {
        NativeExpressSetup.ValidationCalls = 0;
        NativeDesktopIntegration.EnsureCalls = 0;
    }

    private static async Task AssertPrecancelledSaveDoesNotLaunchAsync()
    {
        ResetFixtureState();
        using var password = new System.Security.SecureString();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        var invocations = 0;
        var phases = new List<string>();
        Task<string> UnexpectedHelper(string launcher, string[] arguments, byte[] input, bool captureOutput)
        {
            invocations++;
            return Task.FromResult(ValidPreparation);
        }
        try
        {
            await NativeSetupOperations.SaveWithHelperAsync(
                LocalConfiguration(), password, null, progress => phases.Add(progress.Phase), cancellation.Token,
                "unused-test-launcher", UnexpectedHelper);
            throw new InvalidOperationException("A pre-cancelled native setup save was accepted.");
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
        {
        }
        if (invocations != 0 || phases.Count != 0 || NativeExpressSetup.ValidationCalls != 0 || NativeDesktopIntegration.EnsureCalls != 0)
            throw new InvalidOperationException("A pre-cancelled native setup save crossed its launch checkpoint.");
    }

    private static async Task AssertCancellationAfterSuccessfulPreparationStopsMutationAsync()
    {
        ResetFixtureState();
        using var password = new System.Security.SecureString();
        using var cancellation = new CancellationTokenSource();
        var invocations = 0;
        var phases = new List<string>();
        Task<string> CancelAfterPreparation(string launcher, string[] arguments, byte[] input, bool captureOutput)
        {
            invocations++;
            cancellation.Cancel();
            return Task.FromResult(ValidPreparation);
        }
        try
        {
            await NativeSetupOperations.SaveWithHelperAsync(
                LocalConfiguration(), password, null, progress => phases.Add(progress.Phase), cancellation.Token,
                "unused-test-launcher", CancelAfterPreparation);
            throw new InvalidOperationException("Cancellation after successful preparation crossed the mutation boundary.");
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
        {
        }
        if (invocations != 1 || !phases.SequenceEqual(new[] { "verification" }) ||
            NativeExpressSetup.ValidationCalls != 1 || NativeDesktopIntegration.EnsureCalls != 0)
            throw new InvalidOperationException("Cancellation after successful preparation launched a mutation or skipped valid preparation parsing.");
    }

    private static async Task AssertCancellationDuringCommitTransitionStopsMutationAsync()
    {
        ResetFixtureState();
        using var password = new System.Security.SecureString();
        using var cancellation = new CancellationTokenSource();
        var invocations = 0;
        var phases = new List<string>();
        Task<string> PrepareOnly(string launcher, string[] arguments, byte[] input, bool captureOutput)
        {
            invocations++;
            if (invocations != 1) throw new InvalidOperationException("Cancellation during the commit transition launched a mutation helper.");
            return Task.FromResult(ValidPreparation);
        }
        try
        {
            await NativeSetupOperations.SaveWithHelperAsync(
                LocalConfiguration(), password, null,
                progress =>
                {
                    phases.Add(progress.Phase);
                    if (progress.Phase == "configuration") cancellation.Cancel();
                },
                cancellation.Token, "unused-test-launcher", PrepareOnly);
            throw new InvalidOperationException("Cancellation during the commit transition was accepted.");
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
        {
        }
        if (invocations != 1 || !phases.SequenceEqual(new[] { "verification", "configuration" }) ||
            NativeExpressSetup.ValidationCalls != 1 || NativeDesktopIntegration.EnsureCalls != 0)
            throw new InvalidOperationException("Cancellation during the commit transition crossed the mutation boundary.");
    }

    private static async Task AssertSuccessfulOrderingAsync()
    {
        ResetFixtureState();
        using var password = new System.Security.SecureString();
        var phases = new List<string>();
        var invocations = new List<(string[] Arguments, bool CaptureOutput, string[] Phases)>();
        Task<string> RecordHelper(string launcher, string[] arguments, byte[] input, bool captureOutput)
        {
            invocations.Add((arguments, captureOutput, phases.ToArray()));
            return Task.FromResult(invocations.Count == 1 ? ValidPreparation : string.Empty);
        }
        await NativeSetupOperations.SaveWithHelperAsync(
            LocalConfiguration(), password, null, progress => phases.Add(progress.Phase), CancellationToken.None,
            "unused-test-launcher", RecordHelper);
        if (invocations.Count != 2 ||
            !invocations[0].Arguments.SequenceEqual(new[] { "--configure-native", "--prepare-all" }) ||
            !invocations[0].CaptureOutput || !invocations[0].Phases.SequenceEqual(new[] { "verification" }) ||
            !invocations[1].Arguments.SequenceEqual(new[] { "--configure-native", "--transaction" }) ||
            invocations[1].CaptureOutput || !invocations[1].Phases.SequenceEqual(new[] { "verification", "configuration" }) ||
            NativeExpressSetup.ValidationCalls != 1 || NativeDesktopIntegration.EnsureCalls != 1)
            throw new InvalidOperationException("The native setup preparation and configuration commit phases are out of order.");
    }

    private static async Task AssertCancellationIsDeferredUntilPreparationFinishesAsync()
    {
        ResetFixtureState();
        using var password = new System.Security.SecureString();
        using var cancellation = new CancellationTokenSource();
        var preparationStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releasePreparation = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        var invocations = 0;
        var phases = new List<string>();
        async Task<string> DelayedPreparation(string launcher, string[] arguments, byte[] input, bool captureOutput)
        {
            invocations++;
            preparationStarted.TrySetResult();
            return await releasePreparation.Task;
        }
        var save = NativeSetupOperations.SaveWithHelperAsync(
            LocalConfiguration(), password, null, progress => phases.Add(progress.Phase), cancellation.Token,
            "unused-test-launcher", DelayedPreparation);
        await preparationStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        cancellation.Cancel();
        await Task.Delay(TimeSpan.FromMilliseconds(100));
        var completedBeforePreparation = save.IsCompleted;
        releasePreparation.TrySetResult(ValidPreparation);
        try
        {
            await save.WaitAsync(TimeSpan.FromSeconds(5));
            throw new InvalidOperationException("Deferred native setup cancellation was accepted after preparation.");
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
        {
        }
        if (completedBeforePreparation || invocations != 1 || !phases.SequenceEqual(new[] { "verification" }) ||
            NativeExpressSetup.ValidationCalls != 1 || NativeDesktopIntegration.EnsureCalls != 0)
            throw new InvalidOperationException("Native setup cancellation interrupted preparation instead of waiting for its safe checkpoint.");
    }

    private static async Task AssertCredentialTransactionAsync(bool fail)
    {
        ResetFixtureState();
        const string secret = "nvapi-test-only-transaction-key";
        using var password = new System.Security.SecureString();
        foreach (var character in secret) password.AppendChar(character);
        var configuration = new NativeSetupConfiguration("hermes", "nvidia", "https://integrate.api.nvidia.com/v1", "test-model", true);
        var calls = 0;
        byte[]? transaction = null;
        Task<string> Helper(string launcher, string[] arguments, byte[] input, bool captureOutput)
        {
            calls++;
            if (calls == 1)
            {
                if (System.Text.Encoding.UTF8.GetString(input).Contains(secret, StringComparison.Ordinal))
                    throw new InvalidOperationException("Preparation received a secret.");
                return Task.FromResult("{\"schemaVersion\":1,\"inference\":\"" + new string('a', 64) + "\",\"services\":{}}");
            }
            if (calls != 2 || captureOutput || !arguments.SequenceEqual(new[] { "--configure-native", "--transaction" }))
                throw new InvalidOperationException("Credential mutations escaped the configuration transaction.");
            transaction = input;
            using var document = JsonDocument.Parse(input);
            if (document.RootElement.GetProperty("credentials").GetProperty("inference").GetString() != secret ||
                document.RootElement.GetProperty("configuration").GetRawText().Contains(secret, StringComparison.Ordinal))
                throw new InvalidOperationException("The private transaction envelope is invalid.");
            if (fail) throw new IOException("Simulated owner failure.");
            return Task.FromResult(string.Empty);
        }
        try
        {
            await NativeSetupOperations.SaveWithHelperAsync(configuration, password, null, null, CancellationToken.None, "unused-test-launcher", Helper);
            if (fail) throw new InvalidOperationException("A failed transaction was accepted.");
        }
        catch (IOException) when (fail) { }
        if (calls != 2 || transaction is null || transaction.Any(value => value != 0) ||
            NativeDesktopIntegration.EnsureCalls != (fail ? 0 : 1))
            throw new InvalidOperationException("Transaction cleanup or success publication failed.");
    }

    private static void AssertRecoverableMaintenanceCancellationCanRetry()
    {
        var cancellation = new NativeCancellationState();
        using var firstAttempt = new CancellationTokenSource();
        cancellation.Request(firstAttempt);
        if (!cancellation.IsRequested || !firstAttempt.IsCancellationRequested)
            throw new InvalidOperationException("The first maintenance cancellation was not delivered.");

        cancellation.ResetForRetry();
        using var retry = new CancellationTokenSource();
        if (cancellation.IsRequested || retry.IsCancellationRequested)
            throw new InvalidOperationException("A recoverable maintenance cancellation leaked into its retry.");

        cancellation.Request(retry);
        if (!cancellation.IsRequested || !retry.IsCancellationRequested)
            throw new InvalidOperationException("The retried maintenance attempt could not be cancelled independently.");
    }

    private static string ProductionMethod(string source, string start, string end)
    {
        var startIndex = source.IndexOf(start, StringComparison.Ordinal);
        if (startIndex < 0)
            throw new InvalidOperationException($"The production cancellation fixture could not locate {start}.");
        var endIndex = source.IndexOf(end, startIndex + start.Length, StringComparison.Ordinal);
        if (endIndex < 0)
            throw new InvalidOperationException($"The production cancellation fixture could not locate {start}.");
        return source[startIndex..endIndex];
    }

    private static string RepositoryRoot()
    {
        foreach (var candidate in new[] { Directory.GetCurrentDirectory(), AppContext.BaseDirectory })
        {
            for (var directory = new DirectoryInfo(candidate); directory is not null; directory = directory.Parent)
            {
                if (File.Exists(Path.Combine(directory.FullName, "package.json")) &&
                    File.Exists(Path.Combine(directory.FullName, "packaging", "windows", "bootstrapper", "MainWindow.xaml.cs")))
                    return directory.FullName;
            }
        }
        throw new InvalidOperationException("The production cancellation fixture could not locate the repository root.");
    }

    private static void AssertRecoverableMaintenanceProductionWiring()
    {
        var bootstrapperRoot = Path.Combine(RepositoryRoot(), "packaging", "windows", "bootstrapper");
        var application = File.ReadAllText(Path.Combine(bootstrapperRoot, "NemoClawBootstrapperApplication.cs"));
        var beginMaintenance = ProductionMethod(application, "private async Task BeginMaintenanceAsync", "private async Task ReplacePreviousPreviewAsync");
        var replacePreview = ProductionMethod(application, "private async Task ReplacePreviousPreviewAsync", "private void ShowRecoverableMaintenanceError");
        const string recover = "this.ShowRecoverableMaintenanceError(error);";
        if (!beginMaintenance.Contains(recover, StringComparison.Ordinal) ||
            !replacePreview.Contains(recover, StringComparison.Ordinal))
            throw new InvalidOperationException("A recoverable maintenance catch no longer clears cancellation before retry.");

        var recovery = ProductionMethod(application, "private void ShowRecoverableMaintenanceError", "private async Task PrepareHeadlessMaintenanceAsync");
        var resetIndex = recovery.IndexOf("this.cancellation.ResetForRetry();", StringComparison.Ordinal);
        var maintenanceIndex = recovery.IndexOf("this.window?.ShowMaintenance();", StringComparison.Ordinal);
        if (resetIndex < 0 || maintenanceIndex < resetIndex)
            throw new InvalidOperationException("The recoverable maintenance path no longer resets cancellation before restoring maintenance UI.");

        var window = File.ReadAllText(Path.Combine(bootstrapperRoot, "MainWindow.xaml.cs"));
        var showMaintenance = ProductionMethod(window, "public void ShowMaintenance()", "public void ShowProgress(");
        if (!showMaintenance.Contains("this.cancellation.ResetForRetry();", StringComparison.Ordinal))
            throw new InvalidOperationException("The maintenance UI no longer clears its cancellation latch for retry.");
    }

    internal static async Task<int> Main()
    {
        await AssertPrecancelledSaveDoesNotLaunchAsync();
        await AssertCancellationAfterSuccessfulPreparationStopsMutationAsync();
        await AssertCancellationDuringCommitTransitionStopsMutationAsync();
        await AssertSuccessfulOrderingAsync();
        await AssertCancellationIsDeferredUntilPreparationFinishesAsync();
        await AssertCredentialTransactionAsync(false);
        await AssertCredentialTransactionAsync(true);
        AssertRecoverableMaintenanceCancellationCanRetry();
        AssertRecoverableMaintenanceProductionWiring();
        Console.WriteLine("9 native setup controls passed; cancellation checkpoints and private credential transactions preserve the configuration owner.");
        return 0;
    }
}

internal sealed record NativeExpressProgress(string Phase, string Message, long? CompletedBytes, long? TotalBytes);

internal static class NativeExpressSetup
{
    internal static string Id => "unused-test-model";
    internal static string Model => "unused-test-model";
    internal static int ValidationCalls { get; set; }

    internal static void ValidatePrebuiltSelection(JsonElement preparation, string selected)
    {
        ValidationCalls++;
        if (selected != Id || !preparation.TryGetProperty("localModel", out var model) || model.ValueKind != JsonValueKind.Object)
            throw new InvalidOperationException("The cancellation fixture received invalid prebuilt-model metadata.");
    }
}

internal static class NativeMaintenance
{
    internal static bool SupportsDataRemoval() => throw new InvalidOperationException("Unexpected maintenance invocation in the cancellation fixture.");
}

internal static class NativeDesktopIntegration
{
    internal static int EnsureCalls { get; set; }
    internal static void Ensure(string agent, string launcher) => EnsureCalls++;
}
