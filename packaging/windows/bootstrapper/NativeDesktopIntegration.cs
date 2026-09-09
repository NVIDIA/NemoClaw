// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;

namespace Nvidia.NemoClaw.Bootstrapper;

internal static class NativeDesktopIntegration
{
    private const string Owner = "NVIDIA NemoClaw native desktop shortcut v1";
    internal static readonly string[] Agents = { "openclaw", "hermes", "langchain-deepagents-code", "pi", "nemocua" };

    internal static string AgentName(string agent) => agent switch
    {
        "openclaw" => "OpenClaw", "hermes" => "Hermes", "langchain-deepagents-code" => "Deep Agents",
        "pi" => "Pi", "nemocua" => "NemoCUA", _ => throw new InvalidOperationException("The selected agent is invalid."),
    };

    internal static void Ensure(string agent, string launcher)
    {
        _ = AgentName(agent);
        var root = Directory.GetParent(Path.GetDirectoryName(Path.GetFullPath(launcher))!)!.FullName;
        var icons = Path.Combine(root, "desktop-icons");
        EnsureSetup(launcher);
        Write($"NemoClaw {AgentName(agent)}", launcher, $"--configured --agent {agent}", Path.Combine(icons, $"{agent}.ico"));
    }

    internal static void EnsureSetup(string launcher)
    {
        var root = Directory.GetParent(Path.GetDirectoryName(Path.GetFullPath(launcher))!)!.FullName;
        Write("NemoClaw Setup", launcher, "--installer", Path.Combine(root, "desktop-icons", "NemoClaw.ico"));
    }

    internal static void Repair(string launcher)
    {
        EnsureSetup(launcher);
        var active = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "NVIDIA", "NemoClaw", "active-agent.txt");
        if (!File.Exists(active)) return;
        AssertPlain(active);
        using var file = new FileStream(active, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (file.Length > 64) throw new InvalidOperationException("The remembered agent selection is invalid.");
        using var reader = new StreamReader(file);
        var marker = reader.ReadToEnd();
        var agent = marker.TrimEnd('\n');
        if (marker != agent + "\n" || !Agents.Contains(agent, StringComparer.Ordinal))
            throw new InvalidOperationException("The remembered agent selection is invalid.");
        Ensure(agent, launcher);
    }

    internal static void RemoveOwned(string launcher)
    {
        var names = new List<string> { "NemoClaw Setup" };
        foreach (var agent in Agents)
        {
            names.Add($"NemoClaw {AgentName(agent)}");
        }
        foreach (var name in names)
        {
            var path = ShortcutPath(name);
            if (!File.Exists(path)) continue;
            AssertPlain(path);
            WithShortcut(path, shortcut =>
            {
                if (IsOwned(shortcut, launcher)) File.Delete(path);
            });
        }
    }

    private static string ShortcutPath(string name)
    {
        var desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        if (string.IsNullOrEmpty(desktop) || !Directory.Exists(desktop))
            throw new InvalidOperationException("The Windows desktop directory is unavailable.");
        AssertPlain(desktop);
        return Path.Combine(desktop, name + ".lnk");
    }

    private static void AssertPlain(string path)
    {
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidOperationException("A desktop shortcut location is a redirected filesystem entry.");
    }

    private static object? Property(object shortcut, string name, params object[] value) =>
        shortcut.GetType().InvokeMember(name, value.Length == 0 ? BindingFlags.GetProperty : BindingFlags.SetProperty,
            null, shortcut, value);

    private static bool IsOwned(object shortcut, string launcher) =>
        string.Equals(Property(shortcut, "Description") as string, Owner, StringComparison.Ordinal) &&
        string.Equals(Property(shortcut, "TargetPath") as string, Path.GetFullPath(launcher), StringComparison.OrdinalIgnoreCase);

    private static void WithShortcut(string path, Action<object> action)
    {
        var type = Type.GetTypeFromProgID("WScript.Shell", throwOnError: true)!;
        var shell = Activator.CreateInstance(type)!;
        object? shortcut = null;
        try
        {
            shortcut = type.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { path })!;
            action(shortcut);
        }
        finally
        {
            if (shortcut is not null) Marshal.FinalReleaseComObject(shortcut);
            Marshal.FinalReleaseComObject(shell);
        }
    }

    private static void Write(string name, string launcher, string arguments, string icon)
    {
        if (!File.Exists(launcher) || !File.Exists(icon)) throw new InvalidOperationException("Installed desktop shortcut files are missing.");
        var path = ShortcutPath(name);
        if (File.Exists(path))
        {
            AssertPlain(path);
            WithShortcut(path, shortcut =>
            {
                if (!IsOwned(shortcut, launcher)) throw new InvalidOperationException("A desktop shortcut with this name belongs to another application.");
            });
        }
        var temporary = Path.Combine(Path.GetDirectoryName(path)!, $".NemoClaw-{Guid.NewGuid():N}.lnk");
        try
        {
            WithShortcut(temporary, shortcut =>
            {
                Property(shortcut, "TargetPath", Path.GetFullPath(launcher));
                Property(shortcut, "Arguments", arguments);
                Property(shortcut, "WorkingDirectory", Path.GetDirectoryName(launcher)!);
                Property(shortcut, "IconLocation", icon + ",0");
                Property(shortcut, "Description", Owner);
                shortcut.GetType().InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
            });
            File.Move(temporary, path, overwrite: true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
}
