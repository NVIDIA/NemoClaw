$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,System.Drawing
Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class InstallerControls {
 public delegate bool Visit(IntPtr window, IntPtr parameter);
 [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, Visit visitor, IntPtr parameter);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr count, StringBuilder text);
 [DllImport("user32.dll", EntryPoint="SendMessageW")] public static extern IntPtr Message(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
 [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr window);
 public static IntPtr[] Children(IntPtr parent) {
  var children=new List<IntPtr>();
  EnumChildWindows(parent,(window,parameter)=>{children.Add(window);return true;},IntPtr.Zero);
  return children.ToArray();
 }
 public static string Text(IntPtr window) {
  var text=new StringBuilder(262144);
  SendMessage(window,0x000D,(IntPtr)text.Capacity,text);
  return text.ToString();
 }
}
'@
$out=Join-Path $env:RUNNER_TEMP 'installer-ui'
New-Item -ItemType Directory -Force $out | Out-Null
$msi=Join-Path $env:RUNNER_TEMP 'current/nemoclaw-v0.1.0-rc.3-windows_amd64.msi'
$root=[System.Windows.Automation.AutomationElement]::RootElement
function Window {
 foreach($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)) {
  if($w.Current.Name -like '*NemoClaw*') { return $w }
 }
 return $null
}
function Controls {
 $w=Window
 if($w) { return [InstallerControls]::Children([IntPtr]$w.Current.NativeWindowHandle) }
 return @()
}
function WaitControl($name) {
 $until=(Get-Date).AddSeconds(60)
 do {
  foreach($handle in (Controls)) {
   if(([InstallerControls]::Text($handle)).Replace('&','') -eq $name -and [InstallerControls]::IsWindowEnabled($handle)) { return $handle }
  }
  Start-Sleep -Milliseconds 500
 } while((Get-Date) -lt $until)
 throw "Installer control $name unavailable"
}
function Capture($name) {
 $w=Window
 if(!$w) { throw 'Installer window unavailable' }
 $r=$w.Current.BoundingRectangle
 $bitmap=[System.Drawing.Bitmap]::new([int]$r.Width,[int]$r.Height)
 $graphics=[System.Drawing.Graphics]::FromImage($bitmap)
 try {
  $graphics.CopyFromScreen([int]$r.X,[int]$r.Y,0,0,$bitmap.Size)
  $bitmap.Save((Join-Path $out "$name.png"),[System.Drawing.Imaging.ImageFormat]::Png)
 } finally { $graphics.Dispose(); $bitmap.Dispose() }
}
function Click($handle) { [InstallerControls]::Message($handle,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null }
Start-Process msiexec.exe -ArgumentList @('/i',('"'+$msi+'"'),'/qf','/norestart') | Out-Null
$checkbox=WaitControl 'I accept the terms in the License Agreement'
Capture 'license-top'
$texts=@(Controls | ForEach-Object { [InstallerControls]::Text($_) })
$text=$texts -join "`r`n"
Set-Content -Encoding UTF8 (Join-Path $out 'license-controls.txt') $text
foreach($notice in @('NVIDIA NemoClaw Agent Configs is licensed','licenses\OpenTofu-LICENSE','licenses\docker-provider-LICENSE','licenses\helm-provider-LICENSE')) {
 if(!$text.Contains($notice)) { throw "License UI missing notice: $notice" }
}
foreach($handle in (Controls)) {
 if(([InstallerControls]::Text($handle)).Contains('Third-party notice:')) {
  [InstallerControls]::Message($handle,0x0115,[IntPtr]7,[IntPtr]::Zero) | Out-Null
  break
 }
}
Start-Sleep -Seconds 1
Capture 'license-bottom'
Click $checkbox
Start-Sleep -Seconds 1
Capture 'license-accepted'
Click (WaitControl 'Install')
$finish=WaitControl 'Finish'
Capture 'finish'
Set-Content -Encoding UTF8 (Join-Path $out 'finish-controls.txt') ((Controls) | ForEach-Object {[InstallerControls]::Text($_)})
Click $finish
$p=Start-Process msiexec.exe -Wait -PassThru -ArgumentList @('/x',('"'+$msi+'"'),'/qn','/norestart')
if($p.ExitCode -ne 0) { throw "Visual test uninstall failed: $($p.ExitCode)" }
Write-Output 'Captured license notices and finish page; test product uninstalled'
