// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System.Diagnostics;
using System.IO;
using System.Security;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Nvidia.NemoClaw.Bootstrapper;

internal delegate Task<string> NativeSetupHelperRunner(string launcher, string[] arguments, byte[] input, bool captureOutput);
internal sealed record NativeSavedSettings(string State, NativeSetupConfiguration? Configuration);

// Closing an unconfirmed window must not release the transaction or permit another save.
internal sealed class NativeSetupObservation
{
    private TaskCompletionSource recoveryAvailable = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private Task? completion;
    internal bool Running { get; private set; }
    internal int? HelperProcessId { get; private set; }
    internal bool CompletionUnconfirmed { get; private set; }
    internal bool CloseRequested { get; private set; }
    internal long Generation { get; private set; }

    internal bool TryBegin()
    {
        if (Running || completion is { IsCompleted: false }) return false;
        Running = true;
        Generation++;
        completion = null;
        recoveryAvailable = new(TaskCreationOptions.RunContinuationsAsynchronously);
        HelperProcessId = null;
        CompletionUnconfirmed = false;
        CloseRequested = false;
        return true;
    }

    internal void MarkUnconfirmed(int processId)
    {
        if (!Running || processId <= 0) throw new InvalidOperationException("No configuration helper is owned by Setup.");
        HelperProcessId = processId;
        CompletionUnconfirmed = true;
        recoveryAvailable.TrySetResult();
    }

    // The bounded visible operation may finish while its transaction owner remains live.
    // Keep that owner's task here until it drains the pipes and clears its private buffers.
    internal async Task<bool> ObserveAsync(Task ownedCompletion)
    {
        if (completion is not null && !ReferenceEquals(completion, ownedCompletion))
            throw new InvalidOperationException("Setup already owns another configuration operation.");
        completion = ownedCompletion;
        if (await Task.WhenAny(ownedCompletion, recoveryAvailable.Task) != ownedCompletion) return false;
        await ownedCompletion;
        return true;
    }

    internal async Task<bool> CheckCompletionAsync(TimeSpan deadline)
    {
        if (completion is null) return !Running;
        if (await Task.WhenAny(completion, Task.Delay(deadline)) != completion) return false;
        await completion;
        return !Running;
    }

    internal bool TryCloseWindow()
    {
        if (!Running || !CompletionUnconfirmed) return false;
        CloseRequested = true;
        return true;
    }

    internal void ConfirmTransactionExit() => CompletionUnconfirmed = false;

    internal void Complete()
    {
        ConfirmTransactionExit();
        Running = false;
    }
}

internal static class NativeSetupOperations
{
    internal static bool HasSavedSetup(string agent, string? localApplicationData = null)
    {
        if (agent is not ("openclaw" or "hermes")) throw new InvalidOperationException("Saved setup inspection is unavailable for this agent.");
        // This is only a UI hint after interrupted replacement, never validation.
        // The newly installed helper must still read and validate the saved setup.
        var root = localApplicationData ?? Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        return File.Exists(Path.Combine(root, "NVIDIA", "NemoClaw", "agents", agent, "native-windows.json"));
    }

    internal static Task<string> ReadSavedSettingsAsync(string agent)
    {
        if (agent is not ("openclaw" or "hermes")) throw new InvalidOperationException("Saved settings inspection is unavailable for this agent.");
        var launcher = InstalledLauncher();
        // Read-only helper cleanup must not depend on a window's dispatcher surviving.
        return Task.Run(() => RunSetupHelperAsync(launcher, new[] { "--configure-native", "--read-settings", agent },
            Array.Empty<byte>(), captureOutput: true, observationDeadline: TimeSpan.FromSeconds(45), maxOutputCharacters: 16384));
    }

    internal static NativeSavedSettings ReadSavedSettings(string value, string agent)
    {
        const string invalid = "The saved settings response is invalid.";
        if (agent is not ("openclaw" or "hermes") || value.Length is < 1 or > 16384) throw new InvalidOperationException(invalid);
        try
        {
            using var document = JsonDocument.Parse(value, new JsonDocumentOptions { MaxDepth = 8 });
            var root = document.RootElement;
            Fields(root, true, "schemaVersion", "kind", "agent", "state", "settings");
            if (root.GetProperty("schemaVersion").GetInt32() != 1 || root.GetProperty("kind").GetString() != "native-saved-settings"
                || root.GetProperty("agent").GetString() != agent) throw new InvalidOperationException(invalid);
            var state = root.GetProperty("state").GetString();
            var settings = root.GetProperty("settings");
            if (state is "unconfigured" or "needs-resave")
            {
                if (settings.ValueKind != JsonValueKind.Null) throw new InvalidOperationException(invalid);
                return new(state, null);
            }
            if (state != "saved") throw new InvalidOperationException(invalid);
            var managed = settings.TryGetProperty("localModel", out var local);
            Fields(settings, true, "inference", "model", "credentialStored", "options", managed ? "localModel" : "endpoint");
            var provider = settings.GetProperty("inference").GetString();
            var model = settings.GetProperty("model").GetString();
            var stored = settings.GetProperty("credentialStored").GetBoolean();
            if (provider is not ("nvidia" or "openrouter" or "compatible" or "local")
                || model is null || model.Length is 0 or > 256 || model.Any(char.IsControl)
                || provider is "nvidia" or "openrouter" && !stored) throw new InvalidOperationException(invalid);
            string? endpoint = null;
            string? localModel = null;
            if (managed)
            {
                localModel = local.GetString();
                var known = localModel == NativeExpressSetup.Id && model == NativeExpressSetup.Model
                    || NativeDownloadedModelSetup.IsModel(localModel) && model == localModel;
                if (!known || provider != "local" || stored) throw new InvalidOperationException(invalid);
            }
            else
            {
                endpoint = settings.GetProperty("endpoint").GetString();
                if (!Uri.TryCreate(endpoint, UriKind.Absolute, out var uri) || uri.UserInfo.Length != 0
                    || uri.Query.Length != 0 || uri.Fragment.Length != 0
                    || (provider == "local" ? uri.Host is not ("127.0.0.1" or "[::1]" or "::1") || uri.Scheme is not ("http" or "https") : uri.Scheme != "https")
                    || provider == "nvidia" && endpoint != "https://integrate.api.nvidia.com/v1"
                    || provider == "openrouter" && endpoint != "https://openrouter.ai/api/v1") throw new InvalidOperationException(invalid);
            }
            var options = settings.GetProperty("options");
            Fields(options, false, "search", "messaging");
            string? search = null;
            if (options.TryGetProperty("search", out var selectedSearch))
            {
                Fields(selectedSearch, true, "provider", "credentialStored");
                if (selectedSearch.GetProperty("credentialStored").ValueKind != JsonValueKind.True) throw new InvalidOperationException(invalid);
                search = selectedSearch.GetProperty("provider").GetString();
                if (search is null) throw new InvalidOperationException(invalid);
            }
            var messaging = new Dictionary<string, string[]>();
            if (options.TryGetProperty("messaging", out var channels))
            {
                Fields(channels, false, "telegram", "discord", "slack");
                foreach (var channel in channels.EnumerateObject())
                {
                    if (channel.Name == "slack") Fields(channel.Value, true, "credentialStored", "appCredentialStored", "allowedUsers");
                    else Fields(channel.Value, true, "credentialStored", "allowedUsers");
                    if (channel.Value.GetProperty("credentialStored").ValueKind != JsonValueKind.True
                        || channel.Name == "slack" && channel.Value.GetProperty("appCredentialStored").ValueKind != JsonValueKind.True)
                        throw new InvalidOperationException(invalid);
                    var users = channel.Value.GetProperty("allowedUsers");
                    if (users.ValueKind != JsonValueKind.Array || users.GetArrayLength() > 50
                        || users.EnumerateArray().Any(item => item.ValueKind != JsonValueKind.String)) throw new InvalidOperationException(invalid);
                    messaging[channel.Name] = users.EnumerateArray().Select(item => item.GetString()!).ToArray();
                }
            }
            var restored = new NativeSetupOptions { SearchProvider = search, Messaging = messaging };
            restored.Validate(agent);
            return new(state, new NativeSetupConfiguration(agent, provider, endpoint, model, stored) { LocalModel = localModel, Options = restored });
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException or KeyNotFoundException or FormatException)
        {
            throw new InvalidOperationException(invalid);
        }

        static void Fields(JsonElement record, bool exact, params string[] allowed)
        {
            if (record.ValueKind != JsonValueKind.Object) throw new InvalidOperationException(invalid);
            var names = record.EnumerateObject().Select(item => item.Name).ToArray();
            if ((exact && names.Length != allowed.Length) || names.Length != names.Distinct(StringComparer.Ordinal).Count()
                || names.Any(name => !allowed.Contains(name, StringComparer.Ordinal))) throw new InvalidOperationException(invalid);
        }
    }

    internal static async Task SaveAsync(NativeSetupConfiguration configuration, SecureString password, NativeServiceCredentials? serviceCredentials = null, Action<NativeExpressProgress>? progress = null, CancellationToken cancellation = default, Action<int>? completionUnconfirmed = null)
    {
        cancellation.ThrowIfCancellationRequested();
        var launcher = InstalledLauncher();
        if (!NativeMaintenance.SupportsDataRemoval())
            throw new InvalidOperationException("Install this preview before configuring its native agent settings.");
        var recovery = await ReadRecoveryAsync(configuration.Agent, launcher);
        if (recovery)
            progress?.Invoke(new("configuration", "Recovering an unfinished save with the choices you selected. The agent stays blocked until this save completes.", null, null));
        await SaveWithHelperAsync(configuration, password, serviceCredentials, progress, cancellation, launcher,
            (path, arguments, input, capture) => RunSetupHelperAsync(path, arguments, input, capture,
                () => progress?.Invoke(new("configuration", "Saving or recovering your settings is taking longer than expected. Setup is waiting for the configuration helper.", null, null)),
                completionUnconfirmed: completionUnconfirmed));
    }

    internal static async Task<bool> ReadRecoveryAsync(string agent, string? launcher = null)
    {
        if (agent is not ("openclaw" or "hermes")) throw new InvalidOperationException("The selected agent is invalid.");
        var response = await RunSetupHelperAsync(launcher ?? InstalledLauncher(),
            new[] { "--configure-native", "--recovery-status", agent }, Array.Empty<byte>(),
            captureOutput: true, observationDeadline: TimeSpan.FromSeconds(10));
        return ReadRecovery(response, agent);
    }

    internal static bool ReadRecovery(string value, string agent)
    {
        using var document = JsonDocument.Parse(value);
        var root = document.RootElement;
        if (agent is not ("openclaw" or "hermes") || root.ValueKind != JsonValueKind.Object)
            throw new InvalidOperationException("The configuration recovery result is invalid.");
        var names = root.EnumerateObject().Select(property => property.Name).ToArray();
        if (names.Length != names.Distinct(StringComparer.Ordinal).Count() ||
            !root.TryGetProperty("schemaVersion", out var schema) || schema.ValueKind != JsonValueKind.Number || !schema.TryGetInt32(out var version) || version != 1 ||
            !root.TryGetProperty("kind", out var kind) || kind.ValueKind != JsonValueKind.String || kind.GetString() != "native-configuration-recovery" ||
            !root.TryGetProperty("agent", out var selected) || selected.ValueKind != JsonValueKind.String || selected.GetString() != agent ||
            !root.TryGetProperty("state", out var state) || state.ValueKind != JsonValueKind.String)
            throw new InvalidOperationException("The configuration recovery result is invalid.");
        if (state.GetString() == "clear" && names.Length == 4) return false;
        if (state.GetString() != "needs-resave" || names.Length != 6 ||
            !root.TryGetProperty("operationId", out var operation) || operation.ValueKind != JsonValueKind.String ||
            operation.GetString() is not string id || id.Length != 32 || id.Any(character => !"0123456789abcdef".Contains(character)) ||
            !root.TryGetProperty("writerProcessId", out var writer) || writer.ValueKind != JsonValueKind.Number || !writer.TryGetInt32(out var processId) || processId <= 0)
            throw new InvalidOperationException("The configuration recovery result is invalid.");
        return true;
    }

    internal static async Task SaveWithHelperAsync(NativeSetupConfiguration configuration, SecureString password, NativeServiceCredentials? serviceCredentials, Action<NativeExpressProgress>? progress, CancellationToken cancellation, string launcher, NativeSetupHelperRunner runSetupHelper)
    {
        cancellation.ThrowIfCancellationRequested();
        var configurationBytes = Encoding.UTF8.GetBytes(configuration.SerializeRequest());
        var requiredServices = configuration.Options.RequiredServices();
        var suppliedServices = serviceCredentials?.Keys.ToArray() ?? Array.Empty<string>();
        if (!requiredServices.Order(StringComparer.Ordinal).SequenceEqual(suppliedServices.Order(StringComparer.Ordinal)))
            throw new InvalidOperationException("Integration keys no longer match the selected options.");
        var serviceBytes = new Dictionary<string, byte[]>();
        byte[]? credential = null;
        byte[]? transaction = null;
        try
        {
            credential = configuration.ReadCredential(password);
            foreach (var service in requiredServices)
                serviceBytes[service] = NativeSetupConfiguration.ReadServiceCredential(service, serviceCredentials![service]);
            // Preparation validates the complete metadata and every binding without mutating
            // configuration. Cancellation is intentionally deferred until that helper exits.
            if (configuration.LocalModel is not null)
                progress?.Invoke(new NativeExpressProgress("verification", "Checking the installed model and runtime before saving your settings.", null, null));
            var preparation = await runSetupHelper(launcher, new[] { "--configure-native", "--prepare-all" }, configurationBytes, true);
            ReadBindings(preparation, requiredServices, configuration.LocalModel);
            cancellation.ThrowIfCancellationRequested();
            if (configuration.LocalModel is not null)
                progress?.Invoke(new NativeExpressProgress("configuration", "Saving your choices and protecting the API key in Windows Credential Manager.", null, null));
            // The progress callback disables cancellation in the UI. This second check is the
            // commit boundary; once it passes, finish every credential and configuration write.
            cancellation.ThrowIfCancellationRequested();
            transaction = SerializeTransaction(configurationBytes, credential, serviceBytes);
            // The configuration owner acquires the state lease before touching credentials
            // and restores previous bindings if the save fails. Secrets use stdin only.
            await runSetupHelper(launcher, new[] { "--configure-native", "--transaction" }, transaction, false);
            NativeDesktopIntegration.Ensure(configuration.Agent, launcher);
        }
        finally
        {
            if (credential is not null) CryptographicOperations.ZeroMemory(credential);
            if (transaction is not null) CryptographicOperations.ZeroMemory(transaction);
            foreach (var bytes in serviceBytes.Values) CryptographicOperations.ZeroMemory(bytes);
        }
        if (NativeDownloadedModelSetup.IsModel(configuration.LocalModel))
        {
            // Commit and secret-buffer cleanup finish before cancellable model work starts.
            progress?.Invoke(new("checking", "Checking or resuming the selected model before GPU startup.", null, null));
            await NativeDownloadedModelSetup.EnsureReadyAsync(launcher, configuration.LocalModel!, progress, cancellation);
        }
    }

    private static byte[] SerializeTransaction(byte[] configuration, byte[] credential, Dictionary<string, byte[]> services)
    {
        using var buffer = new MemoryStream();
        try
        {
            using (var writer = new Utf8JsonWriter(buffer))
            {
                writer.WriteStartObject();
                writer.WritePropertyName("configuration");
                writer.WriteRawValue(configuration);
                writer.WriteStartObject("credentials");
                writer.WriteString("inference", credential.AsSpan());
                writer.WriteStartObject("services");
                foreach (var entry in services) writer.WriteString(entry.Key, entry.Value.AsSpan());
                writer.WriteEndObject();
                writer.WriteEndObject();
                writer.WriteEndObject();
            }
            return buffer.ToArray();
        }
        finally
        {
            if (buffer.TryGetBuffer(out var bytes)) CryptographicOperations.ZeroMemory(bytes.AsSpan());
        }
    }

    internal static void Launch(string agent)
    {
        if (agent is not ("openclaw" or "hermes")) throw new InvalidOperationException("The selected agent is invalid.");
        var launcher = InstalledLauncher();
        using var child = Process.Start(new ProcessStartInfo
        {
            FileName = launcher,
            Arguments = $"--configured --agent {agent}",
            UseShellExecute = true,
            WorkingDirectory = Path.GetDirectoryName(launcher)!,
        }) ?? throw new InvalidOperationException("The configured agent could not start.");
    }

    internal static async Task<string> RunSetupHelperAsync(string launcher, string[] arguments, byte[] input, bool captureOutput = false,
        Action? waitingForTransaction = null, TimeSpan? observationDeadline = null,
        Action<int>? completionUnconfirmed = null, TimeSpan? recoveryDeadline = null, int maxOutputCharacters = 4096)
    {
        if (maxOutputCharacters is < 4096 or > 16384 ||
            maxOutputCharacters != 4096 && (!captureOutput || arguments.Contains("--transaction") || !arguments.Contains("--read-settings")))
            throw new ArgumentOutOfRangeException(nameof(maxOutputCharacters));
        var startInfo = new ProcessStartInfo
        {
            FileName = launcher,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            StandardInputEncoding = new UTF8Encoding(false),
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = Path.GetDirectoryName(launcher)!,
        };
        foreach (var argument in arguments) startInfo.ArgumentList.Add(argument);
        using var process = new Process { StartInfo = startInfo };
        var transaction = arguments.Contains("--transaction");
        var deadline = observationDeadline ?? TimeSpan.FromSeconds(transaction ? 600 : 30);
        using var timeout = new CancellationTokenSource();
        if (!transaction) timeout.CancelAfter(deadline);
        if (!process.Start()) throw new InvalidOperationException("The native setup helper could not start.");
        try
        {
            var stdout = ReadBoundedOutputAsync(process.StandardOutput, timeout.Token, captureOutput, transaction, maxOutputCharacters);
            var stderr = ReadBoundedOutputAsync(process.StandardError, timeout.Token, drainOnOverflow: transaction);
            var completion = Task.WhenAll(WriteHelperInputAsync(process.StandardInput, input, timeout.Token), process.WaitForExitAsync(timeout.Token), stdout, stderr);
            Exception? observationError = null;
            try
            {
                // Hand off the visible wait without disposing the helper, pipes or input buffer.
                // The recovery window retains its dispatcher until this operation finishes.
                if (transaction && await Task.WhenAny(completion, Task.Delay(deadline, timeout.Token)) != completion)
                {
                    try { waitingForTransaction?.Invoke(); }
                    catch (Exception error) { observationError = error; }
                    if (await Task.WhenAny(completion, Task.Delay(recoveryDeadline ?? TimeSpan.FromSeconds(60), timeout.Token)) != completion)
                    {
                        try { completionUnconfirmed?.Invoke(process.Id); }
                        catch (Exception error) { observationError ??= error; }
                    }
                }
            }
            finally { await completion; }
            if (observationError is not null) throw observationError;
            if (process.ExitCode != 0 || (!captureOutput && stdout.Result.Count != 0))
            {
                throw new InvalidOperationException("The native setup helper rejected the configuration.");
            }
            return captureOutput ? stdout.Result.Value : string.Empty;
        }
        finally
        {
            timeout.Cancel();
            // HasExited can observe an exit code before Windows signals the process handle.
            // Keep ownership until the kernel wait completes, including after cancellation.
            if (!process.WaitForExit(0))
            {
                if (transaction) await Task.Run(() => process.WaitForExit());
                else
                {
                    process.Kill(entireProcessTree: true);
                    if (!await Task.Run(() => process.WaitForExit(5000)))
                        throw new TimeoutException("The native setup helper did not stop within its cleanup deadline.");
                }
            }
        }
    }

    internal static (string? Inference, Dictionary<string, string> Services) ReadBindings(string value, IReadOnlyCollection<string> requiredServices, string? localModel = null)
    {
        using var document = JsonDocument.Parse(value);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object || root.EnumerateObject().Count() != (localModel is null ? 3 : 4) ||
            !root.TryGetProperty("schemaVersion", out var schema) || schema.ValueKind != JsonValueKind.Number || schema.GetInt32() != 1 ||
            !root.TryGetProperty("inference", out var inference) ||
            !root.TryGetProperty("services", out var services) || services.ValueKind != JsonValueKind.Object)
            throw new InvalidOperationException("The native setup helper returned invalid credential bindings.");
        var bindings = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var entry in services.EnumerateObject())
        {
            if (!requiredServices.Contains(entry.Name, StringComparer.Ordinal) || !bindings.TryAdd(entry.Name, ReadBinding(entry.Value)))
                throw new InvalidOperationException("The native setup helper returned unexpected integration bindings.");
        }
        if (bindings.Count != requiredServices.Count)
            throw new InvalidOperationException("The native setup helper omitted integration bindings.");
        if (localModel is not null)
        {
            if (inference.ValueKind != JsonValueKind.Null) throw new InvalidOperationException("The local model must not request an external credential binding.");
            if (NativeDownloadedModelSetup.IsModel(localModel)) NativeDownloadedModelSetup.ValidateSelection(root, localModel);
            else NativeExpressSetup.ValidatePrebuiltSelection(root, localModel);
            return (null, bindings);
        }
        return (ReadBinding(inference), bindings);
    }

    private static string ReadBinding(JsonElement value)
    {
        var binding = value.ValueKind == JsonValueKind.String ? value.GetString() : null;
        if (binding is null || binding.Length != 64 || binding.Any(character => character is not (>= '0' and <= '9') and not (>= 'a' and <= 'f')))
            throw new InvalidOperationException("The native setup helper returned an invalid credential binding.");
        return binding;
    }

    private static async Task WriteHelperInputAsync(StreamWriter writer, byte[] input, CancellationToken cancellation)
    {
        try { await writer.BaseStream.WriteAsync(input, cancellation); }
        finally { writer.Close(); }
    }

    private static async Task<(int Count, string Value)> ReadBoundedOutputAsync(StreamReader reader, CancellationToken cancellation, bool capture = false, bool drainOnOverflow = false, int maximum = 4096)
    {
        var buffer = new char[512];
        var value = capture ? new StringBuilder() : null;
        var total = 0;
        int count;
        try
        {
            while ((count = await reader.ReadAsync(buffer.AsMemory(), cancellation)) != 0)
            {
                total = Math.Min(maximum + 1, total + count);
                if (total > maximum && !drainOnOverflow) throw new InvalidOperationException("The native setup helper exceeded its output bound.");
                // Discard excess transaction output without breaking its pipe during rollback.
                if (total <= maximum) value?.Append(buffer, 0, count);
                Array.Clear(buffer);
            }
            if (total > maximum) throw new InvalidOperationException("The native setup helper exceeded its output bound.");
            return (total, value?.ToString() ?? string.Empty);
        }
        finally { Array.Clear(buffer); }
    }

    internal static string InstalledLauncher()
    {
        if (Environment.GetCommandLineArgs().Skip(1).FirstOrDefault() is "--onboard" or "--installer" or "--web-session")
        {
            var executable = Environment.ProcessPath ?? throw new InvalidOperationException("The native interface executable is unavailable.");
            var uiRoot = Path.GetDirectoryName(executable)!;
            if (!string.Equals(Path.GetFileName(uiRoot), "native-ui", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("The native interface is outside its installed location.");
            }
            var installRoot = Directory.GetParent(uiRoot)?.FullName ?? throw new InvalidOperationException("The native installation directory is unavailable.");
            return Path.Combine(installRoot, "bin", "NemoClaw.exe");
        }
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "NVIDIA", "NemoClaw", "bin", "NemoClaw.exe");
    }

}
