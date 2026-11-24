$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,System.Drawing
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
function WaitButton($name) {
 $until=(Get-Date).AddSeconds(90)
 do {
  $w=Window
  if($w) {
   foreach($b in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button))) {
    if($b.Current.Name.Replace('&','') -eq $name -and $b.Current.IsEnabled) { return $b }
   }
  }
  Start-Sleep -Milliseconds 500
 } while((Get-Date) -lt $until)
 throw "Installer button $name unavailable"
}
function Capture($name) {
 $w=Window
 if(!$w) { throw 'Installer window unavailable' }
 $r=$w.Current.BoundingRectangle
 if($r.Width -lt 100 -or $r.Height -lt 100) { throw 'No visible installer window' }
 $bitmap=[System.Drawing.Bitmap]::new([int]$r.Width,[int]$r.Height)
 $graphics=[System.Drawing.Graphics]::FromImage($bitmap)
 try {
  $graphics.CopyFromScreen([int]$r.X,[int]$r.Y,0,0,$bitmap.Size)
  $bitmap.Save((Join-Path $out "$name.png"),[System.Drawing.Imaging.ImageFormat]::Png)
 } finally { $graphics.Dispose(); $bitmap.Dispose() }
}
function Click($button) { $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
Start-Process msiexec.exe -ArgumentList @('/i',('"'+$msi+'"'),'/qf','/norestart') | Out-Null
$until=(Get-Date).AddSeconds(60)
do { $w=Window; if($w) { break }; Start-Sleep -Milliseconds 500 } while((Get-Date) -lt $until)
if(!$w) { throw 'Installer UI did not appear' }
Start-Sleep -Seconds 2
Capture 'license-top'
$texts=@()
foreach($element in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)) {
 $texts += $element.Current.Name
 try { $texts += $element.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern).DocumentRange.GetText(-1) } catch {}
}
$text=$texts -join "`r`n"
Set-Content -Encoding UTF8 (Join-Path $out 'license-accessibility.txt') $text
foreach($notice in @('NVIDIA NemoClaw Agent Configs is licensed','licenses\OpenTofu-LICENSE','licenses\docker-provider-LICENSE','licenses\helm-provider-LICENSE')) {
 if(!$text.Contains($notice)) { throw "License UI missing notice: $notice" }
}
foreach($element in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)) {
 try {
  $scroll=$element.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)
  if($scroll.Current.VerticallyScrollable) { $scroll.SetScrollPercent(-1,100); break }
 } catch {}
}
Start-Sleep -Seconds 1
Capture 'license-bottom'
$checkbox=$w.FindFirst([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,'I accept the terms in the License Agreement'))
if(!$checkbox) { throw 'License acceptance checkbox unavailable' }
try {
 $toggle=$checkbox.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
 if($toggle.Current.ToggleState -ne [System.Windows.Automation.ToggleState]::On) { $toggle.Toggle() }
} catch {
 $checkbox.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern).DoDefaultAction()
}
Click (WaitButton 'Install')
$finish=WaitButton 'Finish'
Capture 'finish'
Set-Content -Encoding UTF8 (Join-Path $out 'finish-accessibility.txt') ((Window).FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition) | ForEach-Object {$_.Current.Name})
Click $finish
$p=Start-Process msiexec.exe -Wait -PassThru -ArgumentList @('/x',('"'+$msi+'"'),'/qn','/norestart')
if($p.ExitCode -ne 0) { throw "Visual test uninstall failed: $($p.ExitCode)" }
Write-Output 'Captured license top, license bottom, all notices, and finish page; test product uninstalled' 
