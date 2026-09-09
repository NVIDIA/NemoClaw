// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Automation;
using System.Windows.Threading;

namespace Nvidia.NemoClaw.Bootstrapper;

// The backend owns the sandbox and its cleanup. Browser processes may be reused
// by Windows, so this private pipe is the explicit session lifetime boundary.
internal static class NativeWebSession
{
    internal static int Run(string agent)
    {
        if (agent is not ("openclaw" or "hermes")) return 2;
        using var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false, true));
        using var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
        string? url;
        bool qualification;
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            using var record = JsonDocument.Parse(ReadLineAsync(input, timeout.Token).GetAwaiter().GetResult());
            var root = record.RootElement;
            qualification = root.TryGetProperty("qualification", out var test) && test.ValueKind == JsonValueKind.True;
            url = root.TryGetProperty("url", out var submittedUrl) ? submittedUrl.GetString() : null;
            if (root.GetProperty("schemaVersion").GetInt32() != 1 || root.GetProperty("agent").GetString() != agent ||
                (url is not null && !ValidAddress(url))) return 2;
        }
        catch (Exception) { return 2; }
        var result = 1;
        var thread = new Thread(() =>
        {
            using var shutdown = new CancellationTokenSource();
            var stopped = false;
            var stopRequested = false;
            string? diagnosticPath = null;
            var content = new StackPanel { Margin = new Thickness(24) };
            var status = new TextBlock { Text = url is null ? "Preparing your private agent session…" : "Your agent is running. Use Stop session when you have finished.", TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 12, 0, 20) };
            AutomationProperties.SetAutomationId(status, "NativeWebSessionStatus");
            var open = new Button { Content = "Open Web UI", Height = 38, Margin = new Thickness(0, 0, 0, 10), IsEnabled = url is not null };
            var stop = new Button { Content = "Stop session", Height = 38 };
            AutomationProperties.SetAutomationId(stop, "NativeWebSessionStop");
            AutomationProperties.SetAutomationId(open, "NativeWebSessionOpen");
            var heading = new TextBlock { Text = NativeDesktopIntegration.AgentName(agent), FontSize = 22 };
            content.Children.Add(heading);
            content.Children.Add(status); content.Children.Add(open); content.Children.Add(stop);
            var window = new Window { Title = $"NemoClaw {NativeDesktopIntegration.AgentName(agent)} session", Width = 430, Height = 265,
                ResizeMode = ResizeMode.NoResize, WindowStartupLocation = WindowStartupLocation.CenterScreen, Content = content };
            void RequestStop()
            {
                if (stopRequested || stopped) return;
                stopRequested = true;
                open.IsEnabled = false; stop.IsEnabled = false;
                status.Text = "Stopping your agent and closing its private session…";
                // Hermes may need 45 seconds before the remaining sandbox and
                // state cleanup. Keep the wait bounded without cutting it short.
                shutdown.CancelAfter(TimeSpan.FromMinutes(2));
                try { output.WriteLine("{\"kind\":\"stop\"}"); }
                catch (IOException) { stopped = true; window.Close(); }
            }
            void OpenBrowser()
            {
                if (diagnosticPath is not null)
                {
                    try
                    {
                        var start = new ProcessStartInfo { FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "notepad.exe"), UseShellExecute = false };
                        start.ArgumentList.Add(diagnosticPath);
                        Process.Start(start)?.Dispose();
                    }
                    catch (Exception) { status.Text += " Open the diagnostic file from the displayed path."; }
                    return;
                }
                if (url is null || stopRequested) return;
                try { Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true })?.Dispose(); }
                catch (Exception) { status.Text = "Windows could not open your default browser. Try Open Web UI again, or stop this session."; }
            }
            open.Click += (_, _) => OpenBrowser();
            stop.Click += (_, _) => { if (stopped) window.Close(); else RequestStop(); };
            window.Closing += (_, args) => { if (!stopped) { args.Cancel = true; RequestStop(); } };
            window.Closed += (_, _) => { shutdown.Cancel(); Dispatcher.CurrentDispatcher.InvokeShutdown(); };
            window.Loaded += async (_, _) =>
            {
                var showShutdownFailure = false;
                var showStartupFailure = false;
                try
                {
                    output.WriteLine("{\"kind\":\"ready\"}");
                    if (!qualification) OpenBrowser();
                    while (true)
                    {
                        using var message = JsonDocument.Parse(await ReadLineAsync(input, shutdown.Token).WaitAsync(shutdown.Token));
                        var record = message.RootElement;
                        var kind = record.GetProperty("kind").GetString();
                        if (kind is "stopped" or "failed")
                        {
                            result = kind == "stopped" ? 0 : 1;
                            if (kind == "failed")
                            {
                                showStartupFailure = true;
                                heading.Text = $"{NativeDesktopIntegration.AgentName(agent)} could not finish";
                                var detail = record.TryGetProperty("message", out var failureMessage) ? failureMessage.GetString() : null;
                                status.Text = detail is not null && detail.Length <= 2048 ? detail : "The private agent session failed. Open NemoClaw Setup to check its settings.";
                                var log = record.TryGetProperty("diagnosticPath", out var failurePath) ? failurePath.GetString() : null;
                                diagnosticPath = ValidDiagnosticPath(log, agent) ? log : null;
                                open.Content = "Open diagnostics";
                                open.IsEnabled = diagnosticPath is not null;
                                window.Height = Math.Max(window.Height, 360);
                            }
                            break;
                        }
                        if (kind == "ready" && url is null)
                        {
                            var address = record.GetProperty("url").GetString() ?? string.Empty;
                            if (!ValidAddress(address)) throw new InvalidDataException();
                            url = address;
                            if (!stopRequested)
                            {
                                heading.Text = $"{NativeDesktopIntegration.AgentName(agent)} is ready";
                                status.Text = "Your agent is running. Use Stop session when you have finished.";
                                open.IsEnabled = true; if (!qualification) OpenBrowser();
                            }
                        }
                        else if (kind == "progress" && !stopRequested)
                            status.Text = record.GetProperty("stage").GetString() switch
                            {
                                "inference" => "Preparing your selected inference connection…",
                                "runtime" => "Preparing the installed agent runtime…",
                                "sandbox" => "Starting the private agent session…",
                                "bootstrap" => "Connecting the private session to its local model broker…",
                                "dashboard" => "Opening the agent's Web UI…",
                                _ => throw new InvalidDataException(),
                            };
                        else if (kind != "progress") throw new InvalidDataException();
                    }
                }
                catch (OperationCanceledException) when (stopRequested)
                {
                    result = 1;
                    showShutdownFailure = true;
                    status.Text = "The agent did not confirm shutdown within two minutes. Cleanup may still be running. Close this window and check the agent session before starting it again.";
                    window.Height = Math.Max(window.Height, 340);
                }
                catch (Exception) { result = 1; }
                finally
                {
                    stopped = true;
                    if (showShutdownFailure || showStartupFailure) { stop.Content = "Close"; stop.IsEnabled = true; }
                    else window.Close();
                }
            };
            window.Show();
            Dispatcher.Run();
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start(); thread.Join();
        return result;
    }

    private static bool ValidAddress(string url) => url.Length <= 1600 && Uri.TryCreate(url, UriKind.Absolute, out var uri) &&
        uri.Scheme == "http" && uri.Host == "127.0.0.1" && uri.Port > 0 && string.IsNullOrEmpty(uri.UserInfo);

    private static bool ValidDiagnosticPath(string? file, string agent)
    {
        if (file is null || file.Length > 1600) return false;
        try
        {
            var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "NVIDIA", "NemoClaw", "agents", agent);
            var full = Path.GetFullPath(file);
            var parent = Path.GetDirectoryName(full);
            return Path.GetFileName(full) == "ready" && parent is not null &&
                string.Equals(Path.GetDirectoryName(parent), root, StringComparison.OrdinalIgnoreCase) &&
                System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(parent), "^session-diagnostics-[a-f0-9]{20}$") &&
                File.Exists(full);
        }
        catch (Exception) { return false; }
    }

    private static async Task<string> ReadLineAsync(StreamReader input, CancellationToken cancellation)
    {
        var text = new StringBuilder();
        var character = new char[1];
        while (text.Length < 4096)
        {
            if (await input.ReadAsync(character.AsMemory(), cancellation) == 0) throw new EndOfStreamException();
            if (character[0] == '\n') return text.ToString();
            if (character[0] == '\r') continue;
            text.Append(character[0]);
        }
        throw new InvalidDataException("The native session message is too long.");
    }
}
