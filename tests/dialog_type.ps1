# Tests only: wait for a file dialog with this title, put a path in its File name box and press its Open/Save
# button through UI Automation (no keystrokes, so it works while someone else uses the keyboard).
#   powershell -File tests\dialog_type.ps1 "Save machine file" "C:\path\file.slw"
param([string]$Title, [string]$Path, [int]$TimeoutSec = 20)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$root = $A::RootElement
$deadline = (Get-Date).AddSeconds($TimeoutSec)
$dlg = $null
while (-not $dlg -and (Get-Date) -lt $deadline) {
    $cond = New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, $Title)
    $dlg = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
    if (-not $dlg) { Start-Sleep -Milliseconds 300 }
}
if (-not $dlg) { "dialog '$Title' not found"; exit 1 }
Start-Sleep -Milliseconds 500
# the File name box: an Edit whose automation id is 1001 (inside the combo box 1148)
$isEdit = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
$edit = $dlg.FindAll([System.Windows.Automation.TreeScope]::Descendants, $isEdit) | Where-Object { $_.Current.AutomationId -eq '1001' } | Select-Object -First 1
if (-not $edit) { "no File name box"; exit 1 }
$edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($Path)
Start-Sleep -Milliseconds 300
# the default button (automation id 1 = Open / Save)
$idCond = New-Object System.Windows.Automation.PropertyCondition($A::AutomationIdProperty, '1')
$btn = $dlg.FindAll([System.Windows.Automation.TreeScope]::Descendants, $idCond) | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button } | Select-Object -First 1
if (-not $btn) { "no Open/Save button"; exit 1 }
$btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
"filled '$Title' with $Path"
