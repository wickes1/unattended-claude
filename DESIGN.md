# unattended-claude — v2 設計

> 本文是 2026-05-23 grill-me session 凝結出的 single source of truth。寫 v2 前先讀。
> v1 設計參考:[`../cc-nightshift/docs/architecture.md`](../cc-nightshift/docs/architecture.md)
> v1 的角色:reference-only,不再 active 開發,留作參考 + 部分 code 直接搬。

---

## 一、定位 / 北極星

**Demand shifting** —— 把可背景化的 task,從你 active 的 5-hour window 移到你 off-hours 的 5-hour window。像智能電網把洗衣機排到離峰時段;同樣的 quota 預算,搬到你不用的窗口,讓 active 時段的 quota 留給你自己。

### 明確否定的方向

| ❌ 不是 | 為何不 |
|---|---|
| 「用盡 token」當 metric | Goodhart's Law:獎勵浪費,獎勵冗長 reasoning / 重試 |
| AI 自主從 bookmark/email/matrix 找事做 | 你不缺 task,缺 window;自主找事 scope 爆 + 風險高 |
| 真常駐執行 worker | active 時必須讓出 quota,本質必然 episodic |
| 抽 plugin / multi-driver 系統 | 單人單 driver,YAGNI;將來換 LLM 時 rename + rewrite 解析層即可 |
| 自動偵測 user idle 來觸發 / 停止 | macOS idle detection 不可靠,失敗模式可怕 |

---

## 二、執行模型

**常駐 state + episodic execution**

| 永遠存在 | 只在 run 啟動到 stop 之間存在 |
|---|---|
| `~/unattended/` 內全部資料(`tasks/`, `todo.md`, `state/`, `archive/`, `workdirs/`)| zellij session(name = `unattended-claude`)|
| `~/.config/unattended-claude/cc.yaml` | 各 task 的 zellij tab |
| `~/.claude/projects/<...>/<uuid>.jsonl` 對話歷史 | 各 task 的 claude 進程 |
| 排程的 launchd plist | — |

**Window 邊界**:`run` 啟動時帶 `--until HH:MM`(手動指定或 schedule 自動傳)。到點 → graceful pause 所有 in-flight task → 銷毀 zellij session。下個 window `run` 啟動時,自動 resume paused task。

---

## 三、目錄結構

### Repo(code)

```
Workshop/unattended-claude/unattended-claude/   ← 新 v2 repo
├── DESIGN.md                                   ← 本檔
├── README.md                                   ← user-facing
├── src/, tests/, docs/, .claude/skills/
├── package.json, tsconfig.json, bun.lock
└── config/cc.yaml                              ← config template

Workshop/unattended-claude/cc-nightshift/       ← v1,reference-only,不動
```

Workshop 層 dir 之後改名 `Workshop/cc-history/`,避免跟 v2 repo 同名。

### Runtime(資料)

```
~/unattended/
├── todo.md                       rolling inbox + journal
├── tasks/
│   ├── 2026-05-23-01-grep-bench.md       task doc(frontmatter + 描述 + Checklist + SUMMARY)
│   ├── 2026-05-23-02-link-check.md
│   └── ...                                近 7 天 + 進行中 + 未啟動
├── workdirs/
│   └── 2026-05-23-01-grep-bench/         scratch dir(auto-assign 給沒指定 workdir 的 task)
├── archive/
│   └── 2026-05-16-03-old-task/           > 7 天前完成的 self-contained bundle
│       ├── task.md                       原 tasks/<id>.md
│       ├── state.json                    原 state/tasks/<id>.json(最終 snapshot)
│       ├── handoff.md                    原 state/handoffs/<id>.md(若有)
│       └── workdir/                      原 workdirs/<id>/(僅 auto-assign 者)
├── state/
│   ├── events.jsonl                       append-only event log(全 task 共享,SoT)
│   ├── tasks/
│   │   └── <task-id>.json                 per-task 可變狀態(paused_reason / claude_session_id / context_compactions / 當前 episode 數)
│   ├── handoffs/
│   │   └── <task-id>.md                   HANDOFF.md(僅當 context-limit 觸發 compaction 時寫)
│   └── weekly-paused-until.txt            撞 weekly limit 時寫,凍結 schedule 用
└── logs/
    └── <task-id>-<episode-n>.log          每 episode 原始輸出
```

關鍵原則:
- **扁平**,無 batch / 日期目錄
- **三 SoT 分工**:`todo.md`(意圖)/ `state/events.jsonl`(執行歷史,append-only)/ `state/tasks/<id>.json`(當前可變狀態,atomic write)
- `tasks/<id>.md`(task doc)在 plan 階段凍結後**幾乎不改**;done 時只附 SUMMARY 區段。所有運行時可變欄位都在 `state/tasks/<id>.json`,不污染 task doc
- `tasks/` 主目錄只有「近期 + 進行中」< ~20 個
- 7 天後 done/failed 自動搬 `archive/`,可手動 `ucl archive <id>` 覆寫
- Archive 時 task doc + workdir(若有) + `state/tasks/<id>.json` + `state/handoffs/<id>.md`(若有) 一併搬入 `archive/`;`events.jsonl` 不動,跨歷史 timeline 完整

---

## 四、命令

```
ucl init                       一次性 setup(idempotent,可重跑)
ucl plan                       讀 todo.md 新增條目 → 互動釐清 → 凍結成 task doc(走 task-brief skill)
ucl run [--until HH:MM]        啟動 worker,跑到 queue 空 / --until / stop
ucl stop [--now]               graceful pause(--now = hard kill)
ucl schedule add/list/remove/install/uninstall       管理 launchd schedule
ucl status                     queue 快照(無 AI)
ucl stats                      歷史利用率(無 AI,純文字表格)
ucl review                     互動 AI 回顧最近 run(走 task-review skill)
ucl review <id>                印單一 task SUMMARY(無 AI)
ucl review --synthesize --since=24h   產生 markdown 報告檔(取代 OVERNIGHT-REPORT.md 角色)
ucl archive <id>               強制 archive 單一 task
ucl archive --done-before=Nd [--dry-run]   批次 archive
ucl unarchive <id>             逃生口
ucl todo --consolidate         把 todo.md [x] 條目搬到底部 journal section,按日期分組
ucl attach                     接到當前 zellij session(冷時報「目前無 worker」)
```

**配置 fallback**:`--config <path>` flag → `UNATTENDED_CLAUDE_CONFIG` env → `~/.config/unattended-claude/cc.yaml`

---

## 五、Task 生命週期

### State 機

```
inbox       todo.md 內無 [x] 條目          ← 不在 tasks/
planned     task doc 存在,從未啟動
running     有 zellij tab 跑中
paused      有 paused_reason,有 claude_session_id,等下次 resume
done        正常完成
failed      不可救援錯誤
archived    搬到 archive/(state 仍可查)
```

### Transitions

```
inbox    --ucl plan-->                planned
planned  --ucl run picks up-->        running
running  --完成-->                     done
running  --不可救援錯誤-->              failed
running  --window 邊界 / stop / 5h limit / weekly limit / context limit-->   paused
paused   --下次 ucl run-->             running (--resume <uuid>)
done|failed  --7天後 / 手動 archive--> archived
archived --手動 unarchive-->           done|failed
```

### paused_reason 的七種

| reason | 怎麼觸發 | resume 時 wake-up prompt |
|---|---|---|
| `schedule-boundary` | `--until` 到點 | 「時間到了,繼續」 |
| `rate-limit-5h` | claude TUI 顯示「Try again at HH:MM」+ reset > --until | 「現在是 N 小時後,5h limit 已 reset,繼續」 |
| `weekly-limit` | claude TUI 顯示 weekly limit 訊息 | (整個 worker 凍結,不 resume 個別 task)|
| `context-full` | claude TUI 顯示 「Conversation too long」或 jsonl > threshold | (不走 --resume,改新 session + `cat ~/unattended/state/handoffs/<id>.md`)|
| `user-stop` | `ucl stop`(graceful) | 「上次因手動 stop 暫停,繼續」 |
| `user-stop-now` | `ucl stop --now`(hard kill) | 「上次被強制中斷,繼續(若需要請先確認當前狀態)」 |
| `orphan` | 啟動 preflight 偵測到「state 標 `running` 但無對應 tab」(機器 reboot / 進程被 kill) | 「上次被意外中斷(機器 reboot 或進程死),繼續(請先確認當前狀態)」 |

---

## 六、Window / Schedule

### Schedule 語法(YAML config)

```yaml
schedule:
  windows:
    - { start: "22:30", end: "06:30", days: [mon, tue, wed, thu, fri, sat, sun] }
    - { start: "12:30", end: "13:45", days: [mon, tue, wed, thu, fri] }   # 午餐 window
```

### 實作

`ucl schedule install` 把每個 window 轉成 launchd plist(macOS native):
- start 時觸發 `ucl run --until=<end>`
- end 由 worker 自己根據 `--until` 判,不需另 plist

`ucl schedule uninstall` 移除全部 plist。

**Schedule 觸發時的 preflight**:`ucl run`(無論手動或 plist 觸發)啟動前檢查:
1. `state/weekly-paused-until.txt` 還有效 → 印警告 + exit 0(不算錯,只是跳過)
2. 已有 worker 在跑(zellij session 已存在或 in-flight task 標 `running`)→ 印警告 + exit 0
3. 重啟後遺留的 `running` task 但沒對應 tab → 標記為 `paused-orphan`(視為 user-stop-now),進入正常 resume 流程

### Wind-down(window 邊界處理)

T-5min(可 config `execution.wind_down_lead_minutes`):

```
注入文字 prompt 到每個 in-flight tab:
「⏰ Schedule window 在 5 分鐘後結束(<end>)。請完成你目前正在做的最小單元
 (編輯中的 file、跑到一半的 test),不要再展開新的大工作。完成後停下等候即可
 —— 我會在 <end> 關閉這個 session,下次 resume 時你的對話歷史會完整接續。」
```

T-0:
- worker → zellij close-tab(graceful:先 `/quit`,5 秒後 force kill)
- 各 task 的 `state/tasks/<id>.json` 寫入 `paused_reason: "schedule-boundary"`
- `claude_session_id` 早已寫好(launch 時 pre-generate UUID 帶 `--session-id`,寫進同一檔)
- zellij session 整個銷毀

Worker **不檢測** AI 是否已走到 idle,只負責「注入訊息 + 到點關」。wind-down 是禮貌,不是契約。

---

## 七、跨 Window 接續

### Pre-gen UUID + `--resume`(主路徑,95% 情境)

```bash
# Task 第一次啟動
TASK_UUID=$(uuidgen)                          # worker 自己 pre-gen
# 寫 task state.json: claude_session_id = $TASK_UUID
happy --dangerously-skip-permissions --session-id "$TASK_UUID"

# 下個 window resume
happy --dangerously-skip-permissions --resume "$TASK_UUID"
# resume 後注入 wake-up prompt(視 paused_reason 而定)
```

**好處**:零 polling、零 race condition、原子記錄 session ID。對話歷史完整保留,AI 看自己歷史就懂,不浪費 token 重建 context。

### HANDOFF.md(context-limit 退路,< 5% 情境)

當 claude TUI 觸發 context-limit detector(reactive only — `matchContextLimit` 抓「Conversation too long」訊息;proactive jsonl-size 監測 v2 不做)時:

```
worker 注入特殊 prompt:
「請寫一份 HANDOFF.md 蓋掉 ~/unattended/state/handoffs/<task-id>.md,
 涵蓋:已完成 / 進行中 / 下一步。寫完後停下,我會關閉這個 session。」

→ AI 寫 → graceful pause → state/tasks/<id>.json:
                            paused_reason = "context-full"
                            context_compactions++

下個 resume 時:
- 不用 --resume(會載入舊歷史,沒意義)
- 新 session(新的 pre-gen UUID,更新 state/tasks/<id>.json.claude_session_id),
  第一輪 prompt = `cat ~/unattended/state/handoffs/<task-id>.md`
```

**HANDOFF 觸發條件**:
- claude TUI 顯示「Conversation too long」訊息(reactive only)
- proactive jsonl-size 監測沒做(YAGNI;見 §十六)

絕大多數 task(短期、目標明確)永遠不會撞到。長 task(6+ 小時)會。

---

## 八、Limit 處理矩陣

| Limit | 觸發 | Worker 行為 |
|---|---|---|
| **5-hour rolling** | TUI「Try again at HH:MM」 | 解析 reset → 對比 `--until`:reset ≤ 邊界 → sleep 到 reset 再 `--resume`;reset > 邊界 → 立即 graceful pause,標 `paused-rate-limit-5h`,下個 window resume |
| **7-day weekly** | TUI weekly limit 訊息(格式待實測) | 解析 reset(可能幾天後)→ 寫 `state/weekly-paused-until.txt` → graceful pause 全部 task → **凍結所有 future scheduled `run`** 直到 reset。`ucl run` preflight 檢查此檔,凍結期內 refuse + 印警告 |
| **Context (~200K)** | TUI「Conversation too long」(reactive only) | HANDOFF.md 壓縮路徑;`state/tasks/<id>.json` 的 `context_compactions` 累加 |

---

## 九、Parallelism

**規則**:不同 workdir 並行(各佔一 tab),同 workdir 序列(同一 lane)。**有上限** `runtime.max_parallel_tabs`(預設 3)。

```
有效並行 = min(unique_workdirs_of_pending_tasks, max_parallel_tabs)
```

### 例外:`serial: true`

task frontmatter 可設 `serial: true` —— 此 task 跑時不開新 tab,worker 等其他 tab 都空才啟動它。給罕見場景(全 repo 重構、heavy git operations、會動 system config 的 task)。

### Workdir 預設規則

| Task 性質 | workdir |
|---|---|
| 用戶 task doc 明確指定 `workdir: /path/to/existing/repo` | 用指定路徑 |
| 用戶要求新建一個獨立 repo / project | plan 階段 AI 問用戶位置(預設提議 `~/unattended/workdirs/<task-id>/`)|
| 純 research / 抽資料 / 寫筆記,不需要特定位置 | 自動分 `~/unattended/workdirs/<task-id>/`(每 task unique → 自動進不同 lane)|

**禁止**:預設 `$HOME` —— 會造成 task 間衝突 + 污染 home。

### 超 cap 處理

超出 max_parallel_tabs 的 task 排隊,某 tab 結束才補一個進來。`state/events.jsonl` 寫 `queued_due_to_concurrency_cap` 事件,`ucl status` 顯示原因。

---

## 十、`plan` 生命週期

### todo.md 是 rolling inbox + journal

```markdown
- [x] 修 link checker → tasks/2026-05-23-01
- [x] grep bench 對比 → tasks/2026-05-23-02
- 想學 rust async(不急)         <!-- AI plan 時你說 skip,保持無 checkbox -->
- 新加的 todo                    <!-- 下次 plan 處理 -->
```

### plan 規則

- 只看「沒 [x] + 沒被標 skip」的條目
- 互動式 grilling(`task-brief` skill 接管),逐項問:scope / workdir / 成功標準 / 需要的 context
- 凍結成 `tasks/YYYY-MM-DD-NN-slug.md`,todo.md 對應條目加 [x] + 任務連結
- 已 [x] 的條目永遠不再被動(即使你改了文字)
- 重 plan(scope 變了)→ 你自己手動拿掉 [x]
- 不想 action(brain dump)→ skip 後條目維持原樣,plan 不會重複問

### 執行環境

`ucl plan` 在**前景終端**開一個互動 claude session(不進 zellij),你在當前 shell 跟 AI 對話。完成後 claude 退出,回到 shell。同理 `ucl review`(互動式)。

只有 `ucl run` 才開 zellij session,因為要 headless + 多 tab + program-control。

### Plan / Run 衝突

`ucl plan` preflight 檢查 worker 是否 `running`,若是 → refuse:

```
Error: worker is running (3 tasks in flight).
Run `ucl stop` first, then `ucl plan`.
```

逃生口:`ucl plan --force` 跳過 preflight。

### todo.md consolidate

`ucl todo --consolidate`:
- 把所有 [x] 條目移到底部 `## ── 已 plan 線 ──` 之下
- 按日期分組
- 純手動,不自動 —— journal 性質的整理是你的事

---

## 十一、Skills

| Skill | 觸發 | 改動 |
|---|---|---|
| `task-brief`(was `bedtime-brief`)| `ucl plan` | 改名,內容微改 |
| `task-review`(was `morning-review`)| `ucl review` | 改名,內容微改 |
| ~~`overnight-synthesis`~~ | ❌ 刪除 | 改 `ucl review --synthesize` on-demand |

Skill 隨 repo 在 `Workshop/unattended-claude/unattended-claude/.claude/skills/`(repo-local,**不**裝到 user-global `~/.claude/skills/`)。`ucl plan` / `ucl review` 互動 claude 啟動時 cwd 設為 v2 repo root,使 skill 自動載入。

---

## 十二、觀察類命令切法

### `ucl status` — queue 快照(無 AI)

```
planned: 3, running: 2, paused: 1, done(last 7d): 12

In-flight:
  [tab 1] 2026-05-23-01-grep-bench       running 1h23m   last screen update 12s ago
  [tab 2] 2026-05-23-02-link-check       running 47m     waiting for AI response (idle 30s)
Paused:
  [-]     2026-05-23-03-refactor         paused-context-full   3 compactions
Cap: 3/3 used
```

### `ucl stats` — 歷史利用率(無 AI,純文字)

```
Last 7 days:
  Day        Tasks(✓/✗)    Token usage   5h-windows hit limit
  2026-05-23   3/0          73,200        0/1
  2026-05-22   5/1          187,400       2/2
  2026-05-21   2/0          41,100        0/1
  ...

Subscription utilization: 67% (weekly)
```

數據來源:`state/events.jsonl` 的 `usage_snapshot` 事件,worker 每個 episode 結束後讀 claude jsonl 累計 token 寫入。

### `ucl review` — 互動 AI

預設 context = 最近一次 `run` window;`--since=24h` 可變範圍;`<id>` 看單一 task SUMMARY(非互動);`--synthesize` 強制產出 markdown 報告檔。

---

## 十三、Config 完整 schema

```yaml
# ~/.config/unattended-claude/cc.yaml

paths:
  runtime_dir: ~/unattended

runtime:
  driver: claude                              # 將來可能 opencode / codex
  bin: happy                                  # claude TUI wrapper
  extra_args:
    - --dangerously-skip-permissions

execution:
  max_parallel_tabs: 3
  wind_down_lead_minutes: 5
  smoke_test_workdir: ~/unattended/workdirs/.smoke

archive:
  auto_after_days: 7

schedule:
  windows:
    - { start: "22:30", end: "06:30", days: [mon, tue, wed, thu, fri, sat, sun] }

logging:
  level: info                                 # debug | info | warn | error
  dir: ~/unattended/logs
```

**不在 v2 初版的欄位**(可後加):
- `notification.channels`(用戶說現在不要)
- `plugin.*`(無 plugin 系統)
- `cron_expr`(不用 cron,用 launchd)

---

## 十四、Migration:cc-nightshift → unattended-claude

### 策略:D(完全 rewrite,但有紀律)

新 v2 repo 在 `Workshop/unattended-claude/unattended-claude/`,參照 v1 重寫,**不 git-merge v1 歷史**。

### 必搬不重寫(行為 vetted,搬即可)

| v1 模組 | 處理 |
|---|---|
| `src/runtime/zellij.ts` | `cp` 過來,改 session 命名常數,核心驅動原封 |
| `src/runtime/claude-session.ts` 內 `matchRateLimit` | 搬整個 function。新加 context-limit / weekly-limit detector 是新工作 |
| `src/runtime/mock-runtime.ts` | 整檔搬,擴 weekly-limit / context-limit 模擬 |
| `src/orchestrator/rate-limit.ts` 內 `RateLimitGate` | 搬 + 擴 weekly |
| `src/orchestrator/state-store.ts` | 微改 |
| `src/orchestrator/task-runner.ts`, `task.ts` | 微改 |
| 跟新模型仍適用的 tests | port,語意一樣只改 import path |

### 允許重寫

| v1 模組 | 為何重寫 |
|---|---|
| `src/orchestrator/main.ts` | 不是 night-based,是 window/queue-based,結構不同 |
| `src/orchestrator/lifecycle.ts` | 「night start/end」死了,改「window start/end + auto-resume paused」 |
| `src/orchestrator/state.ts` 的 state model | 新增 paused-reason、context_compactions、auto-resume queue 等 |
| `src/orchestrator/episode.ts` | 加 wind-down 注入、paused-reason 寫入、`--resume` 啟動分支 |
| `src/commands/*` | 新命令集 |
| `.claude/skills/*` | rename + 微改 |

### 估值

- 約 **55-65%** v1 code 行為 vetted,以「搬」為主
- 約 **20%** 大改寫
- 約 **15%** 純新(stats、archive、HANDOFF、`--session-id`、wind-down、weekly-limit 凍結)
- 約 **10%** v1 已死(night batch、overnight-synthesis 相關)

### 紀律(必守)

1. **單一目標**:行為對等 + 新 4 功能(`--resume` / weekly-limit 凍結 / context-limit HANDOFF / wind-down)
2. **禁止**「順便」引入新 library / 新風格
3. **每模組寫完必有 test**
4. **2 週硬 deadline**;超過先停下檢討
5. **`bun test` + `tsc --noEmit` 必綠**,否則不下個 commit
6. v1(`cc-nightshift/`)留著 reference-only,不動

---

## 十五、最小 e2e milestone

v2 第一個跑通的 task,端到端覆蓋所有新機制:

```
Task: 「在 task workdir(auto-assigned ~/unattended/workdirs/<id>/)寫一個 hello.py
       印出 'hello from window N',然後 sleep 4 分鐘,然後印 'still alive',
       然後在 workdir 寫一個 result.md 說明你做完了什麼。」

config(milestone 期間覆蓋):
- execution.wind_down_lead_minutes: 2(縮短,讓 milestone 不用等太久)

驗證步驟:
 1. ucl init → ~/unattended/ + ~/.config/unattended-claude/cc.yaml 建好
 2. 編 todo.md 加一條任務
 3. ucl plan 把 todo 轉成 task doc(走 task-brief skill),凍結 tasks/<id>.md
 4. ucl run --until +5m 啟動 zellij session(名 unattended-claude)
 5. happy --session-id <pre-gen UUID> --dangerously-skip-permissions 在 tab 內啟動
    state/tasks/<id>.json 的 claude_session_id 寫入該 UUID
 6. AI 寫 hello.py,執行,sleep 4 分鐘中(此期間應撞 wind-down)
 7. T+3min(window 邊界前 2 分鐘)wind-down prompt 注入 in-flight tab
 8. T+5min → graceful pause:zellij /quit → 5s 後 force kill → tab 關 → session 銷毀
    state/tasks/<id>.json:state = "paused", paused_reason = "schedule-boundary"
 9. ucl run --until +5m 再啟動 → tab 啟動 happy --resume <UUID> → AI 看歷史繼續
10. AI 寫完 result.md,task 完成 → state/tasks/<id>.json:state = "done"
11. ucl review <id> 印 task doc 的 SUMMARY 區段
12. ucl stats 顯示 2 episodes、各 episode 的 token 用量
13. 模擬 7 天後 ucl archive --done-before=7d 把 bundle 搬到 archive/<id>/
```

**這個跑通 = v2 核心 80% OK**。不是「完整 cc-nightshift parity 才算完」。

---

## 十六、明確不做(YAGNI)

| 不做 | 理由 |
|---|---|
| Plugin / multi-driver 系統 | 單人單 driver,有第二個 driver 時再抽 |
| User-idle auto-detect | macOS idle 不可靠,失敗模式可怕 |
| Cron expression schedule | launchd plist 夠用 + 不易錯 |
| 壓縮 archive(`.tar.gz`)| scratch dir 通常小,壓縮省的 < 解壓不便 |
| Auto-delete archive | 磁碟便宜,歷史貴,你要時自己 `rm` |
| Archive 索引 / 全文搜尋 | `grep -r` 已夠 |
| 跨機 archive 同步 | 你要用 syncthing / git / rsync 自己處理 |
| 顯式 task dependencies (`depends_on: <id>`) | 你的 todo 99% 獨立,顯式 dep 過度設計 |
| `notification.channels` | 你目前不要 |
| `ucl pause` / `ucl resume` 命令 | `stop` 就是 pause、`run` 就是 resume,不另增動詞 |
| 「替我從 bookmark / email / matrix 找事做」 | 北極星不是用盡 token,而是 demand shift |

---

## 十七、命名 / 別名

| 層 | 名 |
|---|---|
| Project / repo | `unattended-claude` |
| CLI binary | `ucl`(也可解讀為「Unattended CLI」,真換 LLM 時不需改名) |
| Workshop dir(現有) | 將改 `Workshop/cc-history/`(避免 v2 同名巢狀) |
| Runtime data dir | `~/unattended/` |
| Config | `~/.config/unattended-claude/cc.yaml` |
| Zellij session(運行中) | `unattended-claude` |
| Task ID 格式 | `YYYY-MM-DD-NN-slug` |

---

## 附:從 grill-me session 直接歸結的 17 個決定

1. **名 / scope**:`unattended-claude` / demand-shift framing
2. **執行模型**:常駐 state + episodic execution
3. **目錄結構**:扁平 + rolling todo.md + flat tasks/ + archive/ + events.jsonl
4. **觸發**:手動 + 排程(launchd),無 auto-detect
5. **Session**:ephemeral,name = `unattended-claude`,跟 run 同生死
6. **Plan**:checkbox marker,todo.md 變思考 journal,idempotent
7. **Task ID**:`YYYY-MM-DD-NN-slug.md`
8. **跨 window**:pre-gen UUID 帶 `--session-id` + `--resume`;HANDOFF 只當 context-full 退路
9. **Limit**:5h(可 sleep or pause)/ weekly(凍結 schedule)/ context(HANDOFF 壓縮)
10. **Wind-down**:T-5min 注入禮貌 prompt,T-0 直接關
11. **Wake-up**:按 paused_reason 帶不同 prompt
12. **Parallel**:workdir lane + cap 3 + `serial: true` 逃生口
13. **Archive**:7 天後自動 + 手動覆寫 + `--consolidate` 整理 todo
14. **Naming**:`ucl` / flat repo / `~/unattended/`
15. **Skills**:`task-brief` / `task-review`;刪 `overnight-synthesis`;`review` 變查詢式 + on-demand synthesize
16. **Migration**:D rewrite + 嚴守紀律 + 2 週 deadline
17. **LLM-neutral**:輕量 abstraction(Driver / Runtime / Session 命名 + driver config 欄位)。重的 plugin 系統 YAGNI
