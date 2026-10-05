$ErrorActionPreference = 'Stop'
function Find-GitBash {
  $candidates = @()
  $git = Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $git) {
    $gitDir = Split-Path -Parent $git.Source
    $candidates += Join-Path $gitDir '..\bin\bash.exe'
    $candidates += Join-Path $gitDir '..\..\bin\bash.exe'
  }
  $candidates += Join-Path $env:ProgramFiles 'Git\bin\bash.exe'
  foreach ($c in $candidates) {
    if (Test-Path -LiteralPath $c -PathType Leaf) { return (Resolve-Path -LiteralPath $c).Path }
  }
  throw "Git Bash not found (looked for: $($candidates -join ', ')). Install Git for Windows: https://git-scm.com/download/win"
}

$bash = Find-GitBash
& $bash "$PSScriptRoot/at.sh" @args
exit $LASTEXITCODE
