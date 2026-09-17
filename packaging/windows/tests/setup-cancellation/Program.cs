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
            !invocations[1].Arguments.SequenceEqual(new[] { "--configure-native" }) ||
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

    internal static async Task<int> Main()
    {
        await AssertPrecancelledSaveDoesNotLaunchAsync();
        await AssertCancellationAfterSuccessfulPreparationStopsMutationAsync();
        await AssertCancellationDuringCommitTransitionStopsMutationAsync();
        await AssertSuccessfulOrderingAsync();
        await AssertCancellationIsDeferredUntilPreparationFinishesAsync();
        Console.WriteLine("5 native setup deferred-cancellation controls passed; preparation finishes before cancellation and mutation begins only after the commit boundary.");
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
