// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System.IO;
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
        NativeDownloadedModelSetup.Ready = null;
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

    private static async Task AssertDownloadedModelOrderingAsync(bool cancel, bool failCommit)
    {
        ResetFixtureState();
        using var password = new System.Security.SecureString();
        using var cancellation = new CancellationTokenSource();
        var configuration = new NativeSetupConfiguration("openclaw", "local", null, "fixture-downloaded-model", false) { LocalModel = "fixture-downloaded-model" };
        var calls = 0;
        var readyCalls = 0;
        byte[]? transaction = null;
        Task<string> Helper(string launcher, string[] arguments, byte[] input, bool captureOutput)
        {
            calls++;
            if (calls == 1) return Task.FromResult(ValidPreparation);
            if (calls != 2 || !arguments.SequenceEqual(new[] { "--configure-native", "--transaction" }))
                throw new InvalidOperationException("Downloaded model setup escaped the credential transaction.");
            transaction = input;
            if (failCommit) throw new IOException("Fixture commit failed.");
            return Task.FromResult(string.Empty);
        }
        NativeDownloadedModelSetup.Ready = token =>
        {
            readyCalls++;
            if (calls != 2 || transaction is null || transaction.Any(value => value != 0) || NativeDesktopIntegration.EnsureCalls != 1)
                throw new InvalidOperationException("Model readiness started before commit and secret-buffer cleanup.");
            if (cancel) cancellation.Cancel();
            token.ThrowIfCancellationRequested();
            return Task.CompletedTask;
        };
        try
        {
            await NativeSetupOperations.SaveWithHelperAsync(configuration, password, null, null, cancellation.Token, "unused", Helper);
            if (cancel || failCommit) throw new InvalidOperationException("A failed model setup was reported as success.");
        }
        catch (OperationCanceledException) when (cancel && cancellation.IsCancellationRequested) { }
        catch (IOException) when (failCommit) { }
        if (readyCalls != (failCommit ? 0 : 1) || transaction is null || transaction.Any(value => value != 0))
            throw new InvalidOperationException("Downloaded model setup did not preserve the commit boundary.");
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

    private static void AssertCancellationFailureDetail()
    {
        foreach (var status in new[] { 1223, 1602, unchecked((int)0x800704c7), unchecked((int)0x80070642) })
        {
            var before = NativeCancellationState.FailureDetail(status, executionStarted: false);
            if (before is null || !before.Contains("before Windows started changing application files", StringComparison.Ordinal)
                || !before.Contains("Approve the Windows permission prompt", StringComparison.Ordinal)
                || before.Contains("rolled back", StringComparison.Ordinal))
                throw new InvalidOperationException("Pre-execution cancellation lacks accurate retry guidance.");
            var after = NativeCancellationState.FailureDetail(status, executionStarted: true);
            if (after is null || !after.Contains("after Windows started making changes", StringComparison.Ordinal)
                || after.Contains("before Windows started", StringComparison.Ordinal)
                || after.Contains("rolled back", StringComparison.Ordinal))
                throw new InvalidOperationException("Cancellation after execution falsely claims no changes or a confirmed rollback.");
        }
        foreach (var status in new[] { 0, 1, 1603, unchecked((int)0x80070643) })
            if (NativeCancellationState.FailureDetail(status, executionStarted: false) is not null)
                throw new InvalidOperationException("A non-cancellation status received cancellation guidance.");
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
        if (!replacePreview.Contains("NativeMaintenance.CompleteRelatedAction(code, () =>", StringComparison.Ordinal) ||
            !replacePreview.Contains("message => this.window?.ShowFailure(message, this.BundleLogPath())", StringComparison.Ordinal))
            throw new InvalidOperationException("Replacement must use the tested restart-aware completion owner and close-only presentation.");
        const string recover = "this.ShowRecoverableMaintenanceError(error);";
        if (!beginMaintenance.Contains(recover, StringComparison.Ordinal) ||
            !replacePreview.Contains(recover, StringComparison.Ordinal))
            throw new InvalidOperationException("A recoverable maintenance catch no longer clears cancellation before retry.");

        var recovery = ProductionMethod(application, "private void ShowRecoverableMaintenanceError", "private async Task PrepareHeadlessMaintenanceAsync");
        var resetIndex = recovery.IndexOf("this.cancellation.ResetForRetry();", StringComparison.Ordinal);
        var maintenanceIndex = recovery.IndexOf("this.window?.ShowMaintenance();", StringComparison.Ordinal);
        var pendingIndex = recovery.IndexOf("error is NativeMaintenance.RelatedActionPendingException", StringComparison.Ordinal);
        var closeOnlyIndex = recovery.IndexOf("this.window?.ShowFailure(error.Message, this.BundleLogPath());", StringComparison.Ordinal);
        var returnIndex = recovery.IndexOf("return;", StringComparison.Ordinal);
        if (pendingIndex < 0 || closeOnlyIndex <= pendingIndex || returnIndex <= closeOnlyIndex || resetIndex <= returnIndex)
            throw new InvalidOperationException("Unconfirmed Windows Installer completion must take the close-only path before any retry state is reset.");
        if (resetIndex < 0 || maintenanceIndex < resetIndex)
            throw new InvalidOperationException("The recoverable maintenance path no longer resets cancellation before restoring maintenance UI.");

        if (!application.Contains("this.window = new MainWindow(() => this.cancellation.IsRequested);", StringComparison.Ordinal))
            throw new InvalidOperationException("The maintenance UI no longer reads the controller's cancellation state.");
    }

    private static async Task<int> RunHelperFixtureAsync(string[] arguments)
    {
        var root = arguments[1];
        var exitCode = int.Parse(arguments[2]);
        var outputSize = int.Parse(arguments[3]);
        _ = await Console.In.ReadToEndAsync();
        using var lease = new FileStream(Path.Combine(root, "lease"), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None);
        var ready = Path.Combine(root, "ready");
        await File.WriteAllTextAsync(ready + ".next", Environment.ProcessId.ToString());
        File.Move(ready + ".next", ready);
        await Console.Out.WriteAsync(new string('x', outputSize));
        await Console.Error.WriteAsync(new string('y', outputSize));
        using var limit = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        while (!File.Exists(Path.Combine(root, "release"))) await Task.Delay(20, limit.Token);
        await File.WriteAllTextAsync(Path.Combine(root, "result"), exitCode == 0 ? "committed" : "recovered");
        return exitCode;
    }

    private static async Task AssertTransactionOutlivesObserverAsync(int exitCode, int outputSize, bool observerThrows = false,
        bool recoveryHandoff = false, bool recoveryObserverThrows = false)
    {
        var root = Directory.CreateTempSubdirectory("nemoclaw-setup-owner-").FullName;
        var notified = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var unconfirmed = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        var observation = new NativeSetupObservation();
        if (!observation.TryBegin() || observation.TryBegin() || observation.TryCloseWindow())
            throw new InvalidOperationException("Setup did not admit one save or allowed closing before recovery handoff.");
        var launcher = Environment.ProcessPath ?? throw new InvalidOperationException("The fixture executable is unavailable.");
        var arguments = new List<string>();
        if (Path.GetFileNameWithoutExtension(launcher).Equals("dotnet", StringComparison.OrdinalIgnoreCase))
            arguments.Add(typeof(Program).Assembly.Location);
        arguments.AddRange(new[] { "--helper-fixture", root, exitCode.ToString(), outputSize.ToString(), "--transaction" });
        void Pending()
        {
            notified.SetResult();
            if (observerThrows) throw new InvalidOperationException("fixture observer failed");
        }
        void Unconfirmed(int processId)
        {
            observation.MarkUnconfirmed(processId);
            unconfirmed.SetResult(processId);
            if (recoveryObserverThrows) throw new InvalidOperationException("fixture recovery observer failed");
        }
        var operation = NativeSetupOperations.RunSetupHelperAsync(launcher, arguments.ToArray(), Array.Empty<byte>(),
            waitingForTransaction: Pending, observationDeadline: TimeSpan.FromMilliseconds(50),
            completionUnconfirmed: Unconfirmed,
            recoveryDeadline: recoveryHandoff ? TimeSpan.FromMilliseconds(50) : null);
        var visibleOperation = observation.ObserveAsync(operation);
        try
        {
            await notified.Task.WaitAsync(TimeSpan.FromSeconds(10));
            using var readyLimit = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            while (!File.Exists(Path.Combine(root, "ready"))) await Task.Delay(20, readyLimit.Token);
            if (recoveryHandoff)
            {
                var processId = await unconfirmed.Task.WaitAsync(TimeSpan.FromSeconds(10));
                if (processId != int.Parse(await File.ReadAllTextAsync(Path.Combine(root, "ready"))) ||
                    observation.HelperProcessId != processId || !observation.TryCloseWindow() ||
                    !observation.CloseRequested || !observation.Running || observation.TryBegin())
                    throw new InvalidOperationException("Recovery handoff lost its helper or admitted another save.");
                using var ownedHelper = System.Diagnostics.Process.GetProcessById(processId);
                if (ownedHelper.HasExited) throw new InvalidOperationException("Closing the recovery window ended its helper.");
                if (await visibleOperation.WaitAsync(TimeSpan.FromSeconds(1)))
                    throw new InvalidOperationException("Recovery handoff reported a completed save.");
            }
            else if (visibleOperation.IsCompleted)
                throw new InvalidOperationException("The visible operation ended without completion or recovery handoff.");
            if (await observation.CheckCompletionAsync(TimeSpan.FromMilliseconds(20)))
                throw new InvalidOperationException("The bounded status check accepted a live transaction.");
            if (operation.IsCompleted || File.Exists(Path.Combine(root, "result")))
                throw new InvalidOperationException("Setup returned before the transaction owner finished.");
            try
            {
                using var lease = new FileStream(Path.Combine(root, "lease"), FileMode.Open, FileAccess.ReadWrite, FileShare.None);
                throw new InvalidOperationException("The observer deadline released the transaction owner's lease.");
            }
            catch (IOException) { }
            await File.WriteAllTextAsync(Path.Combine(root, "release"), "finish");
            Exception? failure = null;
            try { await operation.WaitAsync(TimeSpan.FromSeconds(10)); }
            catch (InvalidOperationException error) { failure = error; }
            Exception? visibleFailure = null;
            try { await visibleOperation.WaitAsync(TimeSpan.FromSeconds(10)); }
            catch (InvalidOperationException error) { visibleFailure = error; }
            if ((visibleFailure is not null) != (!recoveryHandoff && failure is not null))
                throw new InvalidOperationException("The visible observer lost the completed helper failure.");
            if ((failure is not null) != (exitCode != 0 || outputSize != 0 || observerThrows || recoveryObserverThrows))
                throw new InvalidOperationException("Setup misclassified the completed helper result.");
            if (!recoveryHandoff && unconfirmed.Task.IsCompleted)
                throw new InvalidOperationException("A completed helper received an unnecessary recovery handoff.");
            if (await File.ReadAllTextAsync(Path.Combine(root, "result")) != (exitCode == 0 ? "committed" : "recovered"))
                throw new InvalidOperationException("The transaction did not finish its commit or recovery fixture.");
            using var releasedLease = new FileStream(Path.Combine(root, "lease"), FileMode.Open, FileAccess.ReadWrite, FileShare.None);
            observation.ConfirmTransactionExit();
            if (observation.CompletionUnconfirmed || observation.TryCloseWindow() || !observation.Running || observation.TryBegin())
                throw new InvalidOperationException("Confirmed transaction exit released setup ownership before later model work finished.");
            observation.Complete();
            if (observation.Running || observation.TryCloseWindow() ||
                observation.CloseRequested != recoveryHandoff)
                throw new InvalidOperationException("The completed recovery owner lost the window-close decision.");
        }
        finally
        {
            await File.WriteAllTextAsync(Path.Combine(root, "release"), "finish");
            try { await operation.WaitAsync(TimeSpan.FromSeconds(10)); }
            catch (InvalidOperationException) { }
            try { await visibleOperation.WaitAsync(TimeSpan.FromSeconds(10)); }
            catch (InvalidOperationException) { }
            await DeleteFixtureDirectoryAsync(root);
        }
    }

    private static async Task AssertBoundedObservationRetainsOwnerAsync()
    {
        var observation = new NativeSetupObservation();
        if (!observation.TryBegin()) throw new InvalidOperationException("Setup rejected its first owner.");
        var generation = observation.Generation;
        var owner = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var visible = observation.ObserveAsync(owner.Task);
        observation.MarkUnconfirmed(1);
        if (await visible.WaitAsync(TimeSpan.FromSeconds(1)) ||
            await observation.CheckCompletionAsync(TimeSpan.FromMilliseconds(20)))
            throw new InvalidOperationException("A pending save was reported as complete.");
        observation.Complete();
        if (observation.TryBegin())
            throw new InvalidOperationException("Setup released ownership before the completion task finished.");
        owner.SetResult();
        if (!await observation.CheckCompletionAsync(TimeSpan.FromSeconds(1)) || !observation.TryBegin() ||
            observation.Generation != generation + 1 || observation.CompletionUnconfirmed)
            throw new InvalidOperationException("Setup could not start a clean save after completion.");
        var failure = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var nextVisible = observation.ObserveAsync(failure.Task);
        if (nextVisible.IsCompleted)
            throw new InvalidOperationException("A previous handoff completed the next save's observation.");
        observation.MarkUnconfirmed(2);
        if (await nextVisible.WaitAsync(TimeSpan.FromSeconds(1)))
            throw new InvalidOperationException("A second pending save was reported as complete.");
        observation.Complete();
        var expected = new InvalidOperationException("fixture completion failed");
        failure.SetException(expected);
        try
        {
            await observation.CheckCompletionAsync(TimeSpan.FromSeconds(1));
            throw new InvalidOperationException("The status check hid the original completion failure.");
        }
        catch (InvalidOperationException error) when (ReferenceEquals(error, expected)) { }
    }

    private static void AssertRecoveryStatusRejectsUntrustedResults()
    {
        const string clear = "{\"schemaVersion\":1,\"kind\":\"native-configuration-recovery\",\"agent\":\"openclaw\",\"state\":\"clear\"}";
        const string pending = "{\"schemaVersion\":1,\"kind\":\"native-configuration-recovery\",\"agent\":\"openclaw\",\"state\":\"needs-resave\",\"operationId\":\"0123456789abcdef0123456789abcdef\",\"writerProcessId\":123}";
        foreach (var agent in new[] { "openclaw", "hermes" })
        {
            if (NativeSetupOperations.ReadRecovery(clear.Replace("openclaw", agent), agent) ||
                !NativeSetupOperations.ReadRecovery(pending.Replace("openclaw", agent), agent))
                throw new InvalidOperationException("Setup misclassified a retained agent's recovery status.");
            var details = NativeSetupOperations.ReadRecoveryDetails(pending.Replace("openclaw", agent), agent);
            if (details.OperationId != "0123456789abcdef0123456789abcdef" ||
                NativeSetupOperations.ReadRecoveryDetails(clear.Replace("openclaw", agent), agent).OperationId is not null)
                throw new InvalidOperationException("Setup lost or invented a recovery operation identity.");
        }
        foreach (var value in new[]
        {
            "null", "[]", "{", clear.Replace("openclaw", "hermes"), clear.Replace("openclaw", "pi"),
            clear.Replace("\"schemaVersion\":1", "\"schemaVersion\":2"),
            clear.Replace("\"state\":\"clear\"", "\"state\":\"clear\",\"state\":\"clear\""),
            clear.Replace("clear", "unknown"), clear.Replace("clear", "needs-resave"),
            clear.Replace("}", ",\"unexpected\":true}"), pending.Replace("needs-resave", "clear"),
            pending.Replace("0123456789abcdef0123456789abcdef", "NOT-AN-OPERATION"),
            pending.Replace("123", "0"), pending.Replace("123", "-1"), pending.Replace("123", "2147483648"),
            pending.Replace("123", "1.5"), pending.Replace("123", "\"123\""),
        })
        {
            var rejected = false;
            try { NativeSetupOperations.ReadRecovery(value, "openclaw"); }
            catch (Exception error) when (error is InvalidOperationException or JsonException) { rejected = true; }
            if (!rejected) throw new InvalidOperationException("Setup accepted an invalid or ambiguous recovery result.");
        }
        try
        {
            NativeSetupOperations.ReadRecovery(clear.Replace("openclaw", "pi"), "pi");
            throw new Exception("Setup accepted recovery for a retired agent.");
        }
        catch (InvalidOperationException) { }
    }

    private static void AssertSavedSettingsAgentBoundary()
    {
        foreach (var agent in new[] { "openclaw", "hermes" })
        foreach (var (provider, endpoint) in new[] {
            ("nvidia", "https://integrate.api.nvidia.com/v1"), ("openrouter", "https://openrouter.ai/api/v1"),
            ("compatible", "https://example.invalid/custom/v1"), ("local", "http://127.0.0.1:12345/v1"),
        })
        {
            var value = JsonSerializer.Serialize(new { schemaVersion = 1, kind = "native-saved-settings", agent, state = "saved",
                settings = new { inference = provider, endpoint, model = "saved-model", credentialStored = provider is "nvidia" or "openrouter", options = new { } } });
            var saved = NativeSetupOperations.ReadSavedSettings(value, agent);
            if (saved.State != "saved" || saved.Configuration is not NativeSetupConfiguration configuration
                || configuration.Agent != agent || configuration.Inference != provider || configuration.Endpoint != endpoint
                || configuration.Model != "saved-model")
                throw new InvalidOperationException("Saved settings did not preserve the selected agent, provider, endpoint and model.");
            foreach (var rejected in new[] {
                value.Replace($"\"agent\":\"{agent}\"", "\"agent\":\"pi\""),
                value.Replace($"\"agent\":\"{agent}\"", $"\"agent\":\"{(agent == "hermes" ? "openclaw" : "hermes")}\""),
                value.Replace("\"options\":{}", "\"options\":{},\"key\":\"fixture-only-secret\""),
            })
            {
                var failed = false;
                try { NativeSetupOperations.ReadSavedSettings(rejected, agent); }
                catch (InvalidOperationException) { failed = true; }
                if (!failed) throw new InvalidOperationException("Saved settings accepted another agent or an unexpected credential field.");
            }
        }
    }

    internal static async Task DeleteFixtureDirectoryAsync(string root)
    {
        // The helper has exited; Windows can briefly retain a sharing lock during file teardown.
        var deadline = System.Diagnostics.Stopwatch.StartNew();
        while (true)
        {
            try { Directory.Delete(root, recursive: true); return; }
            catch (IOException error) when (OperatingSystem.IsWindows()
                && (error.HResult & 0xffff) is 32 or 33 && deadline.Elapsed < TimeSpan.FromSeconds(1))
            {
                await Task.Delay(20);
            }
        }
    }

    private static async Task AssertPreparationTimeoutStopsHelperAsync()
    {
        var root = Directory.CreateTempSubdirectory("nemoclaw-setup-prepare-").FullName;
        var launcher = Environment.ProcessPath ?? throw new InvalidOperationException("The fixture executable is unavailable.");
        var arguments = new List<string>();
        if (Path.GetFileNameWithoutExtension(launcher).Equals("dotnet", StringComparison.OrdinalIgnoreCase))
            arguments.Add(typeof(Program).Assembly.Location);
        arguments.AddRange(new[] { "--helper-fixture", root, "0", "0", "--prepare-all" });
        var operation = NativeSetupOperations.RunSetupHelperAsync(launcher, arguments.ToArray(), Array.Empty<byte>(),
            captureOutput: true, observationDeadline: TimeSpan.FromSeconds(1));
        try
        {
            var ready = Path.Combine(root, "ready");
            using var readyLimit = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            while (!File.Exists(ready) && !operation.IsCompleted) await Task.Delay(20, readyLimit.Token);
            if (!File.Exists(ready))
                throw new InvalidOperationException("The preparation helper never acquired its fixture lease before the deadline.");
            using var helper = System.Diagnostics.Process.GetProcessById(int.Parse(await File.ReadAllTextAsync(ready)));
            // Hold the actual process handle before cancellation, not a later lookup of a reusable PID.
            _ = helper.SafeHandle;
            if (helper.HasExited)
                throw new InvalidOperationException("The preparation fixture exited before its timeout could be observed.");
            try
            {
                await operation.WaitAsync(TimeSpan.FromSeconds(10));
                throw new InvalidOperationException("The read-only preparation deadline was ignored.");
            }
            catch (OperationCanceledException) { }
            helper.Refresh();
            if (!helper.WaitForExit(0) || !helper.HasExited)
                throw new InvalidOperationException($"Timed-out preparation helper {helper.Id} is still running.");
            if (File.Exists(Path.Combine(root, "result")))
                throw new InvalidOperationException("The timed-out preparation helper completed unexpectedly.");
            try
            {
                using var releasedLease = new FileStream(Path.Combine(root, "lease"), FileMode.Open, FileAccess.ReadWrite, FileShare.None);
            }
            catch (IOException error)
            {
                throw new IOException($"Preparation helper {helper.Id} exited with code {helper.ExitCode}, but its lease could not be reopened; HRESULT=0x{error.HResult:X8}.", error);
            }
        }
        finally
        {
            await File.WriteAllTextAsync(Path.Combine(root, "release"), "finish");
            try { await operation.WaitAsync(TimeSpan.FromSeconds(10)); }
            catch (OperationCanceledException) { }
            await DeleteFixtureDirectoryAsync(root);
        }
    }

    internal static async Task<int> Main(string[] arguments)
    {
        if (arguments.FirstOrDefault() == "--helper-fixture") return await RunHelperFixtureAsync(arguments);
        await AssertPrecancelledSaveDoesNotLaunchAsync();
        await AssertCancellationAfterSuccessfulPreparationStopsMutationAsync();
        await AssertCancellationDuringCommitTransitionStopsMutationAsync();
        await AssertSuccessfulOrderingAsync();
        await AssertCancellationIsDeferredUntilPreparationFinishesAsync();
        await AssertCredentialTransactionAsync(false);
        await AssertCredentialTransactionAsync(true);
        await AssertDownloadedModelOrderingAsync(false, false);
        await AssertDownloadedModelOrderingAsync(true, false);
        await AssertDownloadedModelOrderingAsync(false, true);
        AssertRecoverableMaintenanceCancellationCanRetry();
        AssertCancellationFailureDetail();
        AssertRecoverableMaintenanceProductionWiring();
        await AssertTransactionOutlivesObserverAsync(0, 0);
        await AssertTransactionOutlivesObserverAsync(7, 0);
        await AssertTransactionOutlivesObserverAsync(0, 1);
        await AssertTransactionOutlivesObserverAsync(0, 65536);
        await AssertTransactionOutlivesObserverAsync(0, 0, observerThrows: true);
        await AssertTransactionOutlivesObserverAsync(0, 0, recoveryHandoff: true);
        await AssertTransactionOutlivesObserverAsync(7, 0, recoveryHandoff: true);
        await AssertTransactionOutlivesObserverAsync(0, 65536, recoveryHandoff: true);
        await AssertTransactionOutlivesObserverAsync(0, 0, observerThrows: true, recoveryHandoff: true);
        await AssertTransactionOutlivesObserverAsync(0, 0, recoveryHandoff: true, recoveryObserverThrows: true);
        await AssertPreparationTimeoutStopsHelperAsync();
        await AssertBoundedObservationRetainsOwnerAsync();
        AssertRecoveryStatusRejectsUntrustedResults();
        AssertSavedSettingsAgentBoundary();
        Console.WriteLine("27 native setup controls passed; bounded recovery checks preserve transaction ownership and reject invalid status.");
#if NATIVE_WPF_CONTROLS
        WindowRecoveryControls.Run();
#endif
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

internal static class NativeDownloadedModelSetup
{
    internal static Func<CancellationToken, Task>? Ready { get; set; }
    internal static bool IsModel(string? id) => id == "fixture-downloaded-model";
    internal static void ValidateSelection(JsonElement preparation, string selected)
    {
        if (!IsModel(selected) || !preparation.TryGetProperty("localModel", out var model) || model.ValueKind != JsonValueKind.Object)
            throw new InvalidOperationException("Invalid downloaded-model fixture metadata.");
    }
    internal static Task EnsureReadyAsync(string launcher, string selected, Action<NativeExpressProgress>? progress, CancellationToken cancellation) =>
        (Ready ?? throw new InvalidOperationException("Unexpected model readiness invocation."))(cancellation);
}

internal static class NativeDesktopIntegration
{
    internal static int EnsureCalls { get; set; }
    internal static void Ensure(string agent, string launcher) => EnsureCalls++;
}
