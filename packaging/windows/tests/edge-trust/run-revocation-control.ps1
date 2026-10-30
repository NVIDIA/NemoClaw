param([Parameter(Mandatory = $true)][string]$Launcher)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Certificate fixtures require an ephemeral GitHub-hosted Windows runner.'
}
$windowsIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
try {
    $principal = [Security.Principal.WindowsPrincipal]::new($windowsIdentity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Certificate fixtures require the ephemeral runner administrator; interactive elevation is not allowed.'
    }
} finally { $windowsIdentity.Dispose() }
$launcherPath = (Resolve-Path -LiteralPath $Launcher).Path
$temporaryRoot = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')
$fixtureRoot = Join-Path $temporaryRoot ('nemoclaw-revocation-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $fixtureRoot
$rootCertificate = $null
$signer = $null
$trustedRoots = [Security.Cryptography.X509Certificates.X509Store]::new('Root', 'LocalMachine')
$rootsOpened = $false
try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NemoClawRevocationBaseline {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct FileInfo {
        public uint Size;
        [MarshalAs(UnmanagedType.LPWStr)] public string Path;
        public IntPtr File;
        public IntPtr Subject;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct TrustData {
        public uint Size;
        public IntPtr Policy;
        public IntPtr Sip;
        public uint Ui;
        public uint Revocation;
        public uint Choice;
        public IntPtr File;
        public uint Action;
        public IntPtr State;
        public IntPtr Url;
        public uint Flags;
        public uint Context;
        public IntPtr Signature;
    }
    [DllImport("wintrust.dll", ExactSpelling = true)]
    static extern int WinVerifyTrust(IntPtr window, ref Guid action, ref TrustData data);
    public static int VerifyWithoutRevocation(string path) {
        var file = new FileInfo { Size = (uint)Marshal.SizeOf<FileInfo>(), Path = path };
        var buffer = Marshal.AllocHGlobal(Marshal.SizeOf<FileInfo>());
        Marshal.StructureToPtr(file, buffer, false);
        var action = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
        var data = new TrustData {
            Size = (uint)Marshal.SizeOf<TrustData>(), Ui = 2, Choice = 1,
            File = buffer, Action = 1, Flags = 0x1010
        };
        try { return WinVerifyTrust(IntPtr.Zero, ref action, ref data); }
        finally {
            data.Action = 2;
            WinVerifyTrust(IntPtr.Zero, ref action, ref data);
            Marshal.DestroyStructure<FileInfo>(buffer);
            Marshal.FreeHGlobal(buffer);
        }
    }
}
'@
    $identity = [Guid]::NewGuid().ToString('N')
    Write-Output 'Creating the owned ephemeral certificate chain.'
    $rootCertificate = New-SelfSignedCertificate -Type Custom -Subject "CN=NemoClaw CI root $identity" `
        -CertStoreLocation 'Cert:\CurrentUser\My' -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 `
        -KeyUsage CertSign, CRLSign -TextExtension '2.5.29.19={critical}{text}ca=1&pathlength=1' `
        -NotAfter (Get-Date).AddDays(1)
    $trustedRoots.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    $rootsOpened = $true
    Write-Output 'Adding the owned root to the ephemeral machine trust store.'
    $trustedRoots.Add($rootCertificate)
    $signer = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=NemoClaw CI signer $identity" `
        -Signer $rootCertificate -CertStoreLocation 'Cert:\CurrentUser\My' -KeyAlgorithm RSA `
        -KeyLength 2048 -HashAlgorithm SHA256 -NotAfter (Get-Date).AddHours(12)
    $sample = Join-Path $fixtureRoot 'never-execute.ps1'
    Set-Content -LiteralPath $sample -Value "throw 'Signature fixture must never execute.'" -Encoding utf8
    Write-Output 'Signing the inert fixture.'
    $null = Set-AuthenticodeSignature -FilePath $sample -Certificate $signer -HashAlgorithm SHA256
    Write-Output 'Checking the unchanged no-revocation baseline.'
    $baseline = [NemoClawRevocationBaseline]::VerifyWithoutRevocation($sample)
    if ($baseline -ne 0) { throw "The signed fixture did not pass the unchanged no-revocation API request: $baseline" }
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $launcherPath
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.ArgumentList.Add('--edge-trust')
    $info.ArgumentList.Add($sample)
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    try {
        Write-Output 'Checking revocation through the candidate native trust owner.'
        if (-not $process.Start()) { throw 'The native trust query did not start.' }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(15000)) {
            $process.Kill($true)
            $process.WaitForExit()
            throw 'The read-only trust query exceeded its deadline.'
        }
        $output = $stdout.GetAwaiter().GetResult()
        $errorText = $stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -eq 0 -or $output.Length -ne 0 -or
            $errorText -notmatch '^Microsoft Edge native identity verification failed \(0x(800b010e|80092012|80092013)\)\.\r?\n$') {
            throw "The native trust owner did not reject unavailable revocation at WinVerifyTrust: $errorText"
        }
        Write-Output 'Real WinVerifyTrust accepted the signed fixture without revocation and the native trust owner rejected its unavailable revocation evidence.'
    } finally { $process.Dispose() }
} finally {
    Write-Output 'Removing the owned certificate chain and private keys.'
    $cleanupFailures = [Collections.Generic.List[string]]::new()
    try {
        if ($rootsOpened -and $null -ne $rootCertificate) {
            $trustedRoots.Remove($rootCertificate)
            if ($trustedRoots.Certificates.Find('FindByThumbprint', $rootCertificate.Thumbprint, $false).Count -ne 0) {
                throw 'The owned trust root remained.'
            }
        }
    } catch { $cleanupFailures.Add($_.Exception.Message) }
    finally { $trustedRoots.Close() }
    foreach ($certificate in @($signer, $rootCertificate)) {
        if ($null -eq $certificate) { continue }
        $ownedPath = 'Cert:\CurrentUser\My\' + $certificate.Thumbprint
        try {
            Remove-Item -LiteralPath $ownedPath -DeleteKey -ErrorAction Stop
            if (Test-Path -LiteralPath $ownedPath) { throw 'An owned certificate fixture remained.' }
        } catch { $cleanupFailures.Add($_.Exception.Message) }
    }
    $resolved = [IO.Path]::GetFullPath($fixtureRoot)
    if ([IO.Path]::GetDirectoryName($resolved) -ne $temporaryRoot -or
        [IO.Path]::GetFileName($resolved) -notmatch '^nemoclaw-revocation-[a-f0-9]{32}$') {
        throw 'The certificate fixture cleanup path is invalid.'
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
    if ($cleanupFailures.Count -ne 0) { throw ($cleanupFailures -join '; ') }
}
