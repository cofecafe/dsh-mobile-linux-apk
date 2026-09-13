# 4Debian：Debian 用户态运行时决策与实施蓝图（ADR-D）

> 版本 v0.2（P1 进行中）｜ 2026-09-13 ｜ 分支 `4Debian`（未合入 main）｜ 状态：方向已决策；**P1 首战：arm64 rootfs 构建链全绿 + G3-lite 烟测全过**（esbuild/sharp 预编译包直装即用）；G1/G2（proot+模拟器）、G4（Android 16 真机）未做。v0.1.1：R-7 补 macOS 宿主路径（Docker 平台容器，当前开发机）。
> 决策一句话：**APK 发布形态不变；把 APK 内嵌用户态从 Termux 快照换为 Debian rootfs（proot 引导、无 root），作为可在线下发的第二运行通道；全部改动在 `4Debian` 分支管理。**

---

## 1. 背景与动机

README 的插件市场警示是直接动因：内置市场**绝大多数插件在手机端不一定可用**。根因在 Termux 用户态的两个先天差异：

| Termux（现状） | 差异造成的后果 | Debian（目标） |
|---|---|---|
| Bionic libc | npm 预编译原生模块（esbuild / sharp / @swc/core / better-sqlite3 / lightningcss …）全是 glibc 链接，装上即崩 | 同为 glibc，**预编译产物直接可用** |
| 前缀式布局（`files/usr`，非 FHS） | 硬编码 `/usr`、`/etc` 的工具与脚本要靠环境变量补丁续命 | 标准 FHS，路径语义与桌面 Linux 一致 |
| Termux 仓库 | 包数量有限，冷门依赖缺位 | 全量 apt 生态 |
| 4KB 页构建 | 16KB 页设备需专门迁移（见 docs/design.md §ABI） | GNU aarch64 工具链默认 64KB 段对齐，**天然兼容 16KB 页**（风险登记里反而是利好，R-8） |

Python 侧同理：manylinux wheel 在 Termux 只能源码编译（常失败），在 Debian 直接可用。

## 2. 决策记录

| # | 决策 | 理由 |
|---|---|---|
| D-0 | **APK 发布形态完全不变**（壳层 Kotlin/WebView/桥/保活/更新一概不动） | 壳层解决的是「怎么在安卓上活下来」，与用户态无关；换形态零收益、全风险 |
| D-1 | 内嵌用户态引入 **Debian bookworm rootfs**，经 **proot**（ptrace，无 root）引导 | 无 root 下唯一成熟的完整用户态方案（UserLAnd / Andronix / proot-distro 先例）；glibc + FHS 正面命中动机 |
| D-2 | proot 本体取自 **Termux 仓库的 bionic proot 包**，放宿主侧（不入 rootfs） | proot 是引导器不是被引导物；bionic 编译才能在 app 域 + 系统 linker 下启动 |
| D-3 | **双轨制**：APK 内嵌 Termux 快照不动（全设备保底），Debian rootfs 作为**在线更新可选通道**下发 | Android 16 exec 拒绝（R-1）未解前，Debian 通道不能承担保底职责；也规避 APK 体积翻倍（R-3） |
| D-4 | 快照布局提案：`rootfs/` + `home/.dsh` + `home/.gitconfig`（现布局为 `usr/` + `home/`） | Debian 树自带 bin/etc/lib/usr/var，需要自己的根；`rootfs/` 语义清晰（P2 定案，见 Q2） |
| D-5 | 启动链沿用「`/system/bin/sh` + LD_PRELOAD exec 钩子」先例（EngineManager 现行机制） | Android 16 上 app 域直接 execve app-data ELF 会被拒（实锤见 R-1），必须走系统入口 |
| D-6 | 性能不达标即切 **glibc 直启**备胎模式（同一 rootfs，patchelf PT_INTERP 或 `ld-linux` 显式调用，无 ptrace） | proot 开销是最大性能风险（R-2）；备胎与主案共享全部 rootfs 资产，只换启动器 |
| D-7 | 分支纪律：全部改动进 `4Debian`，**不动 main**；P1 三门禁（G1-G3）全绿前不开 PR | 仓库 PR 铁律 + 模拟器优先定例（AGENTS.md §1） |

## 3. 否决的替代方案

| 方案 | 否决理由 |
|---|---|
| **整机 Debian 系统**（刷机/postmarketOS 路线） | 需解锁 bootloader + 每机型内核适配；「任意安卓机装包即用」直接归零；壳层全部 Android 权能作废。与「提高适应能力」背道而驰 |
| **Termux + glibc 混合层**（termux-glibc 式，bionic 主环境 + glibc 补丁层） | 治标：预编译二进制仍需逐个 patchelf/包装，路径/证书/NSS 补丁面失控；不是受支持的组合，维护成本高于 proot |
| **维持纯 Termux 现状** | 插件兼容性问题无解（npm 原生模块是重灾区）；等于接受 README 里的警示永久成立 |

## 4. 目标架构

### 4.1 启动链对比

现状（Termux）：

```
app(Java exec) → /system/bin/sh（LD_PRELOAD=libtermux-exec-ld-preload.so）
  → execve files/usr/bin/node →【Android16：钩子改走 /system/bin/linker64】→ node (bionic) dsh web → 127.0.0.1:3080
```

目标（4Debian，双轨之二）：

```
app(Java exec) → /system/bin/sh（LD_PRELOAD=bionic exec 钩子，同现状）
  → execve files/proot/bin/proot（Termux bionic 包）
    → proot -r files/rootfs -0
        -b /dev -b /proc -b /sys -b /system -b /sdcard -b /storage/emulated/0
        /usr/bin/env -i HOME=/root PATH=/usr/local/bin:/usr/bin:/bin …
      → /usr/bin/node (glibc) dsh web → 127.0.0.1:3080
```

**R-1 断点**：proot 内 tracee（glibc 进程）再 execve 子进程（node→npm→esbuild 等）时，execve 发生在 glibc 进程里，bionic 钩子不生效——Android 16 exec 拒绝设备上会 EACCES。候选缓解 A/B/C 见 §7 R-1，**P1 第一优先验证**。

### 4.2 快照布局（D-4 提案）

```
snapshot.tar.xz（xz，owner=0）
├── rootfs/            ← Debian bookworm 完整树（bin etc lib usr var tmp …）
├── home/.dsh/         ← seed（与现快照同源：seed-settings.yaml / profiles）
└── home/.gitconfig
```

解压目标：`files/rootfs` + `files/home`。`SnapshotExtractor` 的绝对符号链接放行规则（坑 45：`runtimeRoot` 前缀判据）需从 `files/usr/...` 改写为 `files/rootfs/...` 口径。

### 4.3 DNS 与网络

Android 无 `/etc/resolv.conf`，glibc 解析器会读它。壳侧在引擎启动前生成：

```
EngineManager → ConnectivityManager.getLinkProperties(activeNetwork).dnsServers
             → 写 files/rootfs/etc/resolv.conf（nameserver 行，IPv4/IPv6）
```

私有 DNS（PrivateDNS/DoT）下方差在 P2 实测（R-4）。

### 4.4 更新协议双轨（D-3）

- `UpdateManager` manifest `{url, sha256, size}` 结构复用，扩展 `channel: "termux" | "debian"` 字段；
- 设备能力探针（Android 版本 + R-1 PoC 结论）决定可下发通道：探针不过 → 只见 Termux 通道（现状行为，零回归）；
- 首版 Debian rootfs 走在线更新下发，**不内嵌进 APK**——APK 体积不变（R-3 缓解）。

## 5. 与现有代码的集成点（精确到文件）

| 现有模块 | 现状职责 | 4Debian 改动（P2 落地） |
|---|---|---|
| `EngineManager.shellEnv()`（EngineManager.kt:1181 起） | PATH / LD_LIBRARY_PATH / TERMUX_* / LD_PRELOAD(bionic 钩子) / 证书 env | 增加 `launchMode` 分支：proot 参数组装、rootfs 内路径映射、resolv.conf 生成时机 |
| `SnapshotExtractor`（runtimeRoot=filesDir） | 解压 `usr/`+`home/`，放行指向 `files/usr/...` 的绝对链接（坑 45） | 布局判据改 `rootfs/`；Termux 残留/`../` 逃逸拒绝逻辑复用 |
| `SnapshotTransaction` | 暂存解压 → 原子交换 → 指纹提交 | 布局无关，**复用不改** |
| `UpdateManager` | manifest 驱动快照替换 | `channel` 字段 + 探针门控 |
| `build-snapshot-013.mjs` + `scripts/snapshot-config/*` | Termux 快照构建（清单/编排分离，雷点 10 模式） | 平行新增 `build-rootfs-debian.mjs` + `rootfs-debian.json`，同一模式 |
| `inject-snapshot.py` / `inject-all.py` | 插件与 overlay 注入归档 | P1 接线（rootfs 内 DSH_HOME 布局等价映射） |
| `ConsoleActivity` / `console.html` | 内嵌 Termux bash 终端 | proot 内 bash（交互延迟实测见 Q5） |
| `check-third-party.mjs` / `elf-check.mjs` / `check-snapshot-secrets.mjs` | Termux 口径门禁 | P5 适配：dpkg copyright（`/usr/share/doc/*/copyright`）→ LICENSES 三形态、glibc ELF 检查口径 |
| `plugins/linux-env` | 导出环境配方（含 Termux 路径假设） | P2 盘点硬编码面（Q4） |

## 6. 阶段计划与门禁

| 阶段 | 内容 | 出口门禁 |
|---|---|---|
| **P0**（本提交） | ADR 文档 + rootfs 构建骨架与配置（dry-run 默认）+ 分支建立 | 骨架 dry-run 可跑 |
| **P1** rootfs PoC | debootstrap minbase → 装包 → 瘦身 → 归档；引导链实测 | **G1✅G2✅G3-lite✅（G4 核心证据已取）**：构建链双 ABI 绿；G1 = 真机/模拟器/shell+app 域 D-6 链全绿（R-1 反转，坑 98）；**G2 = dsh 引擎（0.1.1-rc.2 基座嫁接 + koffi linux_arm64 补配，坑 99）在 Android 14 模拟器以 D-6 链跑起 `dsh web` @3080，设备端 fetch + adb forward 双 HTTP 200**；G3-lite 双 ABI（esbuild/sharp 直装即用）；proot 降为增强（vivo EACCES / 模拟器 ENOENT）。余项：G3 完整版、引擎 overlay 升级至 0.1.5-rc.1 接线（P2）、真机 G2 复验 |
| **P2** 壳侧集成 | 解压契约、启动链、DNS、绑定表、控制台、探针 | MuMu 模拟器 V1-V8 矩阵全绿 |
| **P3** 更新双轨 | manifest channel 扩展、探针门控、灰度下发 | 模拟器上双通道切换/回退无残留 |
| **P4** 性能门禁 | 对比 Termux 基线：引擎冷启、pnpm install（中型仓）、rg 大仓搜索、git status（大仓） | 阈值 **≤3×**；超限 → D-6 备胎评估或终止决策（回滚成本 = 弃分支，main 零污染） |
| **P5** 合规与门禁 | GPL 三形态扩展、elf-check、third-party、secrets 适配 | 全部既有门禁在 rootfs 口径下绿 |
| **P6** 真机矩阵 | Android 16 vivo（exec 拒绝实锤机，**必测**）+ 常规真机 + 发布说明 | V1-V8 + 厂商回归；release notes 标注「Debian 通道实验特性」 |

模拟器优先定例（AGENTS.md §1）全程适用：每阶段 MuMu 实测不过不进下一步。

## 7. 风险登记（按严重度降序）

- **R-1【已反转·2026-09-13 真机实测】Android 16 exec 拒绝**：EngineManager.kt:1212 注释宣称的拒绝在 vivo PJZ110/Android 16/SDK 36（2026-09 实测）**不成立**——app 域从 `files/`、`code_cache/` exec glibc 自足 ELF（ld.so）全部成功，且自足 D-6 链（ld.so+node+8 库）完整运行（坑 98）。**残余真风险（改挂 R-1′）**：① vivo 加固拦截 **proot** 的 exec 机制（EACCES，`PROOT_ASSUME_MEMFD_UNSUPPORTED` 无效）——proot 增强路径在此类设备不可用；② 裸 exec 带 PT_INTERP 的 glibc 二进制仍 ENOENT（宿主命名空间无 `/lib/ld-linux`）——**D-6 启动器必须包装所有 fork+exec**（`ld.so <bin>` 形式）；③ 历史「拒绝」成因待查（若为系统版本差异，老版本 vivo 固件仍可能拒绝——下发前跑能力探针，D-3 双轨不变）。**设计调整：D-6 ld.so 包装直启升为主路径**，proot 降为可用则用的增强。
- **R-2【高】proot ptrace 开销**：fork/stat 密集操作（pnpm install、git、大仓 rg）常见 1.5-3× 慢。P4 阈值卡门；备胎 D-6（glibc 直启，无 ptrace；但 R-1 同样适用于直启链）。
- **R-3【低→实测好于预估】体积**：**P1 实测 arm64：xz 78.4MB / 解压 505MB**（原预估 300–350MB / ~1GB——minbase + 剥离干净 + 无编译链的收益；参照 Termux 快照 xz ~155MB / 解压 ~740MB）。注意尚未注入 dsh overlay/插件，最终体积待注入后复核。D-3 双轨 + 在线下发仍保留（APK 不膨胀）。解压时长窗口（坑 37 口径）预计短于现快照。
- **R-4【中】DNS/网络**：resolv.conf 生成时机（每次引擎启动前）、VPN / 私有 DNS 方差（P2 实测）。
- **R-5【中】厂商方差**：SELinux 域收紧机型、存储挂载差异影响 `-b` 绑定表（MIUI 兼容前科；按机型回归）。
- **R-6【中】GPL 合规面扩大**：Debian 包大量 GPL/AGPL；三形态在场规则（docs/AGENTS/gpl-compliance.md）需扩展到 dpkg copyright 抽取链路。
- **R-7【低→已实锤一次】构建环境**：宿主三选一——① Linux 原生（跨 arch 走 qemu-user-static/binfmt）；② Windows WSL2（沿用 build-snapshot-013 模式）；③ **macOS：Docker 平台匹配容器**（`node:22-bookworm --platform` 按目标 ABI，容器内原生 debootstrap、无需 qemu；**当前开发机即此路径**，骨架已内建自动转入，`DSH_ROOTFS_NO_DOCKER=1` 或缺 Docker 即拒）。**P1 实锤（坑 95）**：macOS 卷挂载不允许 mknod → debootstrap 误判 nodev 拒装；修法 = 构建工作区放容器内部（`DSH_ROOTFS_WORK=/tmp/rootfs-work` 自动注入），只回写最终产物，万级小文件 I/O 留在 overlayfs。GHA 免费 arm64 runner 仅 public 仓库——本仓镜像面可承担，协调仓私有侧 qemu 兜底。
- **R-8【利好】16KB 页**：GNU aarch64 工具链默认 64KB 段对齐，glibc rootfs 天然兼容 16KB 页设备（Termux 包需专门迁移——本仓 docs/design.md §ABI 已记）。

## 8. 分支管理与纪律

- **本分支（`4Debian`）承载全部实验改动，不直推 main**（PR 铁律）；P1 G1-G3 全绿前不开 PR，PR 打 experimental 标签。
- **坑 36 镜像纪律**：本分支新增文件（design-4debian.md / build-rootfs-debian.mjs / rootfs-debian.json）不触碰 `scripts/patches/**`、`build-apk-013.ps1` 等逐字节镜像面；P2 起若必须改镜像文件，双仓同批提交。
- **坑登记**：P1 实测发现的新坑按 `docs/AGENTS/gotchas.md` 递增编号登记（先 `grep -c '^[0-9]\+\. \*\*' docs/AGENTS/gotchas.md` 现数，不凭记忆）。
- **版本口径**：Debian 通道属于实验特性，UI/桥侧不出现「内部口径分裂」（DSH_APP_VERSION 单一来源定例沿用）。

## 9. 开放问题

| # | 问题 | 决策时点 |
|---|---|---|
| Q1 | node 来源：NodeSource 22.x vs bookworm 自带 nodejs 18.19（引擎基线 nodejs-lts） | P1 实装 NodeSource **22.23.2**（构建+烟测绿）；待与引擎 nodejs-lts 基线终核后定版 |
| Q2 | 快照布局定案：`rootfs/` vs 复用 `usr/` 装 Debian 树 | P2（倾向 `rootfs/`，D-4） |
| Q3 | R-1 缓解 A 的 linker64 装载 glibc ELF 可行性 | P1 第一优先 PoC（G4） |
| Q4 | 插件/DSL 里 Termux 路径硬编码面盘点（linux-env 环境配方等） | P2 |
| Q5 | console.html 经 proot bash 的交互延迟可接受性 | P2 实测 |
| Q6 | rootfs 内 dpkg 数据库保留策略（影响后续在线 apt 能力 vs 体积） | P1 |

---

*本文档由 4Debian 分支 P0 提交建立；后续每阶段完成时同步更新状态行与门禁记录（AGENTS.md 主动更新条款）。*
