# PreToolUse hook: blocks dangerous git commands before Claude executes them.
# Reads JSON from stdin: {"tool_input":{"command":"<command>"}}
# Exit 2 = BLOCKED, Exit 0 = allowed

$input = $input | Out-String
if (-not $input) { exit 0 }

try {
    $data = $input | ConvertFrom-Json
    $command = $data.tool_input.command
    if (-not $command) { exit 0 }
} catch {
    exit 0
}

$normalized = $command -replace '\s+', ' '

$blockedPatterns = @(
    'git\s+push',
    'git\s+reset\s+--hard',
    'git\s+clean\s+-f',
    'git\s+branch\s+-D',
    'git\s+checkout\s+\.',
    'git\s+restore\s+\.'
)

foreach ($pattern in $blockedPatterns) {
    if ($normalized -match $pattern) {
        $msg = "[BLOCKED] Claude does not have authority to run: $normalized"
        [Console]::Error.WriteLine($msg)
        exit 2
    }
}

exit 0
