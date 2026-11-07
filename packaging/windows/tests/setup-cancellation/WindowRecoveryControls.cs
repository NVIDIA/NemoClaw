// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#if NATIVE_WPF_CONTROLS
extern alias NativeBootstrapper;

using System.Reflection;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using MainWindow = NativeBootstrapper::Nvidia.NemoClaw.Bootstrapper.MainWindow;

namespace Nvidia.NemoClaw.Bootstrapper;

internal static class WindowRecoveryControls
{
    private static bool recoveryLeaseUnavailable;

    private static void AssertRemovalChoices()
    {
        var options = new NativeBootstrapper::Nvidia.NemoClaw.Bootstrapper.NativeRemovalOptions();
        var panel = (WrapPanel)options.FindName("Agents");
        var choices = panel.Children.OfType<CheckBox>().ToArray();
        if (!choices.Select(choice => (string)choice.Tag).SequenceEqual(new[] { "openclaw", "hermes" }) ||
            !choices.Select(choice => (string)choice.Content).SequenceEqual(new[] { "OpenClaw", "Hermes" }))
            throw new InvalidOperationException("Removal choices include an unsupported agent.");
        var removal = (CheckBox)options.FindName("RemoveData");
        if (options.SelectedAgents.Length != 0) throw new InvalidOperationException("Removal selected data without consent.");
        removal.IsChecked = true;
        if (!options.RequiresSelection) throw new InvalidOperationException("Removal accepted an empty selection.");
        foreach (var choice in choices) choice.IsChecked = true;
        if (options.RequiresSelection || !options.SelectedAgents.SequenceEqual(new[] { "openclaw", "hermes" }))
            throw new InvalidOperationException("Removal lost the explicit supported-agent selection.");
        options.SetAvailable(false);
        if (options.SelectedAgents.Length != 0 || removal.IsEnabled)
            throw new InvalidOperationException("Unavailable removal retained consent.");
    }

    private static Task<T> PendingRecoveryFixture<T>(string agent)
    {
        if (agent is not ("openclaw" or "hermes")) throw new InvalidOperationException("Unexpected recovery agent.");
        if (recoveryLeaseUnavailable) return Task.FromException<T>(new IOException("fixture lease unavailable"));
        return Task.FromResult((T)Activator.CreateInstance(typeof(T), BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic,
            null, new object[] { true, "0123456789abcdef0123456789abcdef" }, null)!);
    }

    private static void AssertLiveHelperRecovery(MainWindow window)
    {
        var root = Directory.CreateTempSubdirectory("nemoclaw-window-recovery-").FullName;
        var reader = typeof(MainWindow).GetField("readConfigurationRecovery", BindingFlags.Instance | BindingFlags.NonPublic)!;
        var previousReader = reader.GetValue(window);
        var responseType = reader.FieldType.GenericTypeArguments[1].GenericTypeArguments[0];
        var fixture = typeof(WindowRecoveryControls).GetMethod(nameof(PendingRecoveryFixture), BindingFlags.Static | BindingFlags.NonPublic)!.MakeGenericMethod(responseType);
        reader.SetValue(window, Delegate.CreateDelegate(reader.FieldType, fixture));
        if (Invoke(window, "TryBeginConfiguration") is not true)
            throw new InvalidOperationException("Setup rejected the live helper fixture.");
        var arguments = new List<string>();
        var launcher = Environment.ProcessPath!;
        if (Path.GetFileNameWithoutExtension(launcher).Equals("dotnet", StringComparison.OrdinalIgnoreCase))
            arguments.Add(typeof(Program).Assembly.Location);
        arguments.AddRange(new[] { "--helper-fixture", root, "0", "0", "--transaction" });
        var operation = NativeSetupOperations.RunSetupHelperAsync(launcher, arguments.ToArray(), Array.Empty<byte>(),
            observationDeadline: TimeSpan.FromMilliseconds(50), recoveryDeadline: TimeSpan.FromMilliseconds(50),
            completionUnconfirmed: processId => Invoke(window, "ShowConfigurationUnconfirmed", processId));
        var visible = (Task<bool>)Invoke(window, "ObserveConfigurationAsync", operation)!;
        void WaitUntil(Func<bool> done)
        {
            var deadline = System.Diagnostics.Stopwatch.StartNew();
            while (!done())
            {
                if (deadline.Elapsed > TimeSpan.FromSeconds(10)) throw new TimeoutException("Window recovery did not reach its bounded state.");
                window.Dispatcher.Invoke(() => { }, DispatcherPriority.Background);
                Thread.Sleep(10);
            }
        }
        try
        {
            WaitUntil(() => visible.IsCompleted && File.Exists(Path.Combine(root, "ready")));
            if (visible.GetAwaiter().GetResult() || operation.IsCompleted)
                throw new InvalidOperationException("Recovery claimed that the live save completed.");
            var processId = int.Parse(File.ReadAllText(Path.Combine(root, "ready")));
            using var helper = System.Diagnostics.Process.GetProcessById(processId);
            var detail = (TextBlock)window.FindName("FailureDetail");
            if (!detail.Text.Contains(processId.ToString()) || !detail.Text.Contains("restart Windows"))
                throw new InvalidOperationException("Recovery omitted its helper identity or maintenance procedure.");
            var button = (Button)window.FindName("ConfigurationRecoveryButton");
            recoveryLeaseUnavailable = true;
            Invoke(window, "CheckConfigurationRecoveryClicked", button, new RoutedEventArgs());
            WaitUntil(() => button.IsEnabled);
            if (!detail.Text.Contains("could not be verified") || helper.HasExited ||
                Invoke(window, "TryBeginConfiguration") is not false)
                throw new InvalidOperationException("An unavailable lease lost recovery custody.");
            recoveryLeaseUnavailable = false;
            Invoke(window, "CheckConfigurationRecoveryClicked", button, new RoutedEventArgs());
            WaitUntil(() => button.IsEnabled);
            if (!detail.Text.Contains("0123456789abcdef0123456789abcdef") || helper.HasExited ||
                operation.IsCompleted || Invoke(window, "TryBeginConfiguration") is not false)
                throw new InvalidOperationException("Lease reconciliation lost the operation identity or admitted an overlapping save.");
            try
            {
                using var lease = new FileStream(Path.Combine(root, "lease"), FileMode.Open, FileAccess.ReadWrite, FileShare.None);
                throw new InvalidOperationException("Recovery released the live transaction's lease.");
            }
            catch (IOException) { }
        }
        finally
        {
            File.WriteAllText(Path.Combine(root, "release"), "finish");
            WaitUntil(() => operation.IsCompleted);
            Invoke(window, "CompleteConfigurationObservation");
            reader.SetValue(window, previousReader);
            recoveryLeaseUnavailable = false;
            var cleanup = Program.DeleteFixtureDirectoryAsync(root);
            WaitUntil(() => cleanup.IsCompleted);
            cleanup.GetAwaiter().GetResult();
            operation.GetAwaiter().GetResult();
        }
    }

    private static void AssertCancellationPresentation()
    {
        var type = typeof(MainWindow).Assembly.GetType("Nvidia.NemoClaw.Bootstrapper.NemoClawBootstrapperApplication")!;
        var application = Activator.CreateInstance(type, nonPublic: true)!;
        var cancellation = type.GetField("cancellation", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(application)!;
        var stateType = cancellation.GetType();
        var request = stateType.GetMethod("Request", BindingFlags.Instance | BindingFlags.NonPublic)!;
        Func<bool> requested = () => (bool)stateType.GetProperty("IsRequested", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(cancellation)!;
        var window = (MainWindow)Activator.CreateInstance(typeof(MainWindow), BindingFlags.Instance | BindingFlags.NonPublic,
            null, new object[] { requested }, null)!;
        type.GetField("window", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(application, window);
        using var active = new CancellationTokenSource();
        window.CancelRequested += (_, _) => request.Invoke(cancellation, new object?[] { active });
        try
        {
            window.ShowProgress("Installing", "Installation is active.");
            Invoke(window, "CancelClicked", window, new RoutedEventArgs());
            if (!requested() || !active.IsCancellationRequested)
                throw new InvalidOperationException("The window's cancellation request did not reach the active controller.");
            window.ShowMaintenance();
            if (!requested())
                throw new InvalidOperationException("Presenting maintenance reset controller-owned cancellation.");
            window.ShowProgress("Finishing", "The controller is still canceling.");
            if (((TextBlock)window.FindName("ProgressTitle")).Text != "Cancelling safely"
                || ((Button)window.FindName("CancelButton")).IsEnabled)
                throw new InvalidOperationException("Progress did not reflect controller-owned cancellation.");
            type.GetMethod("ShowRecoverableMaintenanceError", BindingFlags.Instance | BindingFlags.NonPublic)!
                .Invoke(application, new object[] { new IOException("The canceled action has stopped.") });
            window.ShowProgress("Retrying", "The controller admitted a retry.");
            if (requested() || ((TextBlock)window.FindName("ProgressTitle")).Text != "Retrying"
                || !((Button)window.FindName("CancelButton")).IsEnabled)
                throw new InvalidOperationException("Controller recovery did not clear the displayed cancellation state.");
            request.Invoke(cancellation, new object?[] { null });
            window.ShowProgress("Finishing", "Cancellation originated outside the window.");
            if (((TextBlock)window.FindName("ProgressTitle")).Text != "Cancelling safely")
                throw new InvalidOperationException("The window retained an independent cancellation latch.");
        }
        finally { window.ShowSuccess(WixToolset.BootstrapperApplicationApi.LaunchAction.Repair); window.Close(); }
    }

    private static void AssertOnboardingAdmission()
    {
        var entry = typeof(MainWindow).Assembly.GetType("Nvidia.NemoClaw.Bootstrapper.Program")!
            .GetMethod("Main", BindingFlags.Static | BindingFlags.NonPublic)!;
        foreach (var agent in new[] { "pi", "langchain-deepagents-code", "nemocua", "Hermes", "", "../hermes" })
            if ((int)entry.Invoke(null, new object[] { new[] { "--onboard", "--agent", agent } })! != 2)
                throw new InvalidOperationException("Invalid onboarding input reached an agent's setup.");
        foreach (var arguments in new[] { new[] { "--onboard", "hermes" }, new[] { "--onboard", "hermes", "--agent" }, new[] { "--onboard", "--agent", "hermes", "extra" } })
            if ((int)entry.Invoke(null, new object[] { arguments })! != 2)
                throw new InvalidOperationException("Malformed onboarding arguments were admitted.");
    }

    private static void AssertSupersededBundleCallbacks()
    {
        var type = typeof(MainWindow).Assembly.GetType("Nvidia.NemoClaw.Bootstrapper.NemoClawBootstrapperApplication")!;
        var application = Activator.CreateInstance(type, nonPublic: true)!;
        type.GetField("retiringSupersededBundle", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(application, true);
        type.GetMethod("SubscribeToEngine", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(application, null);
        var callback = type.BaseType!.GetMethod("OnPlanPackageBegin", BindingFlags.Instance | BindingFlags.NonPublic)!;
        foreach (var package in new[] { "MxcSystemDrivePreparation", "MxcNullDevicePreparation",
            "NemoClawRuntimeRemovalCommit", "NemoClawRuntimeTransactionBegin", "NemoClawArm64Msi",
            "NemoClawRuntimeTransactionComplete", "NemoClawRuntimeRemovalBegin" })
        {
            var args = new WixToolset.BootstrapperApplicationApi.PlanPackageBeginEventArgs(package,
                WixToolset.BootstrapperApplicationApi.PackageState.Absent, true, 0, 0,
                WixToolset.BootstrapperApplicationApi.RequestState.None, 0,
                WixToolset.BootstrapperApplicationApi.RequestState.None, 0, false);
            callback.Invoke(application, new object[] { args });
            if (args.Cancel || args.State != WixToolset.BootstrapperApplicationApi.RequestState.Absent)
                throw new InvalidOperationException("Superseded package planning retained cache registration or requested installation.");
        }
        var bundle = System.Xml.Linq.XDocument.Load(Path.Combine(Directory.GetCurrentDirectory(), "packaging", "windows", "Bundle.wxs"));
        System.Xml.Linq.XNamespace ns = "http://wixtoolset.org/schemas/v4/wxs";
        var retirement = bundle.Descendants(ns + "Variable").Single(value => (string?)value.Attribute("Name") == "NemoClawRetireSuperseded");
        if ((string?)retirement.Attribute("Type") != "numeric" || (string?)retirement.Attribute("Value") != "0"
            || (string?)retirement.Attribute("Persisted") == "yes")
            throw new InvalidOperationException("Retirement must default off and must not survive a new installer process.");
        foreach (var id in new[] { "NemoClawRuntimeRemovalBegin", "NemoClawRuntimeRemovalCommit" })
            if ((string?)bundle.Descendants(ns + "ExePackage").Single(value => (string?)value.Attribute("Id") == id).Attribute("DetectCondition")
                != "NemoClawRetireSuperseded = 0")
                throw new InvalidOperationException("Superseded detection could still execute an old runtime removal helper.");
    }

    private static bool HasRenderedContent(byte[] pixels, int width, int height)
    {
        var colors = new HashSet<int>();
        var visiblePixels = 0;
        for (var y = 8; y < height - 8; y++)
            for (var x = 8; x < width - 8; x++)
            {
                var offset = (y * width + x) * 4;
                if (pixels[offset + 3] == 0) continue;
                visiblePixels++;
                colors.Add(pixels[offset] | pixels[offset + 1] << 8 | pixels[offset + 2] << 16);
                if (visiblePixels >= 1000 && colors.Count >= 2) return true;
            }
        return false;
    }

    private static void AssertPixelGuard()
    {
        const int size = 64;
        var pixels = new byte[size * size * 4];
        if (HasRenderedContent(pixels, size, size))
            throw new InvalidOperationException("A transparent frame satisfied presentation evidence.");
        for (var index = 0; index < pixels.Length; index += 4) pixels[index + 3] = 255;
        if (HasRenderedContent(pixels, size, size))
            throw new InvalidOperationException("An opaque single-color frame satisfied presentation evidence.");
        for (var y = 0; y < size; y++)
            for (var x = 0; x < 8; x++) pixels[(y * size + x) * 4] = 255;
        if (HasRenderedContent(pixels, size, size))
            throw new InvalidOperationException("A border-only frame satisfied presentation evidence.");
        for (var y = 8; y < size - 8; y++)
            for (var x = 8; x < size / 2; x++) pixels[(y * size + x) * 4] = 255;
        if (!HasRenderedContent(pixels, size, size))
            throw new InvalidOperationException("The pixel guard rejected visible high-contrast content.");
        for (var index = 0; index < pixels.Length; index += 4) pixels[index + 3] = 0;
        if (HasRenderedContent(pixels, size, size))
            throw new InvalidOperationException("Invisible RGB values satisfied presentation evidence.");
    }

    private static object? Invoke(MainWindow window, string method, params object[] arguments) =>
        (typeof(MainWindow).GetMethod(method, BindingFlags.Instance | BindingFlags.NonPublic)
            ?? throw new InvalidOperationException($"Missing Setup operation: {method}."))
        .Invoke(window, arguments);

    private static void AssertUpgradePresentation()
    {
        var window = new MainWindow();
        try
        {
            var button = (Button)window.FindName("InstallButton");
            Invoke(window, "SetUpgradeContext", true);
            if (button.Content as string != "Upgrade NemoClaw")
                throw new InvalidOperationException("A genuine upgrade was presented as a new installation.");
            Invoke(window, "SetReplacementSetupAvailable", (object)new[] { "hermes" });
            Invoke(window, "AgentSelected", new RadioButton { Tag = "hermes" }, new RoutedEventArgs());
            if (((CheckBox)window.FindName("KeepSavedSetup")).IsChecked != true || button.Content as string != "Upgrade NemoClaw")
                throw new InvalidOperationException("Upgrade lost the retained-setup default or action label.");
            Invoke(window, "SetUpgradeContext", false);
            if (button.Content as string != "Install NemoClaw")
                throw new InvalidOperationException("Legacy replacement retained the upgrade action.");
        }
        finally { window.ShowReady(false); window.Close(); }
    }

    private static void AssertCompletionPresentation(MainWindow window)
    {
        var detail = (TextBlock)window.FindName("SuccessDetail");
        window.ShowSuccess(WixToolset.BootstrapperApplicationApi.LaunchAction.Uninstall);
        if (!detail.Text.Contains("Your agent data and saved keys were kept.", StringComparison.Ordinal))
            throw new InvalidOperationException("Default uninstall did not report preserved agent data and keys.");
        var removal = (UserControl)window.FindName("RemovalOptions");
        ((CheckBox)removal.FindName("RemoveData")).IsChecked = true;
        var agents = (Panel)removal.FindName("Agents");
        agents.Children.OfType<CheckBox>().Single(value => value.Tag as string == "openclaw").IsChecked = true;
        window.ShowSuccess(WixToolset.BootstrapperApplicationApi.LaunchAction.Uninstall);
        if (!detail.Text.Contains("OpenClaw data and saved keys were removed.", StringComparison.Ordinal)
            || !detail.Text.Contains("Other agent data and shared local models were kept.", StringComparison.Ordinal))
            throw new InvalidOperationException("Selective uninstall reported that removed OpenClaw data was retained.");
        ((CheckBox)removal.FindName("RemoveData")).IsChecked = false;

        var availability = typeof(MainWindow).GetField("runtimeAvailability", BindingFlags.Instance | BindingFlags.NonPublic)!;
        var original = availability.GetValue(window);
        var parse = availability.FieldType.GetMethod("Parse", BindingFlags.Static | BindingFlags.NonPublic)!;
        try
        {
            foreach (var agent in new[] { "openclaw", "hermes" })
            foreach (var status in new[] { "unqualified", "not-included", "qualified" })
            {
                var record = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new
                {
                    schemaVersion = 1,
                    classification = "native-runtime-package-availability",
                    runtimeId = new string('a', 64),
                    manifestSha256 = new string('b', 64),
                    sourceRevision = new string('c', 40),
                    agents = new[] { "openclaw", "hermes" }.Select(selected => new { agent = selected, status = selected == agent ? status : "not-included" }),
                });
                availability.SetValue(window, parse.Invoke(null, new object[] { record }));
                Invoke(window, "ApplyRuntimeAvailability");
                Invoke(window, "ShowNativeOnboarding", agent);
                var enabled = status is "qualified" or "unqualified";
                var expected = status == "unqualified"
                    ? "Preview: full runtime checks are pending."
                    : status == "qualified" ? string.Empty : "Unavailable in this preview";
                var selectedChoice = (RadioButton)window.FindName(agent == "openclaw" ? "OpenClawChoice" : "HermesChoice");
                if (((TextBlock)window.FindName("AgentAvailabilityDetail")).Text != expected
                    || window.SelectedAgent != agent
                    || ((Button)window.FindName("ContinueAgentButton")).IsEnabled != enabled
                    || selectedChoice.IsEnabled != enabled)
                    throw new InvalidOperationException($"Onboarding lost the {agent} preview warning or selected another agent.");
                // Exercise the fresh-install handlers without attaching a native install/save owner.
                typeof(MainWindow).GetField("packageInstalled", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(window, false);
                typeof(MainWindow).GetField("savedSettingsReady", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(window, true);
                Invoke(window, "ConfigureClicked", window, new RoutedEventArgs());
                if ((((FrameworkElement)window.FindName("ConfigurationPanel")).Visibility == Visibility.Visible) != enabled)
                    throw new InvalidOperationException($"The {agent} configuration did not respect runtime availability.");
                if (enabled && status == "unqualified" && !((TextBlock)window.FindName("ConfigurationDetail")).Text.StartsWith(expected, StringComparison.Ordinal))
                    throw new InvalidOperationException($"The {agent} preview warning disappeared during configuration.");
                var providers = (ComboBox)window.FindName("ProviderChoice");
                providers.SelectedItem = providers.Items.OfType<ComboBoxItem>().Single(value => value.Tag as string == "local");
                ((TextBox)window.FindName("EndpointBox")).Text = "http://127.0.0.1:12345/v1";
                ((TextBox)window.FindName("ModelBox")).Text = "preview-selected-model";
                ((CheckBox)window.FindName("LicenseCheck")).IsChecked = false;
                Invoke(window, "InstallClicked", window, new RoutedEventArgs());
                var configuration = typeof(MainWindow).GetProperty("Configuration", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)!;
                if (configuration.GetValue(window) is not null)
                    throw new InvalidOperationException("Preview setup bypassed software acceptance.");
                ((CheckBox)window.FindName("LicenseCheck")).IsChecked = true;
                Invoke(window, "InstallClicked", window, new RoutedEventArgs());
                var submitted = configuration.GetValue(window);
                if ((submitted is not null) != enabled
                    || submitted is not null && (submitted.GetType().GetProperty("Agent")!.GetValue(submitted) as string != agent
                        || submitted.GetType().GetProperty("Model")!.GetValue(submitted) as string != "preview-selected-model"
                        || submitted.GetType().GetProperty("Endpoint")!.GetValue(submitted) as string != "http://127.0.0.1:12345/v1"))
                    throw new InvalidOperationException("Preview configuration lost the chosen model/endpoint or admitted an absent runtime.");
                if (enabled)
                {
                    window.ShowConfiguredSuccess();
                    if (((TextBlock)window.FindName("SuccessStage")).Text != "04 / SETUP COMPLETE"
                        || ((TextBlock)window.FindName("LaunchStageLabel")).Text != "Setup complete"
                        || !((TextBlock)window.FindName("SuccessTitle")).Text.EndsWith("settings are saved.", StringComparison.Ordinal)
                        || ((Button)window.FindName("LaunchButton")).Visibility != Visibility.Visible
                        || ((TextBlock)window.FindName("SuccessDetail")).Text.StartsWith("Preview: full runtime checks are pending.", StringComparison.Ordinal) != (status == "unqualified"))
                        throw new InvalidOperationException("Saved settings changed preview qualification or lost the launch action.");
                }
            }
        }
        finally { availability.SetValue(window, original); Invoke(window, "ApplyRuntimeAvailability"); }
    }

    private static void AssertProviderChoices(MainWindow window)
    {
        // The availability matrix can leave either agent selected.
        Invoke(window, "AgentSelected", new RadioButton { Tag = "openclaw" }, new RoutedEventArgs());
        if (window.SelectedAgent != "openclaw")
            throw new InvalidOperationException("Provider draft controls did not start with OpenClaw selected.");
        var providers = (ComboBox)window.FindName("ProviderChoice");
        var endpoint = (TextBox)window.FindName("EndpointBox");
        var model = (TextBox)window.FindName("ModelBox");
        var credential = (PasswordBox)window.FindName("CredentialBox");
        ComboBoxItem Provider(string id) => providers.Items.OfType<ComboBoxItem>().Single(value => value.Tag as string == id);
        providers.SelectedItem = Provider("nvidia");
        model.Text = "chosen-hosted-model";
        credential.Password = "nvapi-ui-fixture-only";
        providers.SelectedItem = Provider("compatible");
        if (credential.SecurePassword.Length != 0)
            throw new InvalidOperationException("Provider changes retained a previous provider's API key.");
        endpoint.Text = "https://example.invalid/custom/v1";
        model.Text = "chosen-compatible-model";
        providers.SelectedItem = Provider("local");
        endpoint.Text = "http://127.0.0.1:12345/v1";
        model.Text = "chosen-local-model";
        providers.SelectedItem = Provider("compatible");
        if (endpoint.Text != "https://example.invalid/custom/v1" || model.Text != "chosen-compatible-model")
            throw new InvalidOperationException("Switching back to compatible inference lost the chosen endpoint or model.");
        providers.SelectedItem = Provider("nvidia");
        if (model.Text != "chosen-hosted-model" || endpoint.Text != "https://integrate.api.nvidia.com/v1"
            || credential.SecurePassword.Length != 0 || !endpoint.IsReadOnly)
            throw new InvalidOperationException("Switching back to hosted inference lost the model or changed credential/endpoint rules.");
        providers.SelectedItem = Provider("local");
        if (endpoint.Text != "http://127.0.0.1:12345/v1" || model.Text != "chosen-local-model")
            throw new InvalidOperationException("Switching back to local inference lost the chosen endpoint or model.");

        Invoke(window, "AgentSelected", new RadioButton { Tag = "hermes" }, new RoutedEventArgs());
        if (window.SelectedAgent != "hermes")
            throw new InvalidOperationException("Provider draft controls did not switch to Hermes.");
        endpoint.Text = "http://127.0.0.1:23456/v1";
        model.Text = "other-agent-local-model";
        credential.Password = "other-agent-ui-fixture-only";
        Invoke(window, "AgentSelected", new RadioButton { Tag = "openclaw" }, new RoutedEventArgs());
        if (window.SelectedAgent != "openclaw"
            || endpoint.Text != "http://127.0.0.1:12345/v1" || model.Text != "chosen-local-model"
            || credential.SecurePassword.Length != 0)
            throw new InvalidOperationException("Another agent changed OpenClaw's draft choices or retained its API key.");

        providers.SelectedItem = Provider("openrouter");
        model.Text = "chosen-openrouter-model";
        credential.Password = "sk-or-ui-fixture-only";
        providers.SelectedItem = Provider("local");
        providers.SelectedItem = Provider("openrouter");
        if (model.Text != "chosen-openrouter-model" || endpoint.Text != "https://openrouter.ai/api/v1"
            || credential.SecurePassword.Length != 0 || !endpoint.IsReadOnly)
            throw new InvalidOperationException("OpenRouter lost its chosen model or changed credential/endpoint rules.");

        var managed = new ComboBoxItem { Tag = "n1x", Content = "Fixture managed model" };
        providers.Items.Add(managed);
        providers.SelectedItem = managed;
        var managedModel = model.Text;
        model.Text = "must-not-restore-this-managed-draft";
        providers.SelectedItem = Provider("local");
        providers.SelectedItem = managed;
        if (model.Text != managedModel || !model.IsReadOnly || !endpoint.IsReadOnly
            || endpoint.Visibility != Visibility.Collapsed || credential.Visibility != Visibility.Collapsed)
            throw new InvalidOperationException("A managed model restored editable draft values or exposed endpoint/key fields.");
        providers.SelectedItem = Provider("local");
        if (endpoint.Text != "http://127.0.0.1:12345/v1" || model.Text != "chosen-local-model")
            throw new InvalidOperationException("Managed inference changed the existing local-server choices.");
        providers.Items.Remove(managed);
    }

    private static void AssertSavedOutputBounds()
    {
        var operations = typeof(MainWindow).Assembly.GetType("Nvidia.NemoClaw.Bootstrapper.NativeSetupOperations")!;
        var read = operations.GetMethod("ReadBoundedOutputAsync", BindingFlags.Static | BindingFlags.NonPublic)!;
        foreach (var (length, maximum, drain) in new[] { (5000, 16384, false), (16384, 16384, false), (16385, 16384, false), (4097, 4096, false), (8192, 4096, true) })
        {
            using var stream = new MemoryStream(System.Text.Encoding.UTF8.GetBytes(new string('x', length)));
            using var reader = new StreamReader(stream);
            var operation = (Task<(int Count, string Value)>)read.Invoke(null, new object[] { reader, CancellationToken.None, true, drain, maximum })!;
            try
            {
                var result = operation.GetAwaiter().GetResult();
                if (length > maximum || result.Count != length || result.Value.Length != length)
                    throw new InvalidOperationException("Saved-settings output violated its selected bound.");
            }
            catch (InvalidOperationException error) when (error.Message == "The native setup helper exceeded its output bound.")
            {
                if (length <= maximum || drain && stream.Position != stream.Length)
                    throw new InvalidOperationException("Overflow stopped transaction draining or rejected valid metadata.");
            }
        }
        var helper = operations.GetMethod("RunSetupHelperAsync", BindingFlags.Static | BindingFlags.NonPublic)!;
        foreach (var (arguments, capture, maximum) in new[] {
            (new[] { "--prepare-all" }, true, 16384), (new[] { "--recovery-status", "openclaw" }, true, 16384),
            (new[] { "--read-settings", "openclaw" }, false, 16384), (new[] { "--read-settings", "--transaction" }, true, 16384),
            (new[] { "--read-settings", "openclaw" }, true, 16385), (new[] { "--read-settings", "openclaw" }, true, 4095),
        })
        {
            var operation = (Task<string>)helper.Invoke(null, new object?[] { "must-not-start", arguments, Array.Empty<byte>(), capture, null, null, null, null, maximum })!;
            try { operation.GetAwaiter().GetResult(); throw new InvalidOperationException("An unrelated helper received the larger settings bound."); }
            catch (ArgumentOutOfRangeException) { }
        }
    }

    private static void AssertSavedChoices(MainWindow window, string agent)
    {
        Invoke(window, "AgentSelected", new RadioButton { Tag = agent }, new RoutedEventArgs());
        var operations = typeof(MainWindow).Assembly.GetType("Nvidia.NemoClaw.Bootstrapper.NativeSetupOperations")!;
        var parse = operations.GetMethod("ReadSavedSettings", BindingFlags.Static | BindingFlags.NonPublic)!;
        object Read(string value) => parse.Invoke(null, new object[] { value, agent })!;
        string Saved(string provider, string endpoint, string model) => System.Text.Json.JsonSerializer.Serialize(new
        {
            schemaVersion = 1, kind = "native-saved-settings", agent, state = "saved",
            settings = new { inference = provider, endpoint, model, credentialStored = provider is "nvidia" or "openrouter", options = new
            {
                search = new { provider = "tavily", credentialStored = true },
                messaging = new Dictionary<string, object> {
                    ["telegram"] = new { credentialStored = true, allowedUsers = new[] { "123456" } },
                    ["slack"] = new { credentialStored = true, appCredentialStored = true, allowedUsers = new[] { "U123456" } },
                },
            } },
        });
        var services = (UserControl)window.FindName("ServiceOptions");
        foreach (var (provider, endpoint) in new[] {
            ("nvidia", "https://integrate.api.nvidia.com/v1"), ("openrouter", "https://openrouter.ai/api/v1"),
            ("compatible", "https://example.invalid/v1"), ("local", "http://127.0.0.1:12345/v1"),
        })
        {
            ((PasswordBox)window.FindName("CredentialBox")).Password = "fixture-only-inference-key";
            foreach (var name in new[] { "SearchKey", "TelegramKey", "SlackBotKey", "SlackAppKey" })
                ((PasswordBox)services.FindName(name)).Password = "fixture-only-service-key";
            var model = "saved-" + provider + "-model";
            Invoke(window, "ApplySavedSettings", Read(Saved(provider, endpoint, model)));
            if (((ComboBoxItem)((ComboBox)window.FindName("ProviderChoice")).SelectedItem).Tag as string != provider
                || ((TextBox)window.FindName("EndpointBox")).Text != endpoint || ((TextBox)window.FindName("ModelBox")).Text != model
                || ((PasswordBox)window.FindName("CredentialBox")).SecurePassword.Length != 0)
                throw new InvalidOperationException("Saved inference choices were not restored without their key.");
            if (((CheckBox)services.FindName("SearchEnabled")).IsChecked != true
                || ((ComboBoxItem)((ComboBox)services.FindName("SearchProvider")).SelectedItem).Tag as string != "tavily"
                || ((TextBox)services.FindName("TelegramUsers")).Text != "123456"
                || ((TextBox)services.FindName("SlackUsers")).Text != "U123456")
                throw new InvalidOperationException("Saved integration choices were not restored.");
            foreach (var name in new[] { "SearchKey", "TelegramKey", "SlackBotKey", "SlackAppKey" })
                if (((PasswordBox)services.FindName(name)).SecurePassword.Length != 0)
                    throw new InvalidOperationException("Saved choices restored an integration key.");
            try
            {
                services.GetType().GetMethod("CopyCredentials", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(services, null);
                throw new InvalidOperationException("Restored integrations bypassed required key re-entry.");
            }
            catch (TargetInvocationException error) when (error.InnerException is InvalidOperationException) { }
        }
        var valid = Saved("local", "http://127.0.0.1:12345/v1", "selected-model");
        foreach (var invalid in new[] { "null", "{", new string('x', 16385),
            valid.Replace("\"schemaVersion\":1", "\"schemaVersion\":1,\"schemaVersion\":1"),
            valid.Replace($"\"agent\":\"{agent}\"", $"\"agent\":\"{(agent == "openclaw" ? "hermes" : "openclaw")}\""),
            valid.Replace("selected-model", new string('x', 257)),
            valid.Replace("http://127.0.0.1:12345/v1", "https://user:private@example.invalid/v1"),
            valid.Replace("\"state\":\"saved\"", "\"state\":\"unconfigured\""),
            valid.Replace("\"options\":{", "\"secret\":\"must-not-return\",\"options\":{"),
        })
        {
            try { Read(invalid); throw new InvalidOperationException("Invalid saved settings were accepted."); }
            catch (TargetInvocationException error) when (error.InnerException is InvalidOperationException) { }
        }
        var modelType = typeof(MainWindow).Assembly.GetType("Nvidia.NemoClaw.Bootstrapper.NativeExpressSetup")!;
        var localModel = modelType.GetProperty("Id", BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null);
        var localName = modelType.GetProperty("Model", BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null);
        var managed = System.Text.Json.JsonSerializer.Serialize(new { schemaVersion = 1, kind = "native-saved-settings", agent, state = "saved",
            settings = new { inference = "local", model = localName, localModel, credentialStored = false, options = new { } } });
        Invoke(window, "ApplySavedSettings", Read(managed));
        var choice = (ComboBoxItem)((ComboBox)window.FindName("ProviderChoice")).SelectedItem;
        if (choice.IsEnabled || choice.Tag as string != "n1x")
            throw new InvalidOperationException("Unavailable saved models silently became an available provider.");
        Invoke(window, "AddModelChoice", new ComboBoxItem { Tag = "n1x", Content = "Fixture available model" });
        if (!choice.IsEnabled || ((ComboBox)window.FindName("ProviderChoice")).Items.OfType<ComboBoxItem>().Count(item => item.Tag as string == "n1x") != 1)
            throw new InvalidOperationException("Available model refresh did not restore the saved selection exactly once.");
        ((ComboBox)window.FindName("ProviderChoice")).SelectedIndex = 0;
        ((ComboBox)window.FindName("ProviderChoice")).Items.Remove(choice);
        Invoke(window, "ApplySavedSettings", Read(System.Text.Json.JsonSerializer.Serialize(new { schemaVersion = 1, kind = "native-saved-settings", agent, state = "needs-resave", settings = (object?)null })));
        if (((Border)window.FindName("ConfigurationErrorPanel")).Visibility != Visibility.Visible)
            throw new InvalidOperationException("Unfinished saves were silently treated as saved settings.");
    }

    private static void AssertSavedLoading(MainWindow window, string agent)
    {
        var empty = System.Text.Json.JsonSerializer.Serialize(new { schemaVersion = 1, kind = "native-saved-settings", agent, state = "unconfigured", settings = (object?)null });
        string SavedFor(string selected) => System.Text.Json.JsonSerializer.Serialize(new {
            schemaVersion = 1, kind = "native-saved-settings", agent = selected, state = "saved",
            settings = new { inference = "local", endpoint = "http://127.0.0.1:12345/v1", model = "loaded-model", credentialStored = false,
                options = new { messaging = new { telegram = new { credentialStored = true, allowedUsers = new[] { "123456" } } } } },
        });
        var saved = SavedFor(agent);
        var otherAgent = agent == "openclaw" ? "hermes" : "openclaw";
        Invoke(window, "AgentSelected", new RadioButton { Tag = agent }, new RoutedEventArgs());
        var availability = typeof(MainWindow).GetField("runtimeAvailability", BindingFlags.Instance | BindingFlags.NonPublic)!;
        var loader = typeof(MainWindow).GetField("readSavedSettings", BindingFlags.Instance | BindingFlags.NonPublic)!;
        var original = availability.GetValue(window);
        var originalLoader = loader.GetValue(window);
        var installed = typeof(MainWindow).GetField("packageInstalled", BindingFlags.Instance | BindingFlags.NonPublic)!;
        var originalInstalled = installed.GetValue(window);
        installed.SetValue(window, true);
        var record = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { schemaVersion = 1, classification = "native-runtime-package-availability",
            runtimeId = new string('a', 64), manifestSha256 = new string('b', 64), sourceRevision = new string('c', 40),
            agents = new[] { new {agent = "openclaw", status = "qualified"}, new {agent = "hermes", status = "qualified"} } });
        availability.SetValue(window, availability.FieldType.GetMethod("Parse", BindingFlags.Static | BindingFlags.NonPublic)!.Invoke(null, new object[] {record}));
        Invoke(window, "ApplyRuntimeAvailability");
        Invoke(window, "AgentSelected", new RadioButton { Tag = agent }, new RoutedEventArgs());
        var panel = (Grid)window.FindName("ConfigurationPanel");
        var install = (Button)window.FindName("InstallButton");
        ((CheckBox)window.FindName("LicenseCheck")).IsChecked = true;
        try
        {
            var response = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
            loader.SetValue(window, (Func<string, Task<string>>)(selected =>
            {
                if (selected != agent) throw new InvalidOperationException("Saved settings lookup selected another agent.");
                return response.Task;
            }));
            var loading = (Task)Invoke(window, "LoadSavedSettingsAsync")!;
            if (panel.IsEnabled || install.IsEnabled) throw new InvalidOperationException("Saving remained enabled before saved choices were confirmed.");
            response.SetResult(saved);
            Finish(loading);
            if (!panel.IsEnabled || !install.IsEnabled || ((TextBox)window.FindName("ModelBox")).Text != "loaded-model")
                throw new InvalidOperationException("Confirmed saved choices did not restore the editor.");
            var reloads = 0;
            loader.SetValue(window, (Func<string, Task<string>>)(selected => { reloads++; return Task.FromResult(SavedFor(selected)); }));
            Invoke(window, "AgentSelected", new RadioButton {Tag = otherAgent}, new RoutedEventArgs());
            Invoke(window, "ConfigureClicked", window, new RoutedEventArgs());
            Invoke(window, "AgentSelected", new RadioButton {Tag = agent}, new RoutedEventArgs());
            Invoke(window, "ConfigureClicked", window, new RoutedEventArgs());
            var services = (UserControl)window.FindName("ServiceOptions");
            if (reloads != 2 || ((CheckBox)services.FindName("TelegramEnabled")).IsChecked != true
                || ((TextBox)services.FindName("TelegramUsers")).Text != "123456")
                throw new InvalidOperationException("Returning to the selected agent reused a stale loaded flag after clearing integration choices.");
            loader.SetValue(window, (Func<string, Task<string>>)(_ => Task.FromException<string>(new IOException("fixture unavailable"))));
            Finish((Task)Invoke(window, "LoadSavedSettingsAsync")!);
            if (install.IsEnabled || ((TextBox)window.FindName("ModelBox")).Text != "loaded-model")
                throw new InvalidOperationException("Failed lookup authorized overwriting saved choices with defaults.");
            response = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
            loader.SetValue(window, (Func<string, Task<string>>)(_ => response.Task));
            loading = (Task)Invoke(window, "LoadSavedSettingsAsync")!;
            Invoke(window, "AgentSelected", new RadioButton {Tag = otherAgent}, new RoutedEventArgs());
            ((TextBox)window.FindName("ModelBox")).Text = "other-agent-draft";
            response.SetResult(saved);
            Finish(loading);
            if (window.SelectedAgent != otherAgent || ((TextBox)window.FindName("ModelBox")).Text != "other-agent-draft")
                throw new InvalidOperationException("A late settings lookup overwrote another agent's choices.");
            Invoke(window, "AgentSelected", new RadioButton {Tag = agent}, new RoutedEventArgs());
            loader.SetValue(window, (Func<string, Task<string>>)(_ => Task.FromResult(empty)));
            Finish((Task)Invoke(window, "LoadSavedSettingsAsync")!);
            AssertReplacementSetup(window, agent, loader, installed, Finish);
        }
        finally
        {
            availability.SetValue(window, original);
            loader.SetValue(window, originalLoader);
            installed.SetValue(window, originalInstalled);
            Invoke(window, "ApplyRuntimeAvailability");
            ((CheckBox)window.FindName("LicenseCheck")).IsChecked = false;
        }
        void Finish(Task operation)
        {
            var watch = System.Diagnostics.Stopwatch.StartNew();
            while (!operation.IsCompleted && watch.Elapsed < TimeSpan.FromSeconds(5))
                window.Dispatcher.Invoke(() => { }, DispatcherPriority.ApplicationIdle);
            if (!operation.IsCompleted) throw new TimeoutException("The saved-choice fixture did not finish.");
            operation.GetAwaiter().GetResult();
        }
    }

    private static void AssertReplacementSetup(MainWindow window, string agent, FieldInfo loader, FieldInfo installed, Action<Task> finish)
    {
        var saved = "{\"schemaVersion\":1,\"kind\":\"native-saved-settings\",\"agent\":\"" + agent + "\",\"state\":\"saved\",\"settings\":{\"inference\":\"nvidia\",\"endpoint\":\"https://integrate.api.nvidia.com/v1\",\"model\":\"saved-native-model\",\"credentialStored\":true,\"options\":{\"messaging\":{\"telegram\":{\"credentialStored\":true,\"allowedUsers\":[\"123456\"]}}}}}";
        var choice = (CheckBox)window.FindName("KeepSavedSetup");
        var fields = (StackPanel)window.FindName("ConfigurationFields");
        var license = (CheckBox)window.FindName("LicenseCheck");
        var key = (PasswordBox)window.FindName("CredentialBox");
        var resume = typeof(MainWindow).GetProperty("ResumeSavedSetup", BindingFlags.Instance | BindingFlags.NonPublic)!;
        var configuration = typeof(MainWindow).GetProperty("Configuration", BindingFlags.Instance | BindingFlags.NonPublic)!;
        var reads = 0;
        var installs = 0;
        var hintRoot = Path.Combine(Path.GetTempPath(), "NemoClawSavedSetupHint-" + Guid.NewGuid().ToString("N"));
        var hintFile = Path.Combine(hintRoot, "NVIDIA", "NemoClaw", "agents", agent, "native-windows.json");
        var hint = typeof(MainWindow).Assembly.GetType("Nvidia.NemoClaw.Bootstrapper.NativeSetupOperations")!
            .GetMethod("HasSavedSetup", BindingFlags.Static | BindingFlags.NonPublic)!;
        var otherAgent = agent == "openclaw" ? "hermes" : "openclaw";
        void SetAvailable(bool available) =>
            Invoke(window, "SetReplacementSetupAvailable", (object)(available ? new[] { agent } : Array.Empty<string>()));
        EventHandler requested = (_, _) => installs++;
        window.InstallRequested += requested;
        try
        {
            installed.SetValue(window, false);
            SetAvailable((bool)hint.Invoke(null, new object[] { agent, hintRoot })!);
            if (choice.Visibility != Visibility.Collapsed) throw new InvalidOperationException("Fresh setup offered replacement-only restore.");
            Directory.CreateDirectory(Path.GetDirectoryName(hintFile)!);
            File.WriteAllText(hintFile, "fixture metadata is deliberately not parsed before installation");
            using (var held = new FileStream(hintFile, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
            {
                SetAvailable((bool)hint.Invoke(null, new object[] { agent, hintRoot })!);
            }
            if (choice.Visibility != Visibility.Visible || choice.IsChecked != true || fields.Visibility != Visibility.Collapsed)
                throw new InvalidOperationException("Replacement did not offer existing setup without editable defaults.");
            if ((bool)hint.Invoke(null, new object[] { otherAgent, hintRoot })!)
                throw new InvalidOperationException("Saved setup hint crossed agent boundaries.");
            var expectedName = agent == "hermes" ? "Hermes Agent" : "OpenClaw";
            if (((TextBlock)choice.Content).Text != $"Keep my existing {expectedName} setup"
                || System.Windows.Automation.AutomationProperties.GetAutomationId(choice) != (agent == "hermes" ? "KeepSavedHermesSetup" : "KeepSavedOpenClawSetup"))
                throw new InvalidOperationException("Saved setup choice identifies the wrong agent.");
            Invoke(window, "ConfigureClicked", window, new RoutedEventArgs());
            var evidence = Environment.GetEnvironmentVariable("NEMOCLAW_SETUP_PRESENTATION_EVIDENCE");
            if (!string.IsNullOrWhiteSpace(evidence))
            {
                var output = Path.GetFullPath(evidence + (agent == "openclaw" ? "-replacement" : "-replacement-hermes"));
                if (Directory.Exists(output) || File.Exists(output)) throw new InvalidOperationException("Replacement frames require a fresh directory.");
                Directory.CreateDirectory(output);
                var root = (FrameworkElement)window.Content;
                foreach (var size in new[] { new Size(1080, 740), new Size(860, 600), new Size(640, 480) })
                {
                    window.MinWidth = 640;
                    window.MinHeight = 480;
                    window.Width = size.Width;
                    window.Height = size.Height;
                    window.UpdateLayout();
                    window.Dispatcher.Invoke(() => { }, DispatcherPriority.ApplicationIdle);
                    foreach (var control in new FrameworkElement[] { choice, license, (Button)window.FindName("InstallButton") })
                        if (!control.IsVisible || !new Rect(root.RenderSize).Contains(control.TransformToAncestor(root).TransformBounds(new Rect(control.RenderSize))))
                            throw new InvalidOperationException("Replacement setup hides a required control.");
                    var bitmap = new RenderTargetBitmap((int)root.ActualWidth, (int)root.ActualHeight, 96, 96, PixelFormats.Pbgra32);
                    bitmap.Render(root);
                    var pixels = new byte[bitmap.PixelWidth * bitmap.PixelHeight * 4];
                    bitmap.CopyPixels(pixels, bitmap.PixelWidth * 4, 0);
                    if (!HasRenderedContent(pixels, bitmap.PixelWidth, bitmap.PixelHeight)) throw new InvalidOperationException("Replacement frame is blank.");
                    var encoder = new PngBitmapEncoder();
                    encoder.Frames.Add(BitmapFrame.Create(bitmap));
                    using var image = new FileStream(Path.Combine(output, $"keep-setup-{size.Width}x{size.Height}.png"), FileMode.CreateNew);
                    encoder.Save(image);
                }
                window.Width = 1080;
                window.Height = 740;
            }
            choice.IsChecked = false;
            if (fields.Visibility != Visibility.Visible) throw new InvalidOperationException("Replacement prevented choosing new settings.");
            choice.IsChecked = true;
            Invoke(window, "AgentSelected", new RadioButton { Tag = otherAgent }, new RoutedEventArgs());
            Invoke(window, "ConfigureClicked", window, new RoutedEventArgs());
            if (choice.Visibility != Visibility.Collapsed || fields.Visibility != Visibility.Visible)
                throw new InvalidOperationException("Replacement changed another agent's onboarding.");
            Invoke(window, "AgentSelected", new RadioButton { Tag = agent }, new RoutedEventArgs());
            Invoke(window, "ConfigureClicked", window, new RoutedEventArgs());
            license.IsChecked = false;
            Invoke(window, "InstallClicked", window, new RoutedEventArgs());
            if (installs != 0) throw new InvalidOperationException("Restore bypassed license acceptance.");
            license.IsChecked = true;
            key.Password = "fixture-only-unused-key";
            loader.SetValue(window, (Func<string, Task<string>>)(requestedAgent =>
            {
                if (requestedAgent != agent) throw new InvalidOperationException("Restore read another agent's settings.");
                reads++;
                return Task.FromResult(saved);
            }));
            Invoke(window, "InstallClicked", window, new RoutedEventArgs());
            if (installs != 1 || reads != 0 || resume.GetValue(window) is not true
                || configuration.GetValue(window) is not null || key.SecurePassword.Length != 0)
                throw new InvalidOperationException("Replacement read the old helper or retained a new credential before installation.");
            var beforeInstallRejected = false;
            try { finish((Task)Invoke(window, "RestoreSavedSetupAsync")!); }
            catch (InvalidOperationException error) when (error.Message.Contains("before installation", StringComparison.Ordinal)) { beforeInstallRejected = true; }
            if (!beforeInstallRejected || reads != 0) throw new InvalidOperationException("Pre-install restore touched the old launcher.");
            installed.SetValue(window, true);
            finish((Task)Invoke(window, "RestoreSavedSetupAsync")!);
            if (reads != 1 || resume.GetValue(window) is not false || configuration.GetValue(window) is null
                || ((TextBox)window.FindName("ModelBox")).Text != "saved-native-model"
                || key.SecurePassword.Length != 0 || choice.Visibility != Visibility.Collapsed)
                throw new InvalidOperationException("Installed replacement did not restore metadata without reentering credentials.");
            var services = (UserControl)window.FindName("ServiceOptions");
            if (((TextBox)services.FindName("TelegramUsers")).Text != "123456"
                || ((PasswordBox)services.FindName("TelegramKey")).SecurePassword.Length != 0)
                throw new InvalidOperationException("Restore lost integration choices or exposed a saved service key.");
            foreach (var state in new[] { "unconfigured", "needs-resave" })
            {
                installed.SetValue(window, false);
                SetAvailable(true);
                Invoke(window, "InstallClicked", window, new RoutedEventArgs());
                installed.SetValue(window, true);
                loader.SetValue(window, (Func<string, Task<string>>)(_ => Task.FromResult(
                    "{\"schemaVersion\":1,\"kind\":\"native-saved-settings\",\"agent\":\"" + agent + "\",\"state\":\"" + state + "\",\"settings\":null}")));
                var rejected = false;
                try { finish((Task)Invoke(window, "RestoreSavedSetupAsync")!); }
                catch (InvalidOperationException) { rejected = true; }
                if (!rejected || configuration.GetValue(window) is not null || resume.GetValue(window) is not false)
                    throw new InvalidOperationException("Absent or unfinished saved setup was accepted.");
                window.ShowConfigurationFailure("Fixture requires configuration.");
                if (fields.Visibility != Visibility.Visible || choice.Visibility != Visibility.Collapsed)
                    throw new InvalidOperationException("Failed restore did not return to normal onboarding.");
            }
            installed.SetValue(window, false);
            SetAvailable(true);
            Invoke(window, "InstallClicked", window, new RoutedEventArgs());
            installed.SetValue(window, true);
            loader.SetValue(window, (Func<string, Task<string>>)(_ => Task.FromException<string>(new IOException("fixture read failure"))));
            var failedRead = false;
            try { finish((Task)Invoke(window, "RestoreSavedSetupAsync")!); }
            catch (IOException) { failedRead = true; }
            window.ShowConfigurationFailure("Saved setup could not be read.");
            if (!failedRead || ((Button)window.FindName("InstallButton")).IsEnabled || configuration.GetValue(window) is not null)
                throw new InvalidOperationException("A failed restore read allowed overwriting settings with defaults.");
            loader.SetValue(window, (Func<string, Task<string>>)(_ => Task.FromResult(saved)));
            finish((Task)Invoke(window, "LoadSavedSettingsAsync")!);
            if (!((Button)window.FindName("InstallButton")).IsEnabled)
                throw new InvalidOperationException("A successful status retry did not recover normal configuration.");

            var modelType = typeof(MainWindow).Assembly.GetType("Nvidia.NemoClaw.Bootstrapper.NativeExpressSetup")!;
            var unavailable = System.Text.Json.JsonSerializer.Serialize(new { schemaVersion = 1, kind = "native-saved-settings", agent, state = "saved",
                settings = new { inference = "local", model = modelType.GetProperty("Model", BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null),
                    localModel = modelType.GetProperty("Id", BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null), credentialStored = false, options = new { } } });
            installed.SetValue(window, false);
            SetAvailable(true);
            Invoke(window, "InstallClicked", window, new RoutedEventArgs());
            installed.SetValue(window, true);
            loader.SetValue(window, (Func<string, Task<string>>)(_ => Task.FromResult(unavailable)));
            var modelRejected = false;
            try { finish((Task)Invoke(window, "RestoreSavedSetupAsync")!); }
            catch (InvalidOperationException) { modelRejected = true; }
            if (!modelRejected || configuration.GetValue(window) is not null)
                throw new InvalidOperationException("Restore admitted a local model unavailable in this package.");
            window.ShowConfigurationFailure("Saved model is unavailable.");
        }
        finally
        {
            window.InstallRequested -= requested;
            SetAvailable(false);
            if (Directory.Exists(hintRoot)) Directory.Delete(hintRoot, true);
        }
    }

    private static void AssertPresentationLayout(MainWindow window)
    {
        var output = Environment.GetEnvironmentVariable("NEMOCLAW_SETUP_PRESENTATION_EVIDENCE");
        if (!string.IsNullOrWhiteSpace(output))
        {
            output = Path.GetFullPath(output);
            if (Directory.Exists(output) || File.Exists(output))
                throw new InvalidOperationException("Setup presentation evidence must use a fresh directory.");
            Directory.CreateDirectory(output);
        }
        var root = (FrameworkElement)window.Content;
        foreach (var size in new[] { new Size(1080, 740), new Size(860, 600), new Size(640, 480) })
        {
            window.MinWidth = 640;
            window.MinHeight = 480;
            window.Width = size.Width;
            window.Height = size.Height;
            window.ShowConfiguredSuccess();
            Capture("saved-settings", (Button)window.FindName("CloseButton"));
            window.ShowFailure("The runtime could not start. Your saved provider, endpoint and model choices have not changed. Review the setup log, then retry after the runtime is repaired.", "");
            Capture("startup-failure", (Button)window.FindName("FailureCloseButton"));
            if (Invoke(window, "TryBeginConfiguration") is not true)
                throw new InvalidOperationException("The presentation fixture rejected its save observation.");
            Invoke(window, "ShowConfigurationUnconfirmed", Environment.ProcessId);
            Capture("save-recovery", (Button)window.FindName("ConfigurationRecoveryButton"));
            Invoke(window, "CompleteConfigurationObservation");

            void Capture(string scene, Button requiredAction)
            {
                window.UpdateLayout();
                window.Dispatcher.Invoke(() => { }, DispatcherPriority.ApplicationIdle);
                if (!requiredAction.IsVisible)
                    throw new InvalidOperationException($"Setup {scene} has no visible completion/recovery action.");
                var actions = ((Panel)requiredAction.Parent).Children.OfType<Button>().Where(value => value.IsVisible).ToArray();
                var actionBounds = actions.Select(value => value.TransformToAncestor(root).TransformBounds(new Rect(value.RenderSize))).ToArray();
                foreach (var bounds in actionBounds)
                {
                    if (!new Rect(root.RenderSize).Contains(bounds))
                        throw new InvalidOperationException($"Setup {scene} hides its completion/recovery action at {size.Width}x{size.Height}.");
                }
                for (var first = 0; first < actionBounds.Length; first++)
                    for (var second = first + 1; second < actionBounds.Length; second++)
                    {
                        var overlap = Rect.Intersect(actionBounds[first], actionBounds[second]);
                        if (!overlap.IsEmpty && overlap.Width > 0 && overlap.Height > 0)
                            throw new InvalidOperationException($"Setup {scene} overlaps its actions at {size.Width}x{size.Height}.");
                    }
                // Bitmap capture is optional; action visibility and geometry always run.
                if (string.IsNullOrWhiteSpace(output)) return;
                var bitmap = new RenderTargetBitmap((int)root.ActualWidth, (int)root.ActualHeight, 96, 96, PixelFormats.Pbgra32);
                var visual = new DrawingVisual();
                using (var drawing = visual.RenderOpen())
                    drawing.DrawRectangle(new VisualBrush(root), null, new Rect(root.RenderSize));
                bitmap.Render(visual);
                var pixels = new byte[bitmap.PixelWidth * bitmap.PixelHeight * 4];
                bitmap.CopyPixels(pixels, bitmap.PixelWidth * 4, 0);
                if (!HasRenderedContent(pixels, bitmap.PixelWidth, bitmap.PixelHeight))
                {
                    var control = new DrawingVisual();
                    using (var drawing = control.RenderOpen()) drawing.DrawRectangle(Brushes.White, null, new Rect(0, 0, 64, 64));
                    var controlBitmap = new RenderTargetBitmap(64, 64, 96, 96, PixelFormats.Pbgra32);
                    controlBitmap.Render(control);
                    var controlPixels = new byte[64 * 64 * 4];
                    controlBitmap.CopyPixels(controlPixels, 64 * 4, 0);
                    var controlOpaque = controlPixels.Where((value, index) => index % 4 == 3 && value != 0).Count();
                    throw new InvalidOperationException($"Setup presentation capture was blank; independent opaque drawing pixels={controlOpaque}.");
                }
                var encoder = new PngBitmapEncoder();
                encoder.Frames.Add(BitmapFrame.Create(bitmap));
                using (var image = new FileStream(Path.Combine(output, $"{scene}-{size.Width}x{size.Height}.png"), FileMode.CreateNew))
                    encoder.Save(image);
                File.WriteAllText(Path.Combine(output, $"{scene}-{size.Width}x{size.Height}.json"),
                    System.Text.Json.JsonSerializer.Serialize(new
                    {
                        schemaVersion = 1, classification = "owned-wpf-component-presentation-frame", captureMethod = "wpf-render-target",
                        scene, requestedWidth = size.Width, requestedHeight = size.Height,
                        pixelWidth = bitmap.PixelWidth, pixelHeight = bitmap.PixelHeight,
                        componentFixture = true, installedAcceptance = false,
                    }));
            }
        }
        window.Width = 1080;
        window.Height = 740;
        window.ShowReady(false);
    }

    internal static void Run()
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            MainWindow? window = null;
            var closed = false;
            var cancelRequests = 0;
            try
            {
                SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(Dispatcher.CurrentDispatcher));
                AssertPixelGuard();
                if (!string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("NEMOCLAW_SETUP_PRESENTATION_EVIDENCE")))
                    RenderOptions.ProcessRenderMode = System.Windows.Interop.RenderMode.SoftwareOnly;
                AssertUpgradePresentation();
                AssertSupersededBundleCallbacks();
                AssertCancellationPresentation();
                AssertOnboardingAdmission();
                AssertRemovalChoices();
                window = new MainWindow();
                AssertCompletionPresentation(window);
                AssertProviderChoices(window);
                AssertSavedOutputBounds();
                AssertSavedChoices(window, "openclaw");
                AssertSavedChoices(window, "hermes");
                window.Closed += (_, _) => closed = true;
                window.ModelSetupCancelRequested += (_, _) => cancelRequests++;
                window.Show();
                AssertSavedLoading(window, "openclaw");
                AssertSavedLoading(window, "hermes");
                AssertPresentationLayout(window);
                AssertLiveHelperRecovery(window);
                if (Invoke(window, "TryBeginConfiguration") is not true)
                    throw new InvalidOperationException("Setup rejected the fixture save.");
                Invoke(window, "ShowConfigurationUnconfirmed", Environment.ProcessId);
                window.Close();
                if (closed || !window.IsVisible || !window.ShowInTaskbar || window.WindowState != WindowState.Minimized)
                    throw new InvalidOperationException("Closing unconfirmed Setup removed its taskbar recovery window.");
                window.WindowState = WindowState.Normal;
                var recovery = window.FindName("ConfigurationRecoveryButton") as Button;
                if (!window.IsVisible || recovery is null || !recovery.IsVisible || !recovery.IsEnabled)
                    throw new InvalidOperationException("Restoring Setup did not restore its save-status control.");
                if (Invoke(window, "TryBeginConfiguration") is not false || cancelRequests != 1)
                    throw new InvalidOperationException("Closing recovery admitted a second save or lost model cancellation.");
                Invoke(window, "CompleteConfigurationObservation");
                if (!closed)
                    throw new InvalidOperationException("Setup ignored the close request after its owner completed.");
            }
            catch (Exception error) { failure = error; }
            finally
            {
                try
                {
                    if (window is not null && !closed)
                    {
                        Invoke(window, "CompleteConfigurationObservation");
                        if (!closed)
                        {
                            window.ShowConfiguredSuccess();
                            window.Close();
                        }
                    }
                }
                catch (Exception error) { failure ??= error; }
                finally { Dispatcher.CurrentDispatcher.InvokeShutdown(); }
            }
        });
        thread.IsBackground = true;
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        if (!thread.Join(TimeSpan.FromSeconds(30)))
            throw new TimeoutException("The Setup recovery window control did not finish.");
        if (failure is not null) throw new InvalidOperationException("Setup recovery window control failed.", failure);
        Console.WriteLine("Windows Setup restores saved choices without keys, bounds metadata, preserves provider drafts and agent boundaries; recovery remains accessible until its owner completes.");
    }
}
#endif
