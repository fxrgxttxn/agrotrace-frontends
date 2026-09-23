$ErrorActionPreference = 'Stop'
& bash "$PSScriptRoot/at.sh" @args
exit $LASTEXITCODE
