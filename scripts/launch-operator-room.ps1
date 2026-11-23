[CmdletBinding()]
param(
  [switch]$Stop,
  [switch]$Restart,
  [switch]$SkipBuild,
  [switch]$NoBrowser,
  [string]$ReviewerModel = 'gpt-6-luna',
  # Point this at a local NAI-Lattice checkout to start the fabric host
  # (nai-fabric-host.exe, port 8787). It is a SEPARATE repo, so leave empty to
  # run HELLDESK standalone (the mission runner needs no fabric host).
  [string]$LatticeRoot = $(if($env:NAI_LATTICE_ROOT){$env:NAI_LATTICE_ROOT}else{$env:NAI_FABRIC_HOST_ROOT})
)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$live=Join-Path $root 'services/helldesk\local-live'
$local=Join-Path $root 'services/helldesk\local'
$state=Join-Path $PSScriptRoot 'logs\operator-room'
New-Item -ItemType Directory -Force -Path $state | Out-Null
function Stop-Owned([string]$name){
  $record=Join-Path $state "$name.json"
  if(!(Test-Path -LiteralPath $record)){return}
  $saved=Get-Content -LiteralPath $record -Raw | ConvertFrom-Json
  $process=Get-Process -Id $saved.pid -ErrorAction SilentlyContinue
  if($process -and $process.StartTime.ToUniversalTime().ToString('o') -eq $saved.startedAt -and $process.Path -eq $saved.executable){
    # Descendants are this verified launcher's owned Kilo/Codex subprocesses.
    # Kill the owned tree so stopping the daemon cannot orphan model workers.
    & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $process.Id /T /F | Out-Null
    $process.WaitForExit(10000) | Out-Null
    Write-Output "Stopped owned $name process."
  }
  Remove-Item -LiteralPath $record
}
if($Stop -or $Restart){foreach($name in @('local-live','local-daemon','nai-host')){Stop-Owned $name}}
if($Stop){return}
$bun=(Get-Command bun -ErrorAction Stop).Source
$bun=(& $bun -e 'console.log(process.execPath)').Trim()
if(!$SkipBuild){
  Push-Location (Join-Path $live 'ui')
  try{& $bun install --frozen-lockfile; if($LASTEXITCODE -ne 0){throw 'UI dependency installation failed'}; & $bun run build; if($LASTEXITCODE -ne 0){throw 'UI build failed'}}finally{Pop-Location}
}
function Assert-Free([int]$port){
  $listener=Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object LocalPort -eq $port
  if($listener){throw "Port $port belongs to an existing process ($($listener.OwningProcess -join ',')). Close its existing launcher, or use -Restart for processes owned by this script. No unrelated process was stopped."}
}
# The user's requested workflow: Kilo implements, Codex reviews. Preserve all
# existing workspace/provider/credential settings and keep a local backup.
$configFile=Join-Path $local 'config.json'
$config=if(Test-Path -LiteralPath $configFile){Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json -AsHashtable}else{@{version=1;daemon=@{};policy=@{};autonomy=@{};workspaces=@()}}
if(!$config.daemon){$config.daemon=@{}}
if(!$config.daemon.port){$config.daemon.port=4790}
Assert-Free $(if($config.daemon.port){[int]$config.daemon.port}else{4790})
Assert-Free 8790
if(Test-Path -LiteralPath $configFile){Copy-Item -LiteralPath $configFile -Destination (Join-Path $state ("config-before-"+[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+'.json'))}
if(!$config.policy){$config.policy=@{}}
if(!$config.autonomy){$config.autonomy=@{}}
$config.policy.runner='codex'
$config.policy.reviewerModel=@{providerID='openai';modelID=$ReviewerModel}
$config.policy.productionCancelFake=$true
$config.autonomy.enabled=$true
$config.autonomy.mutationRunner='kilo'
# Empty explicit mutation route means inherit the current Kilo default.
$config.autonomy.providerID=''
$config.autonomy.modelID=''
if(!$config.autonomy.taskGates){$config.autonomy.taskGates=@('spec_parity','no_scope_loss','functional_correctness','regression_safety','delivery_documentation')}
$staged=$configFile+'.operator-new'
$config | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $staged -Encoding utf8
Move-Item -LiteralPath $staged -Destination $configFile -Force
function Start-Owned([string]$name,[string]$executable,[string[]]$arguments,[string]$directory){
  $options=@{FilePath=$executable;WorkingDirectory=$directory;WindowStyle='Hidden';PassThru=$true;RedirectStandardOutput=(Join-Path $state "$name.stdout.log");RedirectStandardError=(Join-Path $state "$name.stderr.log")}
  if($arguments.Count){$options.ArgumentList=$arguments}
  $process=Start-Process @options
  @{pid=$process.Id;startedAt=$process.StartTime.ToUniversalTime().ToString('o');executable=$process.Path} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $state "$name.json") -Encoding utf8
}
Start-Owned 'local-daemon' $bun @('run','src/main.ts') $local
Start-Owned 'local-live' $bun @('run','src/entry.ts') $live
$hostExecutable=Join-Path $LatticeRoot 'target\release\nai-fabric-host.exe'
$existingHost=Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object LocalPort -eq 8787
if(!$existingHost -and (Test-Path -LiteralPath $hostExecutable)){Start-Owned 'nai-host' $hostExecutable @() $LatticeRoot}
elseif(!$existingHost){Write-Warning "NAI fabric host missing: $hostExecutable. Operator chat federation/NAI fabric view will show unavailable; local mission runner is separate."}
$ready=$false
for($attempt=0;$attempt -lt 30;$attempt++){
  try{$r=Invoke-RestMethod -Uri 'http://127.0.0.1:8790/api/kilo/config' -TimeoutSec 2;if($r.data){$ready=$true;break}}catch{}
  Start-Sleep -Milliseconds 500
}
if(!$ready){throw "Operator server did not become reachable. Inspect $state\local-live.stderr.log; owned services remain available for diagnosis."}
Write-Output "Operator Room: http://127.0.0.1:8790/helldesk/"
Write-Output "Kilo implements using its current configuration. Codex reviewer model: $ReviewerModel. Autonomy is enabled for queued and newly created missions."
Write-Output "Create a mission and workstation, configure repositories in Task Studio, then launch your task. Logs: $state"
if(!$NoBrowser){Start-Process 'http://127.0.0.1:8790/helldesk/'}
