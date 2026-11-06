param([string]$Action = 'list', [string]$Path, [string]$Keys, [string]$WindowTitle = '*Pi Tab verification*')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class PiNativeInput {
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle, int command);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr handle, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
'@
[void][PiNativeInput]::SetThreadDpiAwarenessContext([IntPtr](-4))
$desktop = [System.Windows.Automation.AutomationElement]::RootElement
$windows = $desktop.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
$window = $windows | Where-Object { $_.Current.Name -like $WindowTitle } | Select-Object -First 1
if (-not $window) { throw 'Isolated Pi Tab verification browser not found' }
function Click-Button($button) {
  $rect = $button.Current.BoundingRectangle
  if ($rect.Width -le 0 -or $rect.Height -le 0) { throw 'Button has empty bounds' }
  [void][PiNativeInput]::SetCursorPos([int]($rect.Left + $rect.Width / 2), [int]($rect.Top + $rect.Height / 2))
  [PiNativeInput]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
  [PiNativeInput]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
}
$buttons = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)))
if ($Action -eq 'prepare' -or $Action -eq 'workflow') {
  [void][PiNativeInput]::ShowWindow([IntPtr]$window.Current.NativeWindowHandle, 9)
  [void][PiNativeInput]::SetWindowPos([IntPtr]$window.Current.NativeWindowHandle, [IntPtr](-1), 80, 80, 1240, 920, 0)
  [void][PiNativeInput]::SetForegroundWindow([IntPtr]$window.Current.NativeWindowHandle)
  if ($Action -eq 'workflow') {
    Start-Sleep -Milliseconds 500
    $buttons = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)))
    $button = $buttons | Where-Object { $_.Current.Name -eq 'Extensions' } | Select-Object -First 1
    Click-Button $button
    for ($i = 0; $i -lt 30; $i++) {
      Start-Sleep -Milliseconds 100
      $all = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
      $extension = $all | Where-Object { $_.Current.Name -like 'Pi Accanto*' -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $_.Current.BoundingRectangle.Width -gt 0 } | Select-Object -First 1
      if ($extension) { Click-Button $extension; break }
    }
    if (-not $extension) { throw 'Pi Tab extension action not found in menu' }
  }
} elseif ($Action -eq 'shortcut') {
  Add-Type -AssemblyName System.Windows.Forms
  $handle = [IntPtr]$window.Current.NativeWindowHandle
  [void][PiNativeInput]::SetForegroundWindow($handle)
  Start-Sleep -Milliseconds 150
  if ([PiNativeInput]::GetForegroundWindow() -ne $handle) {
    # Windows can deny focus to a background process. Activate the isolated
    # browser through its empty title bar, then verify before sending keys.
    $rect = $window.Current.BoundingRectangle
    [void][PiNativeInput]::SetCursorPos([int]($rect.Left + $rect.Width * 0.65), [int]($rect.Top + 12))
    [PiNativeInput]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
    [PiNativeInput]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 150
  }
  if ([PiNativeInput]::GetForegroundWindow() -ne $handle) { throw "Isolated test browser is not foreground (expected $handle, actual $([PiNativeInput]::GetForegroundWindow())); refusing keyboard input" }
  [System.Windows.Forms.SendKeys]::SendWait($Keys)
} elseif ($Action -eq 'list') {
  $buttons | ForEach-Object { "$($_.Current.Name) : $($_.Current.BoundingRectangle)" }
} elseif ($Action -eq 'extensions') {
  $button = $buttons | Where-Object { $_.Current.Name -eq 'Extensions' } | Select-Object -First 1
  if (-not $button) { throw 'Extensions toolbar button not found' }
  Click-Button $button
} elseif ($Action -eq 'open') {
  $button = $buttons | Where-Object { $_.Current.Name -like '*Pi Accanto*' } | Select-Object -First 1
  if (-not $button) { throw 'Pi Tab extension action not found' }
  Click-Button $button
} elseif ($Action -eq 'allow-site') {
  $button = $buttons | Where-Object { $_.Current.Name -eq 'Allow' } | Select-Object -First 1
  if (-not $button) { throw 'Site permission confirmation not found in the isolated test browser' }
  $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
} elseif ($Action -eq 'screenshot') {
  Add-Type -AssemblyName System.Drawing
  $rect = $window.Current.BoundingRectangle
  $bitmap = New-Object System.Drawing.Bitmap([int]$rect.Width, [int]$rect.Height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen([int]$rect.Left, [int]$rect.Top, 0, 0, $bitmap.Size)
  $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose()
  $bitmap.Dispose()
} else { throw 'Unknown action' }
