# 自动连播助手 v2.2.4（2026-11-20 发布）

> 本仓库为**脱敏源码副本**，仅供阅读与学习；可运行的完整配置由作者单独分发。

## v2.2.4 · 优化网梯平台「偶尔无法自动连播」

**问题**：网梯科技平台偶尔出现播完不跳、跳了不播，或反复停在同一节课。

**六个偶发根因**

1. 子帧 `reportVideoState()` 把含 DOM 元素引用（`container` / `leaves[].el`）的 `localList`
   塞进 `postMessage`，结构化克隆抛 `DataCloneError` 又被 `try/catch` 静默吞掉。
   只要某子帧碰巧识别出目录片段，该帧整条状态上报就消失，顶层看不到 iframe 里的视频 —— 这是「偶尔」的主因。
2. `clickNext()` 的 2 秒跳转校验只写日志不补救，而 `lastClickAt`(4s) / `lastGlobalNextAt`(8s)
   两个锁已被占用；视频播完不会再有 ended 事件，这一节就停住。
3. `dispatchNext()` 委派子帧跳转后没有回执：iframe 切课时被重建，消息无人接收，8 秒锁内不重试。
4. 前台 3 秒主心跳没有「停结尾」检测，只能等每分钟一次的后台闹钟。
5. `handlingEnd` 布尔锁靠 `setTimeout(2000)` 复位，后台标签页节流会把新一节课的 ended 事件整段吞掉。
6. `localDoneMap` 只用 DOM 元素做 key，Vue 重渲染目录后完成记账丢失，表现为反复跳同一集。

**修复：新增网梯连播自愈层（只做确认与补偿，不改任何判定语义）**

- `plainList()`：仅网梯 profile 下把 `localList` 转成纯数据副本上报，并预计算 `catalogReal`；
  `hasRealCatalogInList()` 优先采信该结论，跨帧视频状态稳定可见。
- `armJumpVerify()` / `verifyJump()` / `retryJump()` / `finishJump()`：跳转后 2.2 秒确认
  当前课时是否真的切换；未生效最多补偿 3 次，每次清掉跳转锁、重新分析目录。
  **前两次重试同一目标**（不跳课），第三次才顺序换目标；目录高亮没刷新但新课时已起播也判成功。
  确认成功后给 12 秒补跳冷却，防止旧视频的「已结束」状态残留造成重复跳课。
- `itemKey()` + `localDoneKeys`：基于网梯 itemId（其次课时文本）的稳定完成记账，
  SPA 重渲染后仍有效；`nextHealTarget()` 跳过上次点过没生效的目标与已完成课时，按目录顺序推进。
- 子帧跳转点击发 `nextAck` 回执，顶层统一确认（避免各子帧各自补偿重复点击）；
  `delegatedNextAt` 超过 3.5 秒无回执时顶层接管重试。
- `whatyHealTick()` 接入顶层 3 秒心跳：`whatyStuckEnded()` 识别「paused 停在结尾」
  （原判定要求 `!paused`，网梯播完自动暂停会漏判），12 秒节流后主动补跳。
- 确认切课后立即 + 1.5s + 3.5s 三次 `ping(play)` 唤醒各级 iframe 起播；
  `handlingEnd` 改时间戳；SPA 换课时重置自愈状态。

**隔离保证**：全部经 `whatyHealOn()` 把关，`ACTIVE_PROFILE !== 'whaty'` 时完全不执行；
冻结的 `findWangtiCatalog` / 完成与当前判定、`PLATFORMS.frozen` 一律未动，冻结门禁 20/20 继续通过。
用户手动暂停、手动下一集不触发自愈，补偿有次数上限和节流。

- 新增 `tests/selftest_whaty_heal.js`（68 项：21 条源码隔离断言 + 47 条行为仿真），
  `selftest_robust.js` 的 ping 断言同步；**全量回归 392/392 通过**。
- 相对 v2.2.3 只有 `content.js` / `manifest.json` / `README.md` / `CHANGELOG.md` 四个文件变化。

## v2.2.3 及更早

| 版本 | 要点 |
| --- | --- |
| v2.2.3 | 修复「已授权用户断网太久又要重新授权」：心跳不再决定可用性、令牌过期自动重激活 |
| v2.2.2 | 授权站启用 SSL，在线通道全量切到 https；新增 https 门禁断言 |
| v2.2.1 | 填入真实 AppKey、真实服务器联调、双授权独立兼容 |
| v2.2.0 | 接入 V2 在线授权（RSA-2048 / SHA-256 签名 / JWT / 5 秒心跳 / 远程停用） |
| v2.1.x | 程序级离线授权（`AVP1`）、平台隔离、播放内容探测与待命状态 |
| v2.0.0 | 网梯 / 江西师范大学 / 通用兜底三套策略互不干扰 |

完整更新历史见 `CHANGELOG.md`。

## 使用与授权

- 本仓库 `auth-online.js` 与 `license.js` 中的 `APP_KEY`、`CLIENT_SECRET`、`SIGN_SECRET`
  均为占位符，**不能直接用于在线激活**；`tools/` 与 `tests/` 属作者私有工具，不在公开仓库内。
- 仓库内的 `auto-video-player-v2.2.4.zip` 是**脱敏源码包**（同样含占位符），不是可激活安装包。
  需要授权与可运行安装包请联系作者：**QQ 2657449167 · 微信 Evil_Hu123456**。
- 安装方式见 `README.md`。
