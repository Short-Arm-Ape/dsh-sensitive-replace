# content-risk-interactive.ps1
# 交互式 Content Exists Risk 触发测试器

$ErrorActionPreference = 'Stop'

# ============================================================
# 菜单（方向键；不支持则退化为编号）
# ============================================================
function Select-Menu {
    param(
        [string]$Title,
        [string[]]$Items,
        [int]$Default = 0
    )
    if ($Items.Count -eq 0) { return -1 }
    $idx = [Math]::Max(0, [Math]::Min($Default, $Items.Count - 1))

    $arrowOk = $true
    try { $null = [Console]::KeyAvailable } catch { $arrowOk = $false }

    if (-not $arrowOk) {
        Write-Host $Title -ForegroundColor Cyan
        for ($i = 0; $i -lt $Items.Count; $i++) {
            $mark = if ($i -eq $idx) { '*' } else { ' ' }
            Write-Host ('  ' + $mark + ' [' + ($i+1) + '] ' + $Items[$i])
        }
        while ($true) {
            $sel = Read-Host ('选择 [1-' + $Items.Count + ']，直接回车 = ' + ($idx+1))
            if ([string]::IsNullOrWhiteSpace($sel)) { return $idx }
            $n = 0
            if ([int]::TryParse($sel, [ref]$n) -and $n -ge 1 -and $n -le $Items.Count) { return ($n - 1) }
            Write-Host '无效输入，请重试' -ForegroundColor Yellow
        }
    }

    $width = 78
    try { $width = [Math]::Max(20, [Console]::WindowWidth - 2) } catch {}

    Write-Host $Title -ForegroundColor Cyan
    $top = [Console]::CursorTop
    $oldVis = $true
    try { $oldVis = [Console]::CursorVisible; [Console]::CursorVisible = $false } catch {}

    try {
        while ($true) {
            for ($i = 0; $i -lt $Items.Count; $i++) {
                [Console]::SetCursorPosition(0, $top + $i)
                $prefix = if ($i -eq $idx) { '  > ' } else { '    ' }
                $line = $prefix + $Items[$i]
                if ($line.Length -lt $width) { $line = $line.PadRight($width) }
                elseif ($line.Length -gt $width) { $line = $line.Substring(0, $width) }
                if ($i -eq $idx) {
                    Write-Host $line -ForegroundColor Black -BackgroundColor Cyan -NoNewline
                } else {
                    Write-Host $line -NoNewline
                }
            }
            [Console]::SetCursorPosition(0, $top + $Items.Count)
            $hint = '  (↑↓ 选择 / Enter 确认)'
            if ($hint.Length -lt $width) { $hint = $hint.PadRight($width) }
            Write-Host $hint -ForegroundColor DarkGray -NoNewline
            [Console]::SetCursorPosition(0, $top + $Items.Count)

            $k = [Console]::ReadKey($true)
            switch ($k.Key) {
                'UpArrow'   { $idx = ($idx - 1 + $Items.Count) % $Items.Count }
                'DownArrow' { $idx = ($idx + 1) % $Items.Count }
                'Enter'     {
                    try { [Console]::SetCursorPosition(0, $top + $Items.Count + 1) } catch {}
                    return $idx
                }
            }
        }
    } finally {
        try { [Console]::CursorVisible = $oldVis } catch {}
    }
}

# ============================================================
# 启动配置
# ============================================================
$key = $env:DSK_PROBE_KEY
if (-not $key) {
    Write-Host '未在 $env:DSK_PROBE_KEY 中找到 API key。' -ForegroundColor Yellow
    $key = Read-Host '请输入 API key'
    if (-not $key) { Write-Error '缺少 API key，退出'; exit 1 }
}

# Provider
$providerOpts = @(
    'DeepSeek   (api.deepseek.com)',
    'OpenAI     (api.openai.com)',
    '自定义 endpoint...'
)
$pIdx = Select-Menu '选择服务提供商：' $providerOpts 0
switch ($pIdx) {
    0 {
        $endpoint       = 'https://api.deepseek.com/chat/completions'
        $presetModels   = @('deepseek-v4-flash','deepseek-v4-pro','deepseek-flash')
        $providerLabel  = 'deepseek'
    }
    1 {
        $endpoint       = 'https://api.openai.com/v1/chat/completions'
        $presetModels   = @('gpt-4o','gpt-4o-mini','gpt-4-turbo')
        $providerLabel  = 'openai'
    }
    default {
        $u = Read-Host '输入完整 endpoint URL（例如 https://api.example.com/v1/chat/completions）'
        if (-not $u) { Write-Error '缺少 URL，退出'; exit 1 }
        $endpoint       = $u
        $presetModels   = @()
        $providerLabel  = 'custom'
    }
}

# Model
if ($env:DSK_PROBE_MODEL) {
    $model = $env:DSK_PROBE_MODEL
} else {
    $modelOpts = @($presetModels) + @('自定义模型名...')
    $mIdx = Select-Menu '选择模型：' $modelOpts 0
    if ($mIdx -eq ($modelOpts.Count - 1)) {
        $model = Read-Host '输入模型名'
        if (-not $model) { Write-Error '缺少模型名，退出'; exit 1 }
    } else {
        $model = $modelOpts[$mIdx]
    }
}

# 初始模式
$modeOpts = @(
    'single   单词模式（回车即发）',
    'batch    批量模式（空格分词，回车即发）',
    'binary   二分模式（多行 + END 提交）'
)
$moIdx = Select-Menu '选择初始模式：' $modeOpts 0
$mode = @('single','batch','binary')[$moIdx]

# ============================================================
# 运行时
# ============================================================
$maxDepth = 24
$tmp = Join-Path $env:TEMP ('cri-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null

$script:binHits     = [System.Collections.Generic.List[string]]::new()
$script:binContexts = [System.Collections.Generic.List[string]]::new()

function Send([string]$text, [string]$label) {
    $body = @{ model = $model; messages = @(@{ role = 'user'; content = $text }); max_tokens = 1; stream = $false } | ConvertTo-Json -Depth 6 -Compress
    $bf = Join-Path $tmp 'r.json'; $of = Join-Path $tmp 'o.json'
    Set-Content -Path $bf -Value $body -Encoding utf8
    $code = & curl.exe -s -m 30 -o $of -w '%{http_code}' -X POST $endpoint `
        -H "Authorization: Bearer $key" -H 'Content-Type: application/json' --data "@$bf" 2>$null
    $msg = 'OK'
    if ($code -ne '200') {
        try {
            $j = Get-Content $of -Raw | ConvertFrom-Json
            $msg = ($j.error.message -split "`n")[0]
            if (-not $msg) { $msg = '(unparsed body)' }
        } catch { $msg = '(unparsed body)' }
    }
    $line = '[' + $label + ' | chars=' + $text.Length + '] HTTP ' + $code + ' | ' + $msg
    if ($code -eq '400') { Write-Host $line -ForegroundColor Red } else { Write-Host $line }
    return [pscustomobject]@{ Code = $code; Message = $msg }
}

function Get-Half([string]$text) {
    $words = @($text -split '\s+' | Where-Object { $_ -ne '' })
    if ($words.Count -ge 2) {
        $mid = [int][Math]::Floor($words.Count / 2)
        return @( ($words[0..($mid-1)] -join ' '), ($words[$mid..($words.Count-1)] -join ' ') )
    }
    if ($text.Length -ge 2) {
        $mid = [int][Math]::Floor($text.Length / 2)
        return @( $text.Substring(0, $mid), $text.Substring($mid) )
    }
    return @()
}

function Resolve-Boundary([string]$parent, [string]$leftPart, [int]$depth) {
    $n = $parent.Length
    $k = $leftPart.Length

    Write-Host ('  ↻ 两半均过 → 边界重定位 (k=' + $k + ', len=' + $n + ')') -ForegroundColor DarkYellow

    $rightM = -1; $d = 1
    while ($true) {
        $m = [Math]::Min($k + $d, $n)
        if ($m -le $k) { break }
        $r = Send ($parent.Substring(0, $m)) ('posR+' + $d)
        if ($r.Code -eq '400') { $rightM = $m; break }
        if ($m -eq $n) { break }
        $d *= 2
    }

    $leftL = -1; $d = 1
    while ($true) {
        $l = [Math]::Max($k - $d, 0)
        $r = Send ($parent.Substring($l)) ('posL-' + $d)
        if ($r.Code -eq '400') { $leftL = $l; break }
        if ($l -eq 0) { break }
        $d *= 2
    }

    $slice = $null; $desc = ''
    if ($rightM -ge 0 -and $leftL -ge 0 -and $leftL -lt $rightM -and ($leftL -gt 0 -or $rightM -lt $n)) {
        $slice = $parent.Substring($leftL, $rightM - $leftL); $desc = "交集 [$leftL,$rightM)"
    }
    if (-not $slice -and $rightM -ge 0 -and $rightM -lt $n) {
        $slice = $parent.Substring(0, $rightM); $desc = "前缀 [0,$rightM)"
    }
    if (-not $slice -and $leftL -gt 0) {
        $slice = $parent.Substring($leftL); $desc = "后缀 [$leftL,$n)"
    }

    if (-not $slice) {
        Write-Host ('  >>> 上下文组合触发（非连续片段）: [' + $parent + ']') -ForegroundColor Magenta
        $script:binContexts.Add($parent) | Out-Null
        return $true
    }

    Write-Host ('  重定位到 ' + $desc + ' (len=' + $slice.Length + ')')
    Invoke-Binary $slice ($depth + 1) | Out-Null
    return $true
}

function Invoke-Binary([string]$text, [int]$depth = 0) {
    if ($depth -gt $maxDepth) {
        Write-Host '  (深度超限，停止)' -ForegroundColor DarkGray
        return $false
    }

    $r = Send $text ('binary d' + $depth)
    if ($r.Code -ne '400') { return $false }

    $parts = Get-Half $text
    if ($parts.Count -eq 0) {
        Write-Host ('  >>> 命中: [' + $text + ']') -ForegroundColor Yellow
        $script:binHits.Add($text) | Out-Null
        return $true
    }

    $lHit = Invoke-Binary $parts[0] ($depth + 1)
    $rHit = Invoke-Binary $parts[1] ($depth + 1)
    if ($lHit -or $rHit) { return $true }

    return (Resolve-Boundary $text $parts[0] $depth)
}

function Show-BinarySummary {
    Write-Host ''
    Write-Host '================ 二分结果汇总 ================' -ForegroundColor Cyan
    $hits = $script:binHits
    $ctxs = $script:binContexts
    if ($hits.Count -eq 0 -and $ctxs.Count -eq 0) {
        Write-Host '  未发现任何命中。' -ForegroundColor Green
    } else {
        if ($hits.Count -gt 0) {
            Write-Host ('命中片段 (' + $hits.Count + ' 个):') -ForegroundColor Yellow
            for ($i = 0; $i -lt $hits.Count; $i++) {
                $t = $hits[$i]
                $disp = if ($t.Length -le 100) { $t } else { $t.Substring(0,100) + '...' }
                $disp = $disp -replace "`r?`n", ' / '
                Write-Host ('  [' + ($i+1) + '] len=' + $t.Length + '  ' + $disp)
            }
        }
        if ($ctxs.Count -gt 0) {
            Write-Host ('上下文组合触发 (' + $ctxs.Count + ' 个):') -ForegroundColor Magenta
            for ($i = 0; $i -lt $ctxs.Count; $i++) {
                $t = $ctxs[$i]
                $disp = if ($t.Length -le 100) { $t } else { $t.Substring(0,100) + '...' }
                $disp = $disp -replace "`r?`n", ' / '
                Write-Host ('  [' + ($i+1) + '] len=' + $t.Length + '  ' + $disp)
            }
        }
    }
    Write-Host '==============================================' -ForegroundColor Cyan
}

function Show-Help {
    Write-Host @'
命令：
  mode single|batch|binary   切换模式
  model <名>                 切换模型
  file <路径> [起始] [长度]   发送文件切片
  h / help                   帮助
  q / quit                   退出

模式：
  single  单词模式：输入一个词，回车即发送
  batch   批量模式：输入一行，按空格分词，逐个发送
  binary  二分模式：多行输入，END 提交；命中后自动二分 + 边界重定位
'@ -ForegroundColor Gray
}

function Show-Status {
    Write-Host ''
    Write-Host ('[' + $mode + ' | ' + $model + ' @ ' + $providerLabel + ']') -ForegroundColor DarkCyan
    if ($mode -eq 'binary') {
        Write-Host '  多行输入，单独一行 END 提交 | 命令：mode/model/file/h/q' -ForegroundColor DarkGray
    } else {
        Write-Host '  输入后回车即发送 | 命令：mode/model/file/h/q' -ForegroundColor DarkGray
    }
}

Write-Host ''
Write-Host ('已连接: ' + $providerLabel + ' | 模型: ' + $model + ' | 初始模式: ' + $mode) -ForegroundColor Green

# ============================================================
# 主循环
# ============================================================
while ($true) {
    Show-Status

    $lines = [System.Collections.Generic.List[string]]::new()
    $action = 'cmd'

    while ($true) {
        $ln = Read-Host

        if ($ln -eq 'q' -or $ln -eq 'quit') {
            Write-Host 'bye'
            Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
            exit 0
        }

        if ($lines.Count -eq 0) {
            if ($ln -eq 'h' -or $ln -eq 'help') { Show-Help; break }
            if ($ln -eq '') { break }
            if ($ln -like 'mode *') {
                $m = ($ln -replace '^mode\s+', '').Trim()
                if ($m -in @('single','batch','binary')) { $mode = $m; Write-Host ('模式已切换: ' + $mode) -ForegroundColor Green }
                else { Write-Host '模式必须是 single|batch|binary' -ForegroundColor Yellow }
                break
            }
            if ($ln -like 'model *') {
                $model = ($ln -replace '^model\s+', '').Trim()
                Write-Host ('模型已切换: ' + $model) -ForegroundColor Green
                break
            }
            if ($ln -like 'file *') {
                $p = ($ln -replace '^file\s+', '').Trim()
                $parts = $p -split '\s+'
                $path = $parts[0]
                if (-not [System.IO.Path]::IsPathRooted($path)) { $path = Join-Path (Get-Location) $path }
                $s = if ($parts.Count -gt 1) { [int]$parts[1] } else { 0 }
                $n = if ($parts.Count -gt 2) { [int]$parts[2] } else { 100000000 }
                if (Test-Path $path) {
                    $txt = [System.IO.File]::ReadAllText($path)
                    if ($s -ge $txt.Length) { Write-Host 'start 超出长度' -ForegroundColor Yellow }
                    else {
                        $seg = $txt.Substring($s, [Math]::Min($n, $txt.Length - $s))
                        Send $seg ('file ' + [System.IO.Path]::GetFileName($path) + ' ' + $s + '+' + $n) | Out-Null
                    }
                } else {
                    Write-Host ('文件不存在: ' + $path) -ForegroundColor Yellow
                }
                break
            }
        }

        if ($mode -eq 'binary') {
            if ($ln -eq 'END' -or $ln -eq 'end') { $action = 'send'; break }
            $lines.Add($ln)
        } else {
            if ($ln -eq 'END' -or $ln -eq 'end') { break }
            $lines.Add($ln)
            $action = 'send'
            break
        }
    }

    if ($action -ne 'send' -or $lines.Count -eq 0) { continue }

    $text = $lines -join "`n"
    switch ($mode) {
        'single' {
            Send $text 'single' | Out-Null
        }
        'batch' {
            $words = @($text -split '\s+' | Where-Object { $_ -ne '' })
            Write-Host ('批量：' + $words.Count + ' 个词') -ForegroundColor DarkCyan
            foreach ($w in $words) { Send $w 'batch' | Out-Null }
        }
        'binary' {
            $script:binHits.Clear()
            $script:binContexts.Clear()
            Write-Host ('二分：初始长度 ' + $text.Length) -ForegroundColor DarkCyan
            Invoke-Binary $text 0 | Out-Null
            Show-BinarySummary
        }
    }
}