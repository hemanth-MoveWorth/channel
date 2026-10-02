$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskData = Join-Path $taskRoot 'data\live'
New-Item -ItemType Directory -Path $taskData -Force | Out-Null
$taskCodex = (Get-Command codex.exe -ErrorAction Stop).Source
$taskNode = (Get-Command node.exe -ErrorAction Stop).Source
$taskHermesRoot = Join-Path $env:LOCALAPPDATA 'hermes\hermes-agent'
$taskHermes = Join-Path $taskHermesRoot 'venv\Scripts\hermes.exe'
$taskPython = Join-Path $taskHermesRoot 'venv\Scripts\python.exe'
if (!(Test-Path -LiteralPath $taskHermes) -or !(Test-Path -LiteralPath $taskPython)) { throw 'The installed Hermes executable was not found.' }
$taskStdio = Join-Path $taskRoot 'packages\mcp-server\src\bin\live-stdio.mjs'
$taskRuntime = @{codex=$taskCodex; hermes=$taskHermes} | ConvertTo-Json
[System.IO.File]::WriteAllText((Join-Path $taskData 'runtime.json'), $taskRuntime)
# Hermes's own config helper validates and adds exactly one MCP entry. No credentials are printed.
$taskPythonCode = @'
import sys, pathlib, shutil, json
sys.path.insert(0, sys.argv[3])
from hermes_cli.config import get_config_path, load_config
from hermes_cli.mcp_config import _save_mcp_server
config_path = get_config_path()
backup = pathlib.Path(sys.argv[4]) / 'hermes-config-before-signaldesk.yaml'
if config_path.exists() and not backup.exists():
    shutil.copy2(config_path, backup)
entry = {'command': sys.argv[1], 'args': [sys.argv[2]], 'timeout': 45}
prior = load_config().get('mcp_servers', {}).get('signaldesk')
if prior and prior != entry:
    raise SystemExit('An existing signaldesk MCP entry differs. Refusing to overwrite it.')
if not _save_mcp_server('signaldesk', entry):
    raise SystemExit('Hermes rejected MCP configuration.')
print('Hermes SignalDesk MCP configured. Existing provider sign-in and other entries retained.')
'@
$taskPythonCode | & $taskPython - $taskNode $taskStdio $taskHermesRoot $taskData
if ($LASTEXITCODE -ne 0) { throw 'Hermes configuration failed.' }
Write-Output 'Setup complete. Run npm run live, then open http://127.0.0.1:3000.'
