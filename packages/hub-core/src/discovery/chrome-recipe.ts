// Recognize the narrowly reviewed pilot recipe as DATA. Do not execute or
// "interpret" PowerShell. Any additional command/statement makes it unknown.
export function recognizesChromeRecipe(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const patterns = [
    /^\$ErrorActionPreference\s*=\s*['"]Stop['"]$/,
    /^\$config\s*=\s*Get-Content -LiteralPath \(Join-Path \$PSScriptRoot ['"]configuration[\\/]pilot\.json['"]\) -Raw \| ConvertFrom-Json$/,
    /^\$env:CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS\s*=\s*['"]1['"]$/,
    /^\$env:CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS\s*=\s*['"]1['"]$/,
    /^\$chromeArgs\s*=\s*@\(['"]-y['"], \$config\.chrome\.package\) \+ @\(\$config\.chrome\.arguments\)$/,
    /^& npx\.cmd @chromeArgs$/,
    /^exit \$LASTEXITCODE$/,
  ];
  return (
    lines.length === patterns.length &&
    patterns.every((pattern, index) => pattern.test(lines[index]!))
  );
}
