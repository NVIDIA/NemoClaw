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
using System.Windows.Media;
using System.Windows.Media.Animation;
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
            var progress = new NativeProgressPresentation();
            var green = new SolidColorBrush(Color.FromRgb(0x76, 0xB9, 0x00));
            var muted = new SolidColorBrush(Color.FromRgb(0xAF, 0xB8, 0xA9));
            var content = new StackPanel { Margin = new Thickness(26) };
            content.Children.Add(new TextBlock { Text = "NVIDIA / NEMOCLAW", Foreground = green, FontSize = 11, FontWeight = FontWeights.Bold });
            var heading = new TextBlock { Text = NativeDesktopIntegration.AgentName(agent), FontSize = 26, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 10, 0, 4) };
            var phase = new TextBlock { Text = "Preparing your session", FontSize = 17, FontWeight = FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap };
            AutomationProperties.SetAutomationId(phase, "NativeWebSessionPhase");
            var status = new TextBlock { Text = "Preparing your private agent session. The browser opens after the agent's interface becomes available.", Foreground = muted, FontSize = 13, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 10, 0, 16) };
            AutomationProperties.SetAutomationId(status, "NativeWebSessionStatus");
            var count = new TextBlock { Text = "Working…", HorizontalAlignment = HorizontalAlignment.Right, FontWeight = FontWeights.SemiBold };
            AutomationProperties.SetAutomationId(count, "NativeWebSessionProgressCount");
            var bar = new ProgressBar { Height = 7, Minimum = 0, Maximum = 100, IsIndeterminate = true, Foreground = green, Background = new SolidColorBrush(Color.FromRgb(0x32, 0x39, 0x2B)), Margin = new Thickness(0, 8, 0, 12) };
            var activityDot = new Border { Width = 7, Height = 7, CornerRadius = new CornerRadius(4), Background = green, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 4, 9, 0) };
            var activity = new TextBlock { Foreground = muted, FontSize = 11, TextWrapping = TextWrapping.Wrap };
            AutomationProperties.SetAutomationId(activity, "NativeWebSessionActivity");
            var activityRow = new DockPanel();
            activityRow.Children.Add(activityDot); activityRow.Children.Add(activity);
            var capabilities = new TextBlock { Text = "Search is configured separately from inference. Check agent Setup for its search services.", Foreground = muted, FontSize = 12, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 16, 0, 18) };
            AutomationProperties.SetAutomationId(capabilities, "NativeWebSessionCapabilities");
            var open = new Button { Content = "Open Web UI", Height = 40, Margin = new Thickness(0, 0, 0, 10), IsEnabled = url is not null };
            var stop = new Button { Content = "Stop session", Height = 40 };
            foreach (var button in new[] { open, stop })
            {
                button.Background = new SolidColorBrush(Color.FromRgb(0x25, 0x31, 0x1E));
                button.Foreground = Brushes.WhiteSmoke;
                button.BorderBrush = green;
                button.BorderThickness = new Thickness(1);
            }
            AutomationProperties.SetAutomationId(stop, "NativeWebSessionStop");
            AutomationProperties.SetAutomationId(open, "NativeWebSessionOpen");
            content.Children.Add(heading); content.Children.Add(phase); content.Children.Add(status);
            content.Children.Add(count); content.Children.Add(bar); content.Children.Add(activityRow);
            content.Children.Add(capabilities);
            var layout = new Grid();
            layout.RowDefinitions.Add(new RowDefinition());
            layout.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            var scroll = new ScrollViewer { Content = content, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
            layout.Children.Add(scroll);
            var actions = new StackPanel { Margin = new Thickness(26, 0, 26, 22) };
            actions.Children.Add(open); actions.Children.Add(stop); Grid.SetRow(actions, 1); layout.Children.Add(actions);
            var window = new Window { Title = $"NemoClaw {NativeDesktopIntegration.AgentName(agent)} session", Width = 550, Height = 530,
                ResizeMode = ResizeMode.NoResize, WindowStartupLocation = WindowStartupLocation.CenterScreen, Content = layout,
                Background = new SolidColorBrush(Color.FromRgb(0x10, 0x12, 0x10)), Foreground = Brushes.WhiteSmoke };
            double? displayed = null;
            void Render()
            {
                var active = !stopped && (url is null || stopRequested || progress.Phase == "cleanup");
                var measurement = active ? progress.Measurement : null;
                count.Text = active ? measurement?.Label ?? "Working…" : "Web UI available";
                bar.Visibility = active ? Visibility.Visible : Visibility.Collapsed;
                count.Visibility = stopped ? Visibility.Collapsed : Visibility.Visible;
                bar.IsIndeterminate = measurement is null;
                if (measurement is not null && displayed != measurement.Percentage)
                {
                    if (measurement.Percentage < bar.Value)
                    {
                        bar.BeginAnimation(System.Windows.Controls.Primitives.RangeBase.ValueProperty, null);
                        bar.Value = measurement.Percentage;
                    }
                    else bar.BeginAnimation(System.Windows.Controls.Primitives.RangeBase.ValueProperty,
                        new DoubleAnimation(bar.Value, measurement.Percentage, TimeSpan.FromMilliseconds(200))
                        { EasingFunction = new QuadraticEase { EasingMode = EasingMode.EaseOut } }, HandoffBehavior.SnapshotAndReplace);
                    displayed = measurement.Percentage;
                }
                else if (measurement is null && displayed is not null)
                {
                    bar.BeginAnimation(System.Windows.Controls.Primitives.RangeBase.ValueProperty, null);
                    bar.Value = 0; displayed = null;
                }
                activityDot.Opacity = active ? progress.ActivityOpacity : 1;
                activityRow.Visibility = NativePreviewPresentation.DiagnosticsEnabled ? Visibility.Visible : Visibility.Collapsed;
                activity.Text = (active ? progress.ActivityText + "\n" : stopped ? "Session finished · " : "Session open · ") +
                    $"Total elapsed {NativeProgressPresentation.Duration(progress.SessionElapsed)}";
            }
            progress.Report(url is null ? "inference" : "running");
            var timer = new DispatcherTimer(TimeSpan.FromMilliseconds(100), DispatcherPriority.Background, (_, _) => Render(), window.Dispatcher);
            void RequestStop()
            {
                if (stopRequested || stopped) return;
                stopRequested = true;
                open.IsEnabled = false; stop.IsEnabled = false;
                progress.Report("cleanup");
                phase.Text = "Closing the private session";
                status.Text = "Stopping your agent and waiting for Windows to finish cleanup. Keep this window open until the session closes.";
                Render();
                // Preserve the bounded backend-owned cleanup contract.
                shutdown.CancelAfter(TimeSpan.FromMinutes(2));
                try { output.WriteLine("{\"kind\":\"stop\"}"); }
                catch (IOException) { stopped = true; window.Close(); }
            }
            void ShowRunning(bool browserRequested)
            {
                progress.Report("running");
                phase.Text = "Agent Web UI available";
                status.Text = browserRequested
                    ? "Windows has been asked to open your browser. The page may still be opening or loading. Start a conversation after the agent's interface appears; this window does not verify a model response."
                    : "The private session has made its Web UI available. Open it in your browser, then start a conversation after the interface loads. Use Stop session when you have finished.";
                Render();
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
                    catch (Exception) { status.Text = "Windows could not open the saved diagnostics. Close this window and check the agent in NemoClaw Setup."; }
                    return;
                }
                if (url is null || stopRequested) return;
                try
                {
                    Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true })?.Dispose();
                    ShowRunning(browserRequested: true);
                }
                catch (Exception) { status.Text = "Windows could not open your default browser. Try Open Web UI again, or stop this session."; }
            }
            open.Click += (_, _) => OpenBrowser();
            stop.Click += (_, _) => { if (stopped) window.Close(); else RequestStop(); };
            window.Closing += (_, args) => { if (!stopped) { args.Cancel = true; RequestStop(); } };
            window.Closed += (_, _) => { timer.Stop(); shutdown.Cancel(); Dispatcher.CurrentDispatcher.InvokeShutdown(); };
            window.Loaded += async (_, _) =>
            {
                var showShutdownFailure = false;
                var showStartupFailure = false;
                try
                {
                    var workArea = SystemParameters.WorkArea;
                    window.Width = Math.Min(window.Width, Math.Max(320, workArea.Width - 24));
                    window.Height = Math.Min(window.Height, Math.Max(300, workArea.Height - 24));
                    Render();
                    output.WriteLine("{\"kind\":\"ready\"}");
                    if (url is not null) ShowRunning(browserRequested: false);
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
                                status.Text = "The session could not finish this step. Open diagnostics for the saved details, or close this window and check the agent in NemoClaw Setup.";
                                var log = record.TryGetProperty("diagnosticPath", out var failurePath) ? failurePath.GetString() : null;
                                diagnosticPath = ValidDiagnosticPath(log, agent) ? log : null;
                                open.Content = "Open diagnostics";
                                open.IsEnabled = diagnosticPath is not null;
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
                                ShowRunning(browserRequested: false);
                                open.IsEnabled = true; if (!qualification) OpenBrowser();
                            }
                        }
                        else if (kind == "progress")
                        {
                            var update = NativeSessionProgress.Parse(record);
                            if (!update.ShouldPresent(url is not null, stopRequested)) continue;
                            progress.Report(update.Stage, update.Measurement);
                            var explanation = update.Explain();
                            phase.Text = explanation.Title;
                            status.Text = explanation.Detail;
                            Render();
                        }
                        else if (kind == "capabilities")
                            capabilities.Text = NativeSessionCapabilities.Parse(record).Description;
                        else throw new InvalidDataException();
                    }
                }
                catch (OperationCanceledException) when (stopRequested)
                {
                    result = 1;
                    showShutdownFailure = true;
                    phase.Text = "Shutdown is not confirmed";
                    status.Text = "The agent did not confirm shutdown within two minutes. Cleanup may still be running. Close this window and check the agent session before starting it again.";
                }
                catch (Exception) { result = 1; }
                finally
                {
                    stopped = true;
                    timer.Stop(); Render();
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
