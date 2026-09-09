// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System.Runtime.InteropServices;
using System.Security;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Nvidia.NemoClaw.Bootstrapper;

internal sealed record NativeSetupConfiguration(string Agent, string Inference, string Endpoint, string Model, bool CredentialStored)
{
    internal NativeSetupOptions Options { get; init; } = new();
    internal string? LocalModel { get; init; }

    internal string Serialize()
    {
        this.Options.Validate(this.Agent);
        var value = new Dictionary<string, object>
        {
            ["schemaVersion"] = 1,
            ["classification"] = "nemoclaw-native-windows-agent-configuration",
            ["profile"] = "personal",
            ["agent"] = this.Agent,
            ["inference"] = this.Inference,
            ["endpoint"] = this.Endpoint,
            ["model"] = this.Model,
            ["credentialStored"] = this.CredentialStored,
            ["options"] = this.Options.ToWireValue(),
        };
        if (this.LocalModel is not null)
        {
            if (this.LocalModel != NativeExpressSetup.Id || this.Inference != "local") throw new InvalidOperationException("The local model selection is invalid.");
            value["localModel"] = this.LocalModel;
        }
        return JsonSerializer.Serialize(value);
    }

    internal byte[] ReadCredential(SecureString password)
    {
        var bytes = ReadBytes(password);
        try
        {
            if ((bytes.Length != 0) != this.CredentialStored)
            {
                throw new InvalidOperationException("The API key field changed after the configuration was selected.");
            }
            if (this.Inference is "nvidia" or "openrouter" && bytes.Length == 0)
            {
                throw new InvalidOperationException("This provider requires an API key.");
            }
            if ((this.Inference == "nvidia" && !bytes.AsSpan().StartsWith("nvapi-"u8)) ||
                (this.Inference == "openrouter" && !bytes.AsSpan().StartsWith("sk-or-"u8)))
            {
                throw new InvalidOperationException("The API key format does not match the selected provider.");
            }
            return bytes;
        }
        catch
        {
            if (bytes is not null) CryptographicOperations.ZeroMemory(bytes);
            throw;
        }
    }

    internal static byte[] ReadServiceCredential(string service, SecureString password)
    {
        var bytes = ReadBytes(password);
        try
        {
            if (bytes.Length == 0) throw new InvalidOperationException("Enter every required integration key.");
            if ((service == "slack-bot" && !bytes.AsSpan().StartsWith("xoxb-"u8)) ||
                (service == "slack-app" && !bytes.AsSpan().StartsWith("xapp-"u8)))
                throw new InvalidOperationException("Slack bot and app tokens must use their matching xoxb- and xapp- prefixes.");
            return bytes;
        }
        catch { CryptographicOperations.ZeroMemory(bytes); throw; }
    }

    private static byte[] ReadBytes(SecureString password)
    {
        var pointer = Marshal.SecureStringToGlobalAllocUnicode(password);
        var characters = new char[password.Length];
        byte[]? bytes = null;
        try
        {
            Marshal.Copy(pointer, characters, 0, characters.Length);
            bytes = Encoding.UTF8.GetBytes(characters);
            if (bytes.Length > 2048 || bytes.Any(value => value is 0 or 10 or 13))
                throw new InvalidOperationException("Enter a valid key of at most 2048 bytes without line breaks.");
            return bytes;
        }
        catch { if (bytes is not null) CryptographicOperations.ZeroMemory(bytes); throw; }
        finally
        {
            Array.Clear(characters);
            Marshal.ZeroFreeGlobalAllocUnicode(pointer);
        }
    }
}
