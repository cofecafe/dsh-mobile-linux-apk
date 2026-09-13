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
| 2026-09-13 | **4Debian G1/G4 真机定局：R-1 反转 + D-6 升主路径（vivo PJZ110·Android 16·SDK 36·内核 6.6.118，无线 ADB）** | **G4/R-1 探针反转**：app 域（run-as，u0_a780）从 `files/` 与 `code_cache/` exec glibc 自足 ELF 全部成功——EngineManager.kt:1212 的「Android 16 exec 拒绝」在当前系统版本不成立（历史成因待查）。**G1✅**：app 域 `files/` 内自足 D-6 链（ld.so+node+8 库，零外部依赖）完整运行 v22.23.2（V8/fs 全活）；shell 域同链早过；模拟器（AVD Android 14）同链亦过。**proot 在 vivo EACCES**（主程序✔翻译✔、exec 环节拒；非 node 特异、无 exec avc、`PROOT_ASSUME_MEMFD_UNSUPPORTED=1` 无效——vivo 加固拦截；对照模拟器 ARM64 同环节 ENOENT）。**设计调整：D-6 ld.so 包装直启从备胎升主路径**，proot 降为可用则用增强；残余风险改挂 R-1′（proot 加固拦截 / PT_INTERP 裸 exec ENOENT→启动器须包装所有 fork+exec / 老固件待探针）。**坑 98** 全量登记（含无线 ADB 熄屏断线、app 域对 /data/local/tmp 无 PROT_EXEC mmap、toybox cp 对 0644 源 Permission denied→cat 直灌）。真机 G4 遗留：R-1′③ 老固件成因待查、G2 引擎起来、G3 完整版 | AI 开发助手 |
| 2026-09-13 | **4Debian G1 实测批（AVD 路线）** | 模拟器路线切官方 AVD（MuMu 登录墙——手机号+7 天试用，用户拍板换线并卸载 MuMu）；AVD 全套本地装齐（Temurin JDK17 / cmdline-tools / emulator 37.1.11 / android-34+35 双镜像，零注册）。**G1 关键证据✅**：Android 14 ARM64 模拟器上 `ld.so + LD_LIBRARY_PATH + node` 直启链完整运行（v22.23.2，V8/模块系统/fs 全活）＝**D-6 glibc 直启备胎前提全部验证**（`ld-linux-aarch64.so.1` 无 PT_INTERP 可被 Android 内核直接 exec；裸 exec 带 PT_INTERP 的 glibc 二进制仍 ENOENT——fork+exec 须全经 ld.so 包装，D-6 启动器设计约束）。proot 完整链在 ARM64 模拟器受阻（**坑 97 三重壁**：MuMu 登录墙 / Apple Silicon 拒 x86_64 镜像 / Termux proot exec 链 Android 14+15 两内核同症 ENOENT，`-v 2` 证实 binary+interp 翻译到位），判决移至真机（与 G4 合并一次实验）。顺修四连：归档剥 `rootfs/dev` + `--hard-dereference`（设备端 mknod/hardlink 双拒实锤，修入 build-rootfs-debian.mjs ⑥）、g1-mumu.sh run.sh guest 路径口径、脚本双 ABI 参数化（arm64/x86_64 自动选载荷）、补 libandroid-shmem（proot Depends 实锤：libandroid-shmem + libtalloc） | AI 开发助手 |
| 2026-09-13 | **4Debian P1 双 ABI 构建 + G1-pre 阻断立案** | **x86_64 构建链全绿 + G3-lite 双 ABI 全过**：x86_64 `snapshot.tar.xz` 82.5MB / 解压 477MB（sha256 `9db9fa1a…`，Rosetta 仿真容器端到端跑通）；G3-lite 双 ABI 证据齐（node 22.23.2 / rg 13 / git 2.39.5 / glibc 2.36 + esbuild 0.28.2 / sharp 直装即用，x86_64 在 Rosetta 下亦过）。**坑 96**：OrbStack 7.0.x 内核 proot 全 tracee SIGSEGV（5.2/5.4 双版本、`PROOT_NO_SECCOMP=1` 无效，echo/id/python/node 全崩）→ 本地 G1-pre 阻断；新脚本 `scripts/rootfs-proot-pre.sh` 加内核主版本 ≥7 护栏（exit 3 + 替代路径）且宿主容器须 trixie+（proot 5.4 需 GLIBC_2.38）；G1-pre 改道 GHA 6.x runner，**G1 本体仍以 MuMu 为准**。顺修：RUN 前建 OUT_DIR（x86_64 首跑 ⑥ tar Cannot open 实锤）。overlay 注入契约研究：`inject-snapshot.py` 走 `home/.dsh/profiles` 前缀，与 Debian 布局（顶层 `home/`）天然兼容；引擎 overlay 闭包组装（265 包）为 P1/P2 接线项 | AI 开发助手 |
