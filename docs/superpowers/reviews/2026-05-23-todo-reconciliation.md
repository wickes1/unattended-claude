# todo.md reconciliation — questions mapped to DESIGN.md (2026-05-23)

Phase 2 ship-readiness pass. The user's freeform pad
`../todo.md` (relative to this repo) accumulated ~24 distinct questions /
feedback items between roughly 2026-05-22 23:00 and 2026-05-23 13:00.
This file mirrors the table appended at the end of `../todo.md` so the
mapping is permanently tracked in the repo, not just on a brainstorm pad
that gets rotated.

Source-of-truth ordering: DESIGN.md sections (§一 to §十七) are the
canonical answer. Where a question is rejected, the row points at
§十六 YAGNI with reason. Where a Phase 2 commit closed the gap, the
commit hash is cited.

| # | 原 question | 結論 |
|---|---|---|
| 1 | missions vs tasks 命名 | DESIGN §十七: 採用 `tasks/` |
| 2 | plan 加 grill-me skill / 內置 | DESIGN §十一: `task-brief` skill 內建 grilling 邏輯;`task-review` 同理(v1 `bedtime-brief` / `morning-review` 改名) |
| 3 | task md filename 加 number prefix (例:`1.grep-bench.md`) | DESIGN §十七: 採用 `YYYY-MM-DD-NN-slug.md` —— NN 是當日 ordinal,扁平 + 跨日仍可排序,優於 1./2./3.(會跟日期衝突) |
| 4 | 改名 cc-nightshift → unattended-claude(日夜兼用 / multi-LLM / 突出無人值守) | DESIGN §十七: project=`unattended-claude`、CLI=`ucl`(LLM-neutral)、runtime data=`~/unattended/`、zellij session=`unattended-claude`。§十六 確認:plugin/multi-driver YAGNI,真換 LLM 時 rename + rewrite 解析層即可。 |
| 5 | 同日 multi-todo 怎麼 group? | DESIGN §三: 無 batch / 無日期目錄,扁平 `tasks/<id>.md`;todo.md 是 rolling inbox + journal,不按天分組。 |
| 6 | 兩套 design pattern:離散批次(夜班 / 每夜一份 report)vs 常駐 worker | DESIGN §二: 採「常駐 state + episodic execution」(混合)。state 永遠存在(`~/unattended/`、launchd plist、config);zellij session 只在 run-stop 之間存在。對應「常駐 worker」+ rolling inbox 的心理位置。 |
| 7 | 北極星:項目目的是「用盡 token」? | DESIGN §一明確否定:不是「用盡 token」(Goodhart's Law),是 demand shifting —— 把 task 移到 off-hours,active 時間留給自己。 |
| 8 | AI 自主從 bookmark / email / matrix / internet 找事做 | DESIGN §一 + §十六 明確 YAGNI:不缺 task,缺 window;自主找事 scope 爆 + 風險高。 |
| 9 | `ccns run` 應該 daemon detach;不該跟 shell;不能 shell 關了就結束 | DESIGN §二 + §六: `ucl run` 在 zellij session 內跑(可 detach,不死);launchd-triggered window 不需要 attach。但這 ship-readiness pass **未實作 daemonize**(`ucl run` 仍前景跑)—— 留待後續 fix,可走 `nohup` / `launchctl bootstrap` / `setsid`。 |
| 10 | `ccns run` 應該 attach all tasks + each in 1 tab(目前報多 session) | DESIGN §二: 一個 zellij session,每 task 一 tab,自動分。§九 cap=3 上限。 |
| 11 | `ucl run` 只跑「今天」的 todo 不對 | DESIGN §五: 沒「今天」概念。run 拿 paused(resumable)+ planned(未啟動)。runtime 由 `tasks/` 目錄 + `state/tasks/<id>.json` 驅動,不按日期。 |
| 12 | stop 機制?直接 kill zellij 會殘留 process 嗎? | DESIGN §六 wind-down + §八 limit 矩陣:`ucl stop` graceful(SIGTERM → 改 state → `/quit` → 5s force kill);`ucl stop --now` 寫 `stop-now.flag` 再 SIGKILL。zellij `kill-session --force` 已 fixed(F11)。 |
| 13 | 新增 stats: per-day token + % subscription + 完成/失敗 | DESIGN §十二 + Phase 2 commit `feat(stats): wire subscription.weekly_token_cap`:`ucl stats` 印 per-day token / 5h-limit hit + utilization% (從 `subscription.weekly_token_cap` 算)。 |
| 14 | 5h / weekly / context limit 各自怎麼處理 | DESIGN §八 矩陣 + §七 HANDOFF.md 退路:5h(sleep or pause)/ weekly(凍結 schedule + `weekly-paused-until.txt`)/ context(reactive HANDOFF.md;proactive jsonl-size YAGNI per Phase 2 commit `chore(config): drop unused context_compact_threshold knob`)。 |
| 15 | 抓 chat / usage 應該用 `/status` slash-command 而不是 jsonl 解析 | F01 已 land:happy 模式用 `/status` slash 抓 session id;`bin=claude` 用 `--session-id` pre-gen(架構 review P0-1 解);usage 仍從 jsonl(per-episode `usage_snapshot` event 寫入 `events.jsonl`,F05)。 |
| 16 | init schedule 加 user timezone + 24h 範例 + 拆 start/stop | DESIGN §六: `schedule.windows` 用 24h `HH:MM` + days[];本機 timezone 隱含(launchd 自動本地時區)。`ucl init` 互動 wizard 已加(commit `e31ed7c`)。 |
| 17 | runtime: 為什麼 `driver: claude` 還要 `bin: happy`?happy 直接 driver 不行嗎?happy 應該用 `--yolo` 不是 `--dangerously-skip-permissions` | `driver` field 已刪(commit `15733ec`,Q4 hygiene)。`bin` 就是 launcher binary(`claude` 或 `happy`);`extra_args` 由 user 決定,template 預設 `--dangerously-skip-permissions` 因 base case 是 `bin=claude`;若 user 設 `bin=happy` 自己改成 `--yolo`。 |
| 18 | config 為什麼叫 cc.yaml 不 ucl.yaml?init 沒選項?無 doctor? | 都已 fix:`1fe651f` 改名 `cc.yaml → ucl.yaml`;`e31ed7c` rewrite init 成 wizard;`c731b70` 加 `ucl doctor`。 |
| 19 | skill 為什麼不在 unattended folder?裝哪裡? | DESIGN §十一: skill 在 repo-local(`.claude/skills/`),不裝 user-global;`ucl plan` / `ucl review` 啟動時 cwd 設 v2 repo root,讓 skill 自動載入(避免污染 user 全局 skill 庫)。 |
| 20 | `unattended` 名字像系統文件夾,是否有問題? | DESIGN §十七: 接受 trade-off ——「無人值守」是 brand 核心,系統感反而強化「daemon-like」印象。Runtime dir `~/unattended/` 跟 macOS `~/Library/Application Support/` 屬不同 namespace,不衝突。 |
| 21 | alias `claude = happy --yolo` | 不在 unattended-claude scope —— 是 user shell 配置,跟此項目無關。可考慮在 `ucl doctor` 偵測 alias / 印警告,但 §十六 YAGNI 認為現階段不必。 |
| 22 | schedule 增加 how-many-times / by crontab / one-time | DESIGN §十六: `cron_expr` YAGNI(launchd plist 已夠 + 不易錯);one-time 可用 `launchctl bootstrap` 手動,不另增動詞;次數限制現階段不做(window 結束自己會收尾)。 |
| 23 | readme 加 zellij 基本操作說明 | 已加(README.md cheat sheet:switch tabs / detach / kill-session 警告)。 |
| 24 | housekeeping(清理 outdated todos + tasks) | DESIGN §三 + §四: 7 天後 done/failed 自動搬 `archive/`(F10 已 wire,`archive.auto_after_days`);`ucl todo --consolidate` 把 `[x]` 條目移到 journal section。Archive 索引 / 全文搜尋 / 自動刪除 → §十六 YAGNI(grep -r 已夠)。 |

## 開放項目

只剩一個非 YAGNI 的真正 gap:

- **#9 (daemonize)** — `ucl run` 仍前景跑,SIGINT 殺掉就斷;launchd-triggered window 不受影響(launchd 自帶 detach),但用戶手動 `ucl run` 後若關 terminal 會丟工作。是 Phase 2 之後的工作。
