[CmdletBinding()]
param([switch]$Build,[switch]$Running,[int]$Port=8790)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$live=Join-Path $root 'services/helldesk\local-live'
$observations=[System.Collections.Generic.List[object]]::new()
if($Build){
  Push-Location (Join-Path $live 'ui')
  try{bun run build;if($LASTEXITCODE -ne 0){throw 'UI build failed'};$observations.Add(@{check='UI build';result='completed'})}finally{Pop-Location}
}
$tokens=$null;$parseErrors=$null
[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'launch-operator-room.ps1'),[ref]$tokens,[ref]$parseErrors)|Out-Null
if($parseErrors.Count){throw ($parseErrors.Message -join "`n")}
$observations.Add(@{check='launcher syntax';result='parsed'})
if($Running){
  $connections=Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/kilo/config" -TimeoutSec 10
  $observations.Add(@{check='Kilo discovery';status=$connections.data.status;model=$connections.data.model;mcpCount=$connections.data.mcp.Count;pluginCount=$connections.data.plugins.Count;runtimeApplication=$connections.data.application.mode})
  if($connections.data.status -eq 'unavailable'){throw 'Kilo configuration unavailable; inspect Connections in the UI.'}
  $response=Invoke-WebRequest -Uri "http://127.0.0.1:$Port/helldesk/" -TimeoutSec 10
  $observations.Add(@{check='Operator UI HTTP';status=$response.StatusCode})
}
$report=@{at=[DateTime]::UtcNow.ToString('o');observations=$observations;productionAcceptance='CTO_ONLY';modelTasksSubmitted=0;manualScenario=@('Create a disposable input and separate output repo.','Create task A with explicit acceptance requirements and Inquisitor.','Create task B depending on A; confirm it stays blocked until A is machine-reviewed.','Open Operator Room, select the agent, send a direction change and inspect queued acknowledgement.','Reload connections; existing work must continue and new sessions inherit changes.','Reject machine output with Needs more work; confirm another iteration before giving your own acceptance.')}
$report | ConvertTo-Json -Depth 8
