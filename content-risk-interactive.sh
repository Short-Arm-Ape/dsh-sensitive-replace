#!/usr/bin/env bash
# content-risk-interactive.sh —— 交互式 Content Exists Risk 触发测试器（Linux / macOS 版）
#
# 与仓库根目录的 content-risk-interactive.ps1 功能对齐：single / batch / binary 三种模式，
# binary 命中后自动二分 + 边界重定位，把一段长文收敛到最小触发片段。
# 用途：找出到底是哪些字符让 DeepSeek 官方 API 返回 400 Content Exists Risk，
#       从而把最小片段填进 $DSH_HOME/sensitive-blocklist.yaml。
#
# 依赖：bash 4+、curl。不需要 jq / python。
# 安全：不内置任何屏蔽词；API key 只从 $DSK_PROBE_KEY 或终端输入取，不落盘、不进命令行参数。
#
# 退出码（非交互模式）：0 = 请求成功(200)；2 = 触发 400；3 = 网络/其它失败；4 = 用法或 key 缺失。
set -uo pipefail

VERSION='1.0'
PROVIDER='deepseek'
PROVIDER_FROM_FLAG=0
ENDPOINT=''
MODEL=''
KEY="${DSK_PROBE_KEY:-}"
ONE_TEXT=''
BATCH_TEXT=''
FILE_PATH=''
FILE_START=0
FILE_COUNT=''
NONINTERACTIVE=0

usage() {
    sed -n '3,14p' "$0" | sed 's/^# \{0,1\}//'
    cat <<'EOF'

用法：
  content-risk-interactive.sh [选项]

选项（不给 -t/-T/-f 就进交互模式）：
  -p PROVIDER   deepseek | openai | custom（默认 deepseek）
  -e ENDPOINT   自定义 endpoint（覆盖 -p，用于自建/代理地址）
  -m MODEL      模型名（deepseek 默认 deepseek-flash；openai 默认 gpt-4o-mini；custom 必填）
  -t TEXT       非交互：发一段文本
  -T WORDS      非交互：批量模式，按空白分词逐个发
  -f FILE       非交互：发文件内容（配 -s 起始偏移、-n 长度）
  -s N          文件起始偏移（默认 0，单位与 bash 的字符串下标一致）
  -n N          文件发送长度（默认整篇）
  -b            二分模式：对 -t / -T / -f 的内容做二分 + 边界重定位（仅在非交互模式下有效）
  -k KEY        直接用这个 key（⚠ 会留在 shell 历史/ps 里，建议改用环境变量 $DSK_PROBE_KEY）
  -h            显示本帮助

环境变量：
  DSK_PROBE_KEY    API key（优先于交互式输入）
  DSK_PROBE_MODEL  模型名（等价于 -m）

交互模式命令：
  mode single|batch|binary   切换模式
  model <名>                 切换模型
  file <路径> [起始] [长度]   发送文件切片
  h / help                   帮助
  q / quit                   退出

模式说明：
  single  单词模式：输入一个词，回车即发送
  batch   批量模式：输入一行，按空格分词，逐个发送
  binary  二分模式：多行输入，单独一行 END 提交；命中后自动二分 + 边界重定位

示例：
  export DSK_PROBE_KEY=sk-...
  ./content-risk-interactive.sh -m deepseek-flash -t '待测文本'
  ./content-risk-interactive.sh -m deepseek-flash -b -t '一段很长的、可能触发的文本'
  ./content-risk-interactive.sh -m deepseek-flash -f ./可疑摘录.txt
EOF
}

# ── 参数解析 ────────────────────────────────────────────────────────────────
BINARY=0
while getopts ':p:e:m:t:T:f:s:n:k:bh' opt; do
    case "$opt" in
        p) PROVIDER="$OPTARG"; PROVIDER_FROM_FLAG=1 ;;
        e) ENDPOINT="$OPTARG"; _CRI_E_GIVEN=1 ;;
        m) MODEL="$OPTARG" ;;
        t) ONE_TEXT="$OPTARG"; NONINTERACTIVE=1 ;;
        T) BATCH_TEXT="$OPTARG"; NONINTERACTIVE=1 ;;
        f) FILE_PATH="$OPTARG"; NONINTERACTIVE=1 ;;
        s) FILE_START="$OPTARG" ;;
        n) FILE_COUNT="$OPTARG" ;;
        b) BINARY=1 ;;
        k) KEY="$OPTARG"; printf '⚠ -k 会把 key 留在 shell 历史与 ps 输出里，建议改用 $DSK_PROBE_KEY\n' >&2 ;;
        h) usage; exit 0 ;;
        :) printf '选项 -%s 需要参数\n\n' "$OPTARG" >&2; usage >&2; exit 4 ;;
        \?) printf '未知选项 -%s\n\n' "$OPTARG" >&2; usage >&2; exit 4 ;;
    esac
done

case "$PROVIDER" in
    deepseek)
        [ -n "$ENDPOINT" ] || ENDPOINT='https://api.deepseek.com/chat/completions'
        [ -n "$MODEL" ] || MODEL="${DSK_PROBE_MODEL:-deepseek-flash}"
        LABEL='deepseek'
        ;;
    openai)
        [ -n "$ENDPOINT" ] || ENDPOINT='https://api.openai.com/v1/chat/completions'
        [ -n "$MODEL" ] || MODEL="${DSK_PROBE_MODEL:-gpt-4o-mini}"
        LABEL='openai'
        ;;
    custom)
        LABEL='custom'
        [ -n "$MODEL" ] || MODEL="${DSK_PROBE_MODEL:-}"
        [ -n "$ENDPOINT" ] || { printf 'custom 需要 -e ENDPOINT\n' >&2; exit 4; }
        [ -n "$MODEL" ] || { printf 'custom 需要 -m MODEL\n' >&2; exit 4; }
        ;;
    *) printf '未知 provider: %s（可选 deepseek / openai / custom）\n' "$PROVIDER" >&2; exit 4 ;;
esac
# 只给了 -e（自建/代理地址）而没点名 provider 时，横幅按 custom 显示，避免误标成 deepseek
if [ "$PROVIDER_FROM_FLAG" -eq 0 ] && [ -n "$ENDPOINT" ] && [ "$PROVIDER" = 'deepseek' ] && [ -n "${_CRI_E_GIVEN:-}" ]; then
    LABEL='custom'
fi
[ -n "$MODEL" ] || MODEL="${DSK_PROBE_MODEL:-}"
[ -n "$MODEL" ] || { printf '缺少模型名（-m 或 $DSK_PROBE_MODEL）\n' >&2; exit 4; }
command -v curl >/dev/null 2>&1 || { printf '需要 curl\n' >&2; exit 4; }

# key：环境变量 → 终端输入（不落盘）
if [ -z "$KEY" ]; then
    if [ -r /dev/tty ]; then
        read -rsp '请输入 API key（不会回显、不落盘）: ' KEY </dev/tty || KEY=''
        printf '\n' >&2
    else
        read -rsp '请输入 API key: ' KEY || KEY=''
    fi
fi
[ -n "$KEY" ] || { printf '缺少 API key（$DSK_PROBE_KEY 或交互式输入）\n' >&2; exit 4; }

# 颜色只在终端上开（重定向到文件/管道时不污染输出）
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    C_RED=$'\033[31m'; C_YELLOW=$'\033[33m'; C_MAGENTA=$'\033[35m'; C_OFF=$'\033[0m'
else
    C_RED=''; C_YELLOW=''; C_MAGENTA=''; C_OFF=''
fi

TMPDIR_LOCAL=$(mktemp -d) || exit 3
trap 'rm -rf "$TMPDIR_LOCAL"' EXIT
BODY_FILE="$TMPDIR_LOCAL/req.json"
OUT_FILE="$TMPDIR_LOCAL/resp.json"

# ── 多字节处理：优先让 ${#s} / ${s:off:len} 按字符算，否则退化为字节并对齐到字符边界 ──
MB_TEST=$(printf '\xe6\xb5\x8b')   # “测”
MB_CHARS=0
if [ "${#MB_TEST}" -eq 1 ]; then
    MB_CHARS=1
else
    # 当前 locale 不是多字节：尝试用 UTF-8 locale 重跑一次自己
    if [ -z "${_CRI_REEXEC:-}" ]; then
        for loc in C.UTF-8 en_US.UTF-8 zh_CN.UTF-8 C.utf8; do
            if [ "$(LC_ALL=$loc bash -c 'printf %s "${#1}"' _ "$MB_TEST" 2>/dev/null)" = 1 ]; then
                _CRI_REEXEC=1 LC_ALL=$loc exec bash "$0" "$@"
            fi
        done
    fi
fi

if [ "$MB_CHARS" -eq 0 ]; then
    printf '提示：当前 locale 不是 UTF-8（%s），长度按字节计；切片已做字符边界对齐，不会发出半个字符。\n' \
        "${LC_ALL:-${LANG:-未设置}}" >&2
fi

# 字节模式下把偏移回退到 UTF-8 字符边界（避免切出半个字符 → 请求里出现非法 UTF-8 → 假 400）
align_offset() {    local s=$1 off=$2
    if [ "$MB_CHARS" -eq 1 ] || [ "$off" -le 0 ]; then
        printf '%s' "$off"
        return
    fi
    if ! command -v iconv >/dev/null 2>&1; then
        printf '%s' "$off"
        return
    fi
    while [ "$off" -gt 0 ]; do
        if printf '%s' "${s:0:$off}" | iconv -f UTF-8 -t UTF-8 >/dev/null 2>&1; then
            break
        fi
        off=$((off - 1))
    done
    printf '%s' "$off"
}

# 切一段文本（start 为字符/字节下标，len 省略＝到末尾），两端都对齐到字符边界
slice_text() {
    local s=$1 st=$2 ln=${3-}
    local a b
    a=$(align_offset "$s" "$st")
    if [ -n "$ln" ]; then
        b=$(align_offset "$s" $((a + ln)))
        [ "$b" -lt "$a" ] && b=$a
        printf '%s' "${s:a:$((b - a))}"
    else
        printf '%s' "${s:a}"
    fi
}

# ── JSON 转义（只针对个别字符，其余字节原样保留，中文/emoji 不受影响）────────
json_escape() {
    local s=$1
    s=${s//\\/\\\\}
    s=${s//\"/\\\"}
    s=${s//$'\n'/\\n}
    s=${s//$'\r'/\\r}
    s=${s//$'\t'/\\t}
    printf '%s' "$s"
}

LAST_CODE='000'
LAST_MSG=''
ANY_400=0

extract_msg() {
    local msg
    msg=$(grep -o '"message"[[:space:]]*:[[:space:]]*"[^"]*"' "$1" 2>/dev/null | head -1 |
        sed -e 's/^"message"[[:space:]]*:[[:space:]]*"//' -e 's/"$//')
    [ -n "$msg" ] || msg='(unparsed body)'
    printf '%s' "$msg"
}

# ── 发送一次 ────────────────────────────────────────────────────────────────
send() {
    local text=$1 label=$2
    printf '{"model":"%s","messages":[{"role":"user","content":"%s"}],"max_tokens":1,"stream":false}' \
        "$(json_escape "$MODEL")" "$(json_escape "$text")" >"$BODY_FILE"
    LAST_CODE=$(curl -sS -m 30 -o "$OUT_FILE" -w '%{http_code}' -X POST "$ENDPOINT" \
        -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
        --data-binary "@$BODY_FILE" 2>/dev/null)
    [ -n "$LAST_CODE" ] || LAST_CODE='000'
    if [ "$LAST_CODE" = '200' ]; then
        LAST_MSG='OK'
        printf '[%s | chars=%d] HTTP %s | %s\n' "$label" "${#text}" "$LAST_CODE" "$LAST_MSG"
    else
        [ "$LAST_CODE" = '400' ] && ANY_400=1
        LAST_MSG=$(extract_msg "$OUT_FILE")
        if [ "$LAST_CODE" = '400' ]; then
            printf '%s[%s | chars=%d] HTTP %s | %s%s\n' "$C_RED" "$label" "${#text}" "$LAST_CODE" "$LAST_MSG" "$C_OFF"
        else
            printf '[%s | chars=%d] HTTP %s | %s\n' "$label" "${#text}" "$LAST_CODE" "$LAST_MSG"
        fi
    fi
}

# ── 二分 ────────────────────────────────────────────────────────────────────
BIN_HITS=()
BIN_CTXS=()
MAX_DEPTH=24
HALF_L=''
HALF_R=''

# 分成两半：≥2 个词按词分（重建时用单空格连接），否则按下标从中间切
get_half() {
    local text=$1
    local -a words=()
    read -r -a words <<<"$text"
    if [ "${#words[@]}" -ge 2 ]; then
        local mid=$((${#words[@]} / 2))
        HALF_L="${words[*]:0:mid}"
        HALF_R="${words[*]:mid}"
        return 0
    fi
    local n=${#text}
    if [ "$n" -ge 2 ]; then
        local mid=$((n / 2))
        local off
        off=$(align_offset "$text" "$mid")
        [ "$off" -lt 1 ] && off=1
        HALF_L=$(slice_text "$text" 0 "$off")
        HALF_R=$(slice_text "$text" "$off")
        return 0
    fi
    return 1
}

resolve_boundary() {
    local parent=$1 left=$2 depth=$3
    local n=${#parent} k=${#left}
    printf '  ↻ 两半均过 → 边界重定位 (k=%d, len=%d)\n' "$k" "$n"

    local right_m=-1 d=1 m
    while :; do
        m=$((k + d))
        [ "$m" -gt "$n" ] && m=$n
        [ "$m" -le "$k" ] && break
        send "$(slice_text "$parent" 0 "$m")" "posR+$d"
        if [ "$LAST_CODE" = '400' ]; then right_m=$m; break; fi
        [ "$m" -eq "$n" ] && break
        d=$((d * 2))
    done

    local left_l=-1 d2=1 l
    while :; do
        l=$((k - d2))
        [ "$l" -lt 0 ] && l=0
        send "$(slice_text "$parent" "$l")" "posL-$d2"
        if [ "$LAST_CODE" = '400' ]; then left_l=$l; break; fi
        [ "$l" -eq 0 ] && break
        d2=$((d2 * 2))
    done

    # 边界扫描的真实下标（对齐后可能与上面记录的略有出入）
    local r_aligned='' l_aligned=''
    [ "$right_m" -ge 0 ] && r_aligned=$(align_offset "$parent" "$right_m")
    [ "$left_l" -ge 0 ] && l_aligned=$(align_offset "$parent" "$left_l")

    local slice='' desc=''
    if [ -n "$r_aligned" ] && [ -n "$l_aligned" ] && [ "$l_aligned" -lt "$r_aligned" ] &&
        { [ "$l_aligned" -gt 0 ] || [ "$r_aligned" -lt "$n" ]; }; then
        slice=$(slice_text "$parent" "$l_aligned" $((r_aligned - l_aligned)))
        desc="交集 [$l_aligned,$r_aligned)"
    fi
    if [ -z "$slice" ] && [ -n "$r_aligned" ] && [ "$r_aligned" -lt "$n" ]; then
        slice=$(slice_text "$parent" 0 "$r_aligned")
        desc="前缀 [0,$r_aligned)"
    fi
    if [ -z "$slice" ] && [ -n "$l_aligned" ] && [ "$l_aligned" -gt 0 ]; then
        slice=$(slice_text "$parent" "$l_aligned")
        desc="后缀 [$l_aligned,$n)"
    fi

    if [ -z "$slice" ]; then
        # 走到这里说明「指数量级的边界扫描」没找到更小的连续片段。
        # 补两个决定性探测：长度 n-1 的前缀与后缀。
        #   若更短的连续片段 W 能触发，则 W 必然整体落在其中一个 n-1 窗口里
        #   （W 不可能同时含首尾字符），而触发对超集是单调的 ⇒ 那个窗口必然也触发。
        #   两个都不触发 ⇒ 不存在更短的连续触发片段，「整段」就是最小连续片段。
        if [ "$n" -ge 2 ]; then
            local pfx sfx
            pfx=$(slice_text "$parent" 0 $((n - 1)))
            send "$pfx" 'shrink-prefix'
            if [ "$LAST_CODE" = '400' ]; then invoke_binary "$pfx" $((depth + 1)); return 0; fi
            sfx=$(slice_text "$parent" 1)
            send "$sfx" 'shrink-suffix'
            if [ "$LAST_CODE" = '400' ]; then invoke_binary "$sfx" $((depth + 1)); return 0; fi
            # 再分机制：删掉中间一个字符后仍触发 ⇒ 是两个分离片段共同作用；
            # 删掉就不触发 ⇒ 整段字符缺一不可（最小连续片段就是整段）。
            local mid=$((n / 2))
            local mutant
            mutant="$(slice_text "$parent" 0 "$mid")$(slice_text "$parent" $((mid + 1)))"
            send "$mutant" 'middle-delete'
            if [ "$LAST_CODE" = '400' ]; then
                printf '  %s>>> 上下文组合触发（两个分离片段共同作用）: [%s]%s\n' "$C_MAGENTA" "$parent" "$C_OFF"
                BIN_CTXS+=("$parent")
            else
                printf '  %s>>> 最小连续片段（整段字符缺一不可）: [%s]%s\n' "$C_YELLOW" "$parent" "$C_OFF"
                BIN_HITS+=("$parent")
            fi
        else
            printf '  %s>>> 命中: [%s]%s\n' "$C_YELLOW" "$parent" "$C_OFF"
            BIN_HITS+=("$parent")
        fi
        return 0
    fi
    printf '  重定位到 %s (len=%d)\n' "$desc" "${#slice}"
    invoke_binary "$slice" $((depth + 1))
    return 0
}

# 返回 0 = 命中（400），1 = 未命中
invoke_binary() {
    local text=$1 depth=${2:-0}
    if [ "$depth" -gt "$MAX_DEPTH" ]; then
        printf '  (深度超限，停止)\n'
        return 1
    fi
    send "$text" "binary d$depth"
    [ "$LAST_CODE" = '400' ] || return 1

    if ! get_half "$text"; then
        printf '  %s>>> 命中: [%s]%s\n' "$C_YELLOW" "$text" "$C_OFF"
        BIN_HITS+=("$text")
        return 0
    fi
    local l=$HALF_L r=$HALF_R
    if invoke_binary "$l" $((depth + 1)); then return 0; fi
    if invoke_binary "$r" $((depth + 1)); then return 0; fi
    resolve_boundary "$text" "$l" "$depth"
    return 0
}

show_binary_summary() {
    printf '\n================ 二分结果汇总 ================\n'
    if [ "${#BIN_HITS[@]}" -eq 0 ] && [ "${#BIN_CTXS[@]}" -eq 0 ]; then
        printf '  未发现任何命中。\n'
    else
        local i t disp
        if [ "${#BIN_HITS[@]}" -gt 0 ]; then
            printf '命中片段 (%d 个):\n' "${#BIN_HITS[@]}"
            for i in "${!BIN_HITS[@]}"; do
                t=${BIN_HITS[$i]}
                if [ "${#t}" -le 100 ]; then disp=$t; else disp="$(slice_text "$t" 0 100)..."; fi
                disp=${disp//$'\n'/ /}
                printf '  [%d] len=%d  %s\n' "$((i + 1))" "${#t}" "$disp"
            done
        fi
        if [ "${#BIN_CTXS[@]}" -gt 0 ]; then
            printf '上下文组合触发 (%d 个):\n' "${#BIN_CTXS[@]}"
            for i in "${!BIN_CTXS[@]}"; do
                t=${BIN_CTXS[$i]}
                if [ "${#t}" -le 100 ]; then disp=$t; else disp="$(slice_text "$t" 0 100)..."; fi
                disp=${disp//$'\n'/ /}
                printf '  [%d] len=%d  %s\n' "$((i + 1))" "${#t}" "$disp"
            done
        fi
    fi
    printf '==============================================\n'
}

run_batch() {
    local text=$1
    local -a words=()
    read -r -a words <<<"$text"
    printf '批量：%d 个词\n' "${#words[@]}"
    local w
    for w in "${words[@]}"; do send "$w" 'batch'; done
}

# ── 非交互：一次跑完 ────────────────────────────────────────────────────────
if [ "$NONINTERACTIVE" -eq 1 ]; then
    INPUT_TEXT="$ONE_TEXT"
    if [ -n "$FILE_PATH" ]; then
        [ -r "$FILE_PATH" ] || { printf '读不到文件: %s\n' "$FILE_PATH" >&2; exit 4; }
        FILE_CONTENT=$(cat "$FILE_PATH")
        if [ -n "$FILE_COUNT" ]; then
            INPUT_TEXT=$(slice_text "$FILE_CONTENT" "$FILE_START" "$FILE_COUNT")
        else
            INPUT_TEXT=$(slice_text "$FILE_CONTENT" "$FILE_START")
        fi
        LABEL_TXT="file $(basename "$FILE_PATH") $FILE_START+${FILE_COUNT:-all}"
    else
        LABEL_TXT='single'
    fi
    printf '已连接: %s | 模型: %s | endpoint: %s\n' "$LABEL" "$MODEL" "$ENDPOINT" >&2

    if [ -n "$BATCH_TEXT" ]; then
        run_batch "$BATCH_TEXT"
        [ "$ANY_400" -eq 1 ] && exit 2
        [ "$LAST_CODE" = '200' ] && exit 0
        exit 3
    fi
    if [ "$BINARY" -eq 1 ]; then
        [ -n "$INPUT_TEXT" ] || { printf '二分模式需要 -t/-T/-f 提供内容\n' >&2; exit 4; }
        BIN_HITS=(); BIN_CTXS=()
        printf '二分：初始长度 %d\n' "${#INPUT_TEXT}"
        invoke_binary "$INPUT_TEXT" 0
        show_binary_summary
        if [ "${#BIN_HITS[@]}" -gt 0 ] || [ "${#BIN_CTXS[@]}" -gt 0 ]; then exit 2; fi
        [ "$LAST_CODE" = '200' ] && exit 0
        exit 3
    fi
    send "$INPUT_TEXT" "$LABEL_TXT"
    [ "$ANY_400" -eq 1 ] && exit 2
    [ "$LAST_CODE" = '200' ] && exit 0
    exit 3
fi

# ── 交互模式 ────────────────────────────────────────────────────────────────
show_help() {
    cat <<'EOF'
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
EOF
}

show_status() {
    printf '\n[%s | %s @ %s]\n' "$MODE" "$MODEL" "$LABEL"
    if [ "$MODE" = 'binary' ]; then
        printf '  多行输入，单独一行 END 提交 | 命令：mode/model/file/h/q\n'
    else
        printf '  输入后回车即发送 | 命令：mode/model/file/h/q\n'
    fi
}

MODE='single'
printf '\n已连接: %s | 模型: %s | 初始模式: %s\n' "$LABEL" "$MODEL" "$MODE"

while :; do
    show_status
    LINES=()
    ACTION='cmd'
    while :; do
        if ! IFS= read -r ln; then
            printf 'bye\n'
            exit 0
        fi
        if [ "$ln" = 'q' ] || [ "$ln" = 'quit' ]; then
            printf 'bye\n'
            exit 0
        fi
        if [ "${#LINES[@]}" -eq 0 ]; then
            case "$ln" in
                h | help) show_help; break ;;
                '') break ;;
                mode\ *)
                    m=${ln#mode }
                    m=${m#"${m%%[![:space:]]*}"}
                    case "$m" in
                        single | batch | binary) MODE="$m"; printf '模式已切换: %s\n' "$MODE" ;;
                        *) printf '模式必须是 single|batch|binary\n' ;;
                    esac
                    break
                    ;;
                model\ *)
                    MODEL=${ln#model }
                    MODEL=${MODEL#"${MODEL%%[![:space:]]*}"}
                    printf '模型已切换: %s\n' "$MODEL"
                    break
                    ;;
                file\ *)
                    rest=${ln#file }
                    rest=${rest#"${rest%%[![:space:]]*}"}
                    # shellcheck disable=SC2086
                    set -- $rest
                    fpath=$1
                    fstart=${2:-0}
                    fcount=${3:-}
                    [ -r "$fpath" ] || { printf '文件不存在或不可读: %s\n' "$fpath"; break; }
                    content=$(cat "$fpath")
                    if [ -n "$fcount" ]; then
                        seg=$(slice_text "$content" "$fstart" "$fcount")
                    else
                        seg=$(slice_text "$content" "$fstart")
                    fi
                    send "$seg" "file $(basename "$fpath") $fstart+${fcount:-all}"
                    break
                    ;;
            esac
        fi
        if [ "$MODE" = 'binary' ]; then
            if [ "$ln" = 'END' ] || [ "$ln" = 'end' ]; then
                ACTION='send'
                break
            fi
            LINES+=("$ln")
        else
            if [ "$ln" = 'END' ] || [ "$ln" = 'end' ]; then break; fi
            LINES+=("$ln")
            ACTION='send'
            break
        fi
    done
    [ "$ACTION" = 'send' ] || continue
    [ "${#LINES[@]}" -eq 0 ] && continue
    text=$(printf '%s\n' "${LINES[@]}")
    text=${text%$'\n'}
    case "$MODE" in
        single) send "$text" 'single' ;;
        batch) run_batch "$text" ;;
        binary)
            BIN_HITS=()
            BIN_CTXS=()
            printf '二分：初始长度 %d\n' "${#text}"
            invoke_binary "$text" 0
            show_binary_summary
            ;;
    esac
done
