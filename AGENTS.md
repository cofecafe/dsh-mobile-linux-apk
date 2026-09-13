# AGENTS.md — dsh-mobile-apk 开发地图（索引主文件）

> **AI 主动更新条款（必须最先执行）**：本文件是唯一权威入口，采用「主文件索引 + docs/AGENTS/ 详档」结构。**任何代码变更导致描述失真时：① 主文件对应行当轮更新；② 细节写入 docs/AGENTS/ 对应详档（坑→gotchas.md 追加递增编号；版本历史→更新记录表登记，3 条之前的行滚入 changelog-archive.md）。** 若发现文档与源码不一致，以源码为准并当场修正。**查询规范：优先用 grep 在 docs/AGENTS/ 详档内定位（见下方路由表），不要凭记忆猜细节。**
>
> **过期风险声明**：代码演进可能快于文档更新；一切以源码为准。

---

## 1. 仓库概览

- **角色**：DeepSeek Harness 安卓壳应用（`com.dsharnessmobile.shell`）。职责边界 = 只保留安卓平台权能与桥（前台服务/看门狗/WebView/SAF 桥/快照解压/UndoGate/ADB 授权/审计/控制台/日志）；**AI 可见能力全部来自插件**。
- **运行时形态**：内嵌 Termux 快照（`assets/snapshot.tar.xz` → files/usr + files/home）；引擎 `@deepseek-ai/dsh` **0.1.5-rc.1**（0.13.3 起构建期 overlay；0.13.7 追上游升版，快照本轮重建）；**/api 前缀**浏览器鉴权——壳侧 EngineAuth 带 Cookie）监听 127.0.0.1:3080；WebView 加载引擎 Web UI。**例外（坑 78）**：上游路由匹配是「exact 表先于 prefix 表」，插件用 `kind:'exact'` 注册在 `/api/...` 下会**绕过**该前缀的 cookie 鉴权与 Host 校验——「/api 全前缀鉴权」不成立，鉴权必须由插件自己带（见坑 78）。
- **构建链**：minSdk 26 / targetSdk 34 / compileSdk 36；Kotlin 2.0.21；AGP 8.8.2；Java 17。
- **版本状态**：**0.13.7fx-1 修订构建（vc36，2026-09-11，发布资产同 tag 替换）**：发布后 issue 修复批=会话迁移 link(2) 回退（#154）+ 上传选择器统一 SAF（#160）+ 设置页「打开配置文件」接管（#152）+ 移动端 @ 菜单目录行下钻与多选（#163）；详见 §5 与坑 64-66。**0.13.7fx-1 已发布（vc35，Release v0.13.7fx-1，15 资产，2026-09-11）**：本版=**@ 文件回到上游原生**（退役注入的「引用本机文件」菜单项与整条 SAF 路径桥；`@` 只列会话工作区文件，官方语义）＋ **引擎启动目录改应用工作区根**（未分组会话不再把 `/` 当工作区，issue #150/#144）＋ **修复 0.1.5 起失效的移动端 Enter 换行守卫**＋ 退役空转的 `web-frontend-index.html` 运行时补丁 + 合入贡献者 PR #157（抽屉底部安全区）。**0.13.7 已发布（vc34，Release v0.13.7，15 资产，2026-09-10）**：本版=**追上游 dsh 0.1.5-rc.1**（上游 ui-layout 基线 + 移动适配层 0.2.0 + 原生「打开方式」PathOpen/openPathChooser + 引擎树补丁 F3/F4 + polyfill 装配与 Iterator 垫片修复 + UI 冗余清理）；认证台账 `docs/AGENTS/0.13.7-CERTIFICATION.md`（版本口径统一表在 §3）。0.13.6 已发布（vc33，Release v0.13.6，15 资产，2026-09-10）：本版=**附件持久化 Android 守卫（图片输入/read_image 全链修复，构建期+运行时补丁双写）** + 自有 WebView DOM 快速通道（`android_web_dump` + `ref=wN/css:/text:/role:`）+ `android_ui_global`（返回/主页/最近任务/通知栏）+ `android_env_prepare`/`android_app_launch`/前台真值/输入回读断言 + `phone-control` 预设 + 顶部系统 inset 通道 + 弹出面板几何守卫 + 悬浮球光环提亮；认证台账 `docs/AGENTS/0.13.6-CERTIFICATION.md`。0.13.5 已发布（vc32，Release v0.13.5，15 资产，2026-09-10 收官）：无障碍控制通道 v1（`DeviceControlService` + 控制队列 + 双通道门禁等价且无障碍优先 + 无障碍截屏 API 30+ + 完整语义树/同名消歧）+ 悬浮球跟随工作会话/新会话落临时工作区 + 授权面重构 + #126/#124 引擎补丁 + #125 能力自动补全 + 构建提速（WSL 内原生执行，172s vs ~29min）。0.13.3 已发布（vc30，Release v0.13.3 正式版，14 资产）。0.13.2 已发布（vc29，悬浮球 v2.1 全套）。0.13.6 已把 0.13.5 的残余项（#127/#128/#129/#130 主体/#133/#134/#135）全部落地；开放跟踪：#130 剩余（Android 13+ 无障碍输入法替代内嵌 IME 的自动就绪）、#115（市场 Phase2）、#108（数据备份）。arm64 真机（V2425A）链路验证已通过。
- **兄弟仓库**（协调仓子目录，本仓内含自包含副本——**坑 36 同步铁律**：协调仓改子仓源码/bump 版本后必须 robocopy 镜像到本仓，lib/ 产物一并拷）：`dsh-shell-termux`、`dsh-client-ui-responsive`（0.2.1，移动适配层）、`dsh-host-web-compat`（0.1.13，polyfill/桥）、`plugins/`（bridge 0.2.2 / manage 0.2.3 / model-capability 0.2.1 / linux-env / file-open）、`vendor/`（marketplace、undo-savepoint、dsh-model-sync + PATCHES.md）。
- **补丁镜像面（0.13.8 起）**：本仓 `scripts/patches/**`（registry.json / apply-patches.mjs / README.md / tests/**）与 `scripts/check-patch-mirror.mjs`、`scripts/build-apk-013.ps1` 是协调仓的**逐字节镜像**（云端自包含构建检出本仓）——改补丁必须双树同批；`check-patch-mirror.mjs` 在两仓 CI 与构建链强制比对，单边演进即拒（apk #171 教训；镜像纪律详见 `docs/AGENTS/RUNTIME-PATCHES.md` §7.1）。
- **上游** deepseek-ai/deepseek-harness（协调仓 `dsh/` 只读 checkout）：**零改动**；一切适配走补丁/插件/壳侧。
- **模拟器优先于 PR 与真机请求（2026-09-10 用户定例）**：改动落地顺序 = 本地构建 → **MuMu x86_64 模拟器实测** → 再谈 PR；**不得以「等真机验证」为由推迟模拟器实测、或把模拟器实测挂在 PR 之后**。真机（arm64）验证是**发布前**的补充门禁，不是开发循环的前置条件；模拟器上验不过的改动不允许开 PR，模拟器上验过的改动也不因缺真机而搁置（release notes 标注真机待验即可）。
- **PR 流程铁律（2026-09-10 用户定例）**：**任何代码/文档改动一律走 PR，禁止直接 push 到 `main`**（人类与 AI 开发助手同等适用）。流程：建分支（`<type>/<简短描述>`）→ 提交（`<type>: <描述>`，见 pr-guidelines）→ 推送分支 → 开 PR（标题/描述按模板，标签 1-3 个）→ CI Gate 绿 → 合并 → 删分支。**例外（不改仓库内容的外部动作，可直连 API）**：Release 资产上传/发布、issue 评论与开关、标签操作。协调仓 `dsh-mobile` 同规（见其 AGENTS.md §4）。

## 2. 构建命令速查（在协调仓根执行）

```powershell
pwsh -File scripts\build-apk-013.ps1 -Suffix ""   # 一键双 ABI（门禁失败即拒打包）
pwsh -File scripts\build-apk-013.ps1 -Fast        # dev 快速档（单 ABI x86_64 + preset 1；产物禁发布）
node scripts\build-snapshot-013.mjs <arm64|x86_64> # 快照构建（Windows 需 WSL）
node scripts\smoke-bridge.mjs                      # bridge 冒烟
adb -s <serial> install -r -t out\v<版本>\...apk    # 装机（同签名 debug keystore）
```

门禁链：统一补丁 → 引擎 overlay 抽验（check-engine-overlay）→ 单 pass 注入 → 挂载集 → 机密 → third-party → elf-check → gradle。云端自包含构建：`.github/workflows/build-apk.yml`。

## 3. 高频雷点 TOP（一行一条；**全量坑位以 `docs/AGENTS/gotchas.md` 为准**——坑号为**历史分配**、**允许空缺**（空缺号保留占位、一律不重编号，避免破坏既有引用），新增自 72 起；本节的「全量 45 坑」类数字一律不写死，用 `grep -c '^[0-9]\+\. \*\*' docs/AGENTS/gotchas.md` 现数）

- **坑 37**：快照重解压中（~8-12 分钟）**禁 force-stop/杀进程**——唯一完成标志 = `.snapshot-fingerprint` 翻转 + `.snapshot-transaction` 消失（0.13.3 事务化后不再用 `.dsh-backup`）；中途杀 → 事务恢复会自动回滚，但仍建议等完成。
- **坑 18/30**：debug 包默认 x86_64 快照装 arm64 必崩；真机安装只用 ps1 对应 ABI 命名产物。
- **坑 19**：真机改 cordis.patch.yml 后必须冷启动 app（force-stop + start）才重装配。
- **坑 33**：壳侧所有本地引擎调用一律 `Proxy.NO_PROXY`（系统代理劫持探针）。
- **坑 38**：运行时补丁升级引擎时必须逐个核对（rc.2 锁定 asset 会抹掉新引擎代码——0.13.3 prompt 阻断实锤）。
- **坑 44**：WSL 9p 挂载 chmod 无效——归档权限归一化只在 `inject-all.py` 重打包层做（门禁校验注入后快照）。
- **坑 45**：快照含 9 个指向 `files/usr/...` 的绝对符号链接（vi/vim/nc/editor/pager 等 applet）——暂存解压必须传 `runtimeRoot=filesDir` 放行，否则静默丢链。

## 4. 详档路由表（grep 形式查询）

| 要查什么 | grep 建议 | 文档 |
|---|---|---|
| 坑 N 详情/新坑登记 | `grep -n "^38\.\|^39\." docs/AGENTS/gotchas.md` 或按关键词（`borrowSession`/`store-rehome`/`MANAGE_EXTERNAL_STORAGE`/`run-as`/`overlay`） | docs/AGENTS/gotchas.md |
| 某 .kt 文件职责/函数位置 | `grep -n "<文件名>.kt" docs/AGENTS/modules.md` | docs/AGENTS/modules.md |
| 桥方法签名/通道语义 | `grep -n "<方法名>" docs/AGENTS/BRIDGE-API.md`；0.13.3 增量 grep `pickFilePath\|remote.mux\|EngineAuth` docs/AGENTS/bridge-api.md | docs/AGENTS/bridge-api.md |
| 构建失败/门禁/环境差异 | `grep -n "门禁\|WSL\|abi" docs/AGENTS/build-and-env.md` | docs/AGENTS/build-and-env.md |
| 运行时补丁（assets/patched） | `grep -n "patched\|applyAssetPatch" docs/AGENTS/RUNTIME-PATCHES.md` | docs/AGENTS/RUNTIME-PATCHES.md |
| 35 模块地图/依赖方向 | `grep -n "模块\|依赖" docs/AGENTS/ARCHITECTURE.md` | docs/AGENTS/ARCHITECTURE.md |
| android.* API 清单/守卫点 | `grep -n "API 等级\|android\." docs/AGENTS/ANDROID-API-USAGE.md` | docs/AGENTS/ANDROID-API-USAGE.md |
| **无障碍 API/权限面全量参考** | `grep -n "CAPABILITY_\|takeScreenshot\|ACTION_SET_TEXT\|GLOBAL_ACTION" docs/AGENTS/ACCESSIBILITY-API.md` | docs/AGENTS/ACCESSIBILITY-API.md |
| gradle 依赖与升级策略 | `grep -n "依赖\|升级" docs/AGENTS/DEPENDENCIES.md` | docs/AGENTS/DEPENDENCIES.md |
| GPL 合规三形态 | `grep -n "copyright\|LICENSES" docs/AGENTS/gpl-compliance.md` | docs/AGENTS/gpl-compliance.md |
| 待办与已知缺口 | `grep -n "F[0-9]\|未实现" docs/AGENTS/known-gaps.md` | docs/AGENTS/known-gaps.md |
| 版本历史 | `grep -n "0.13.2" docs/AGENTS/changelog-archive.md` | docs/AGENTS/changelog-archive.md |

## 5. 更新记录表（最近 3 条；完整历史 docs/AGENTS/changelog-archive.md）

| 时间 | 版本 | 更新内容 | 更新者 |
|---|---|---|---|
| 2026-09-13 | **4Debian D-6 启动器原型全决：LD_PRELOAD exec 拦截器 A/B 全 PASS** | 新增 `scripts/d6-exec-hook.c` + `build-d6-hook.mjs`（glibc 孪生 libtermux-exec，双 ABI）+ `build-rootfs-g2.mjs` 嵌钩子（rootfs/opt/d6/libd6exec.so，env D6_LDSO/D6_ROOT/LD_PRELOAD）。拦截 execve/execv/execvp/execvpe/execl 族 + **posix_spawn/posix_spawnp（node/libuv 实际路径）**；判定 = PT_INTERP 含 ld-linux（bionic 不碰）+ shebang 递归解释器判定；重映射 = /bin、/usr 前缀 **guest 优先**（宿主 /bin/sh 是 toybox bionic 钩子管不进 → 让位 guest dash 链路才闭合，坑 102）。**A/B 对照验收**：无钩子 5/5 FAIL（execSync/spawnSync PATH/绝对路径/嵌套孙进程/shebang）↔ 有钩子 **5/5 PASS**（git 2.39.5 + rg 13.0.0 全链通）。fork+exec 裸奔问题（坑 97/98/101①）机制性解决 | AI 开发助手 |
| 2026-09-13 | **4Debian P2 开工：引擎 overlay 升级 0.1.5-rc.1 一键固化 + 全量回归 ALL PASS** | 新脚本 `scripts/build-rootfs-g2.mjs`：把坑 98/99/100 的手工嫁接配方固化为一条命令——LFS 基座指针自动拉取（media 直链 + sha256 对指针校验）→ 312 包登记表覆盖（rootPackage 只换 lib/+README+package.json，保留旧包嵌套 node_modules，sha512 + npm 镜像链，缓存与 Termux 流程共享幂等）→ koffi 平台包双保险（版本锁基座树内 3.1.5）→ 版本/keepUnpublished/bin.js 断言 → 归档（剥 rootfs/dev + hard-deref）。产物 1003MB，引擎 **@0.1.5-rc.1 与现网 Termux 快照对齐**。**坑 101 三连**：① 设备侧脚本 PATH 若 guest usr/bin 在前，grep/head/cut 落到 glibc 动态二进制裸 exec 即 ENOENT → 脚本自身工具 /system/bin 优先（D-6 约束的脚本层体现）；② 引擎 0.1.5-rc.1 起 / 用 token 鉴权且是 **303 门票兑换流**（?token→Set-Cookie→带 cookie→200；node fetch 无 cookie jar 必须手动两步，curl 用 -c/-b jar；与壳侧 EngineAuth 同构）；③ 复跑残留引擎占端口 → 启动前 pkill 'bin.js web' 清扫。模拟器全量回归 ALL PASS（设备端兑换探针 + 宿主 forward 双 HTTP 200）。g2-emulator.sh 同步升级 | AI 开发助手 |
| 2026-09-13 | **4Debian 真机 G2 复验 PASS（vivo PJZ110·Android 16，P1 收官）** | `PORT=3081 SKIP_PUSH=1 scripts/g2-emulator.sh <serial>` 一次通过：950MB 载荷 WiFi 推送 110.7MB/s（8.6s）→ D-6 直启链（ld.so → glibc node → bin.js web --no-open）→ `dsh web: http://127.0.0.1:3081` 90s 内就绪 → 设备端 node-fetch **HTTP 200 text/html** + adb forward 宿主 curl **HTTP 200** + Web UI HTML 全量返回。**坑 100 双坑**：① 真机上 dsh-mobile app 自身引擎常驻 3080，loopback 全局共享 → 复验必须换端口（EADDRINUSE，且 dsh-host-webserver 插件把 listen 失败包装成「plugin tree failed to load」整体拒启，定位要看日志尾）；② macOS bash 下 `$PORT）` 全角括号被当变量名字符（set -u 即炸）→ `${PORT}）` 花括号。脚本参数化升级：PORT/SKIP_PUSH 环境变量 + 真机/模拟器通用化。**P1 至此四门禁全绿（G1/G2/G3-lite 双环境 + G4/R-1 反转）**，余项进 P2 | AI 开发助手 |
