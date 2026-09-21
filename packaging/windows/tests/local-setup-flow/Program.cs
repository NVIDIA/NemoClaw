// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using Nvidia.NemoClaw.Bootstrapper;

internal static class Program
{
    [STAThread]
    private static int Main(string[] arguments)
    {
        if (arguments.Length != 1 || !Path.IsPathFullyQualified(arguments[0])) return 2;
        var passed = new List<string>();
        try
        {
            if (!Environment.UserInteractive || Process.GetCurrentProcess().SessionId == 0)
                throw new InvalidOperationException("Run these WPF controls in an interactive desktop session.");
            _ = new Application();
            var eligibility = NativeExpressSetup.CheckPreliminaryEligibilityAsync(download: true).GetAwaiter().GetResult();
            if (eligibility.IsDevice)
            {
                if (!eligibility.Eligible || eligibility.DriverVersion is null || eligibility.CudaVersion is null)
                    throw new InvalidOperationException("The live N1X preflight did not expose its compatible driver and CUDA status.");
                passed.Add("live N1X driver, CUDA, memory, and storage preflight");
            }
            foreach (var model in new[] { "qwen3.8-27b", "qwen3.6-35b-a3b" })
            {
                Check(model, "openclaw", true, false);
                Check(model, "openclaw", false, true);
                Check(model, "hermes", false, false);
            }
            Check("local", "openclaw", false, false);
            Check("compatible", "openclaw", false, false);
            File.WriteAllText(arguments[0], JsonSerializer.Serialize(new {
                passed = passed.Count, failed = 0, controls = passed,
                sessionId = Process.GetCurrentProcess().SessionId,
                installerExecuted = false, downloadExecuted = false, agentStarted = false
            }));
            return 0;
        }
        catch (Exception error)
        {
            File.WriteAllText(arguments[0], JsonSerializer.Serialize(new { passed = passed.Count, failed = 1, error = error.ToString() }));
            return 1;
        }

        void Check(string provider, string agent, bool autoLaunch, bool fail)
        {
            var window = new MainWindow();
            try
            {
                T Find<T>(string name) where T : class => window.FindName(name) as T ?? throw new InvalidOperationException(name);
                void Require(bool value) { if (!value) throw new InvalidOperationException($"Flow assertion failed: {provider}, {agent}, failure={fail}."); }
                window.ShowReady(false);
                Find<RadioButton>(agent == "hermes" ? "HermesChoice" : "OpenClawChoice").IsChecked = true;
                var providers = Find<ComboBox>("ProviderChoice");
                var choice = providers.Items.OfType<ComboBoxItem>().FirstOrDefault(item => (string)item.Tag == provider);
                var bundled = provider.StartsWith("qwen", StringComparison.Ordinal);
                // Simulate availability only in this UI fixture. Production device admission is unchanged.
                if (choice is null) { choice = new ComboBoxItem { Tag = provider, Content = provider }; providers.Items.Add(choice); }
                providers.SelectedItem = choice;
                Require(Find<TextBlock>("EndpointHelp").Visibility == (bundled ? Visibility.Collapsed : Visibility.Visible));
                Require(Find<TextBlock>("CredentialHelp").Visibility == (bundled ? Visibility.Collapsed : Visibility.Visible));
                Require(Find<TextBox>("ModelBox").Visibility == (bundled ? Visibility.Collapsed : Visibility.Visible));
                Require((string)Find<Button>("InstallButton").Content == (bundled && agent == "openclaw" ? "Set up for me" : "Install NemoClaw"));
                if (bundled)
                {
                    Require(Find<TextBlock>("ModelDownloadNotice").Text.Contains("No endpoint, model ID, or API key", StringComparison.Ordinal));
                    var summary = Find<TextBlock>("LocalSetupSummary").Text;
                    Require(summary.Contains("Reasoning off", StringComparison.Ordinal) && summary.Contains("Reasoning on", StringComparison.Ordinal));
                }
                if (!bundled) { Find<TextBox>("ModelBox").Text = "fixture-model"; Find<TextBox>("EndpointBox").Text = provider == "local" ? "http://127.0.0.1:8000/v1" : "https://example.invalid/v1"; }
                var installs = 0;
                var launches = 0;
                window.InstallRequested += (_, _) => installs++;
                window.LaunchRequested += (_, _) => launches++;
                Find<Button>("InstallButton").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                Require(installs == 0 && launches == 0);
                Find<CheckBox>("LicenseCheck").IsChecked = true;
                Find<Button>("InstallButton").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                Require(installs == 1 && launches == 0);
                window.ShowConfiguring();
                Require(launches == 0);
                if (fail)
                {
                    window.ShowConfigurationFailure("Fixture download failure or cancellation; no configuration was saved.");
                    Require(launches == 0);
                }
                else
                {
                    window.ShowConfiguredSuccess();
                    Require(launches == (autoLaunch ? 1 : 0));
                    if (bundled) Require(Find<TextBlock>("SuccessDetail").Text.Contains("Reasoning off", StringComparison.Ordinal));
                    window.ShowConfiguredSuccess();
                    Require(launches == (autoLaunch ? 1 : 0));
                }
                passed.Add($"{provider}/{agent}: consent, visibility, {(fail ? "failure refuses launch" : "successful completion launches at most once")}");
            }
            finally { window.ShowReady(false); window.Close(); }
        }
    }
}
