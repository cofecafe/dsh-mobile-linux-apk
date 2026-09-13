#!/usr/bin/env node
// build-rootfs-debian.mjs — 4Debian P1：Debian rootfs 快照构建器（骨架；dry-run 默认可跑）
//
// 输入：scripts/snapshot-config/rootfs-debian.json（套件/镜像/目标包/剥离清单——雷点 10 清单分离模式）
// 流程：① rootfs 引导（debootstrap minbase；跨 ABI 依赖 qemu-user-static + binfmt）
//        ② 目标包安装（chroot apt-get；跨 ABI 经 qemu-<arch>-static）
//        ③ Node.js 上游源（nodejs.strategy=nodesource 时；Q1 定版后固化）
//        ④ 剥离瘦身（strip.paths + dpkg lists/cache；buildTools.include=false 不装编译链）
//        ⑤ dsh overlay 注入挂钩（复用 inject-snapshot.py 契约——P1 接线，当前占位）
//        ⑥ 归档 snapshot.tar.xz（rootfs/ + home/.dsh + home/.gitconfig，--numeric-owner）
// 输出：.deploy-tmp/rootfs-debian/<abi>/snapshot.tar.xz + .sha256 + rootfs-fingerprint.txt
//
// 状态：P0 骨架（design-4debian.md §6 P1 起实施）。--run 需 Linux 宿主（WSL2/CI）：
//   - 同 ABI 宿主：debootstrap 直接 chroot；
//   - 跨 ABI（x86_64 宿主编 arm64）：需 qemu-user-static 与 binfmt_misc 注册；
//   缺件即拒（不静默降级）。dry-run（默认）打印完整计划与命令，供评审与 CI 冒烟。
//
// 用法：node scripts/build-rootfs-debian.mjs <arm64|x86_64> [--run]
import { spawnSync } from 'node:child_process'
import { mkdirSync, existsSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CFG = JSON.parse(readFileSync(join(ROOT, 'scripts', 'snapshot-config', 'rootfs-debian.json'), 'utf8'))

// ── 参数 ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const RUN = argv.includes('--run')
const ABI = argv.find((a) => !a.startsWith('--')) ?? 'arm64'
if (!['arm64', 'x86_64'].includes(ABI)) {
  console.error('用法: node scripts/build-rootfs-debian.mjs <arm64|x86_64> [--run]')
  process.exit(1)
}
const DEB_ARCH = ABI === 'arm64' ? 'arm64' : 'amd64'
const OUT_DIR = join(ROOT, '.deploy-tmp', 'rootfs-debian', ABI)
const WORK = join(OUT_DIR, 'work')          // 构建工作区
const ROOTFS = join(WORK, 'rootfs')         // Debian 树（D-4 布局）
const HOME_SEED = join(WORK, 'home')        // home/.dsh + home/.gitconfig
const TARBALL = join(OUT_DIR, 'snapshot.tar.xz')

const log0 = (msg) => console.log(`[rootfs-debian/${ABI}] ${msg}`)
const DRY = RUN ? '' : '[dry-run] '

/** 计划步骤登记：dry-run 打印，--run 执行。 */
const plan = []
function step(title, cmd, opts = {}) {
  plan.push({ title, cmd, opts })
  if (!RUN) return
  log0(`▶ ${title}`)
  const r = spawnSync(cmd, { shell: '/bin/bash', stdio: 'inherit', ...opts.spawn })
  if (r.status !== 0) {
    console.error(`步骤失败（exit ${r.status}）：${title}\n  ${cmd}`)
    process.exit(typeof r.status === 'number' ? r.status : 1)
  }
}

log0(`模式=${RUN ? 'RUN' : 'DRY-RUN'}；套件=${CFG.suite}；目标 arch=${DEB_ARCH}`)

// ── 0. 宿主工具链检查（--run 时缺件即拒）───────────────────────────────
function requireTools(tools) {
  const missing = tools.filter((t) => spawnSync('command', ['-v', t], { shell: '/bin/bash' }).status !== 0)
  if (missing.length > 0) {
    console.error(`宿主缺件：${missing.join(', ')}（安装后重试；dry-run 不受影响）`)
    process.exit(2)
  }
}
if (RUN) {
  const cross = process.arch !== (ABI === 'arm64' ? 'arm64' : 'x64')
  requireTools(['debootstrap', 'tar', 'xz', ...(cross ? [`qemu-${DEB_ARCH === 'arm64' ? 'aarch64' : 'x86_64'}-static`] : [])])
  if (process.platform === 'win32') {
    // 与 build-snapshot-013.mjs 同判：Windows 宿主转 WSL 内执行（DSH_NO_WSL_REEXEC=1 跳过）。
    console.error('Windows 宿主请在 WSL 内执行（wsl.exe -e bash -lc "cd <repo> && node scripts/build-rootfs-debian.mjs ' + ABI + ' --run"）')
    process.exit(2)
  }
}

// ── 1. rootfs 引导（debootstrap minbase）───────────────────────────────
// 跨 ABI 二阶段：--foreign 停在解包，再以 qemu-static 跑第二阶段（binfmt 或显式 qemu 调用）。
const MIRROR = CFG.mirrors[0]
const crossArch = process.arch !== (ABI === 'arm64' ? 'arm64' : 'x64')
const stageCmd = crossArch
  ? `debootstrap --variant=${CFG.bootstrap.variant} --foreign --arch=${DEB_ARCH} ${CFG.suite} ${ROOTFS} ${MIRROR} && ` +
    `cp $(command -v qemu-${DEB_ARCH === 'arm64' ? 'aarch64' : 'x86_64'}-static) ${ROOTFS}/usr/bin/ && ` +
    `chroot ${ROOTFS} /debootstrap/debootstrap --second-stage`
  : `debootstrap --variant=${CFG.bootstrap.variant} --arch=${DEB_ARCH} ${CFG.suite} ${ROOTFS} ${MIRROR}`
if (RUN) {
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(ROOTFS, { recursive: true })
  mkdirSync(join(HOME_SEED, '.dsh'), { recursive: true })
}
step('① debootstrap 引导 rootfs', stageCmd)

// ── 2. 目标包安装（chroot apt-get）─────────────────────────────────────
const targets = [...CFG.targets, ...(CFG.buildTools.include ? CFG.buildTools.packages : [])]
const APT_CONF = `Acquire::Check-Valid-Until false; APT::Get::AllowUnauthenticated false;`
step('② apt update + 安装目标包',
  `printf '%s\\n' '${APT_CONF}' > ${ROOTFS}/etc/apt/apt.conf.d/99-dsh-build && ` +
  `chroot ${ROOTFS} env DEBIAN_FRONTEND=noninteractive apt-get update && ` +
  `chroot ${ROOTFS} env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${targets.join(' ')}`)

// ── 3. Node.js（nodesource 时）─────────────────────────────────────────
if (CFG.nodejs.strategy === 'nodesource') {
  step(`③ NodeSource nodejs ${CFG.nodejs.major}.x（Q1 定版前可换 distro）`,
    `chroot ${ROOTFS} env DEBIAN_FRONTEND=noninteractive bash -c ` +
    `"'curl -fsSL https://deb.nodesource.com/setup_${CFG.nodejs.major}.x | bash - && apt-get install -y --no-install-recommends nodejs'"`)
} else {
  log0(`${DRY}③ nodejs 走发行版包（strategy=distro，已在 targets 或需补入）`)
}

// ── 4. 剥离瘦身（strip.paths；dpkg status 保留——Q6）───────────────────
const stripCmds = CFG.strip.paths
  .map((p) => `rm -rf ${ROOTFS}${p}`)
  .join(' && ')
step('④ 剥离瘦身（doc/man/locale/lists/cache/log）', stripCmds)

// ── 5. dsh overlay 注入挂钩（P1 接线；当前占位）────────────────────────
// 契约对齐 inject-snapshot.py：归档前注入引擎 overlay/插件 seed；home seed 复用
// snapshot-config/seed-settings.yaml 模板（@@PREFIX@@ 占位口径见 build-snapshot-013.mjs）。
if (RUN) {
  // TODO(P1): python3 scripts/inject-snapshot.py <abi> --rootfs ${ROOTFS} --home ${HOME_SEED}
  log0('⑤ overlay 注入挂钩：P1 接线（当前骨架占位，见 design-4debian.md §5）')
} else {
  log0(`${DRY}⑤ overlay 注入挂钩：P1 接线（占位）`)
}

// ── 6. 归档 + 指纹（rootfs/ + home/，--numeric-owner）──────────────────
step('⑥ tar.xz 归档（owner=0）',
  `cd ${WORK} && tar --numeric-owner --sort=name ` +
  `${process.env.SOURCE_DATE_EPOCH ? `--mtime=@${process.env.SOURCE_DATE_EPOCH} ` : ''}` +
  `-cJf ${TARBALL} rootfs home`)

// ── 7. 校验和 + 指纹报告（UpdateManager manifest 口径 {url,sha256,size}）──
if (RUN) {
  const sha = createHash('sha256').update(readFileSync(TARBALL)).digest('hex')
  writeFileSync(TARBALL + '.sha256', `${sha}  snapshot.tar.xz\n`)
  const size = statSync(TARBALL).size
  writeFileSync(join(OUT_DIR, 'rootfs-fingerprint.txt'),
    `abi=${ABI}\nsuite=${CFG.suite}\narch=${DEB_ARCH}\nsha256=${sha}\nsize=${size}\nchannel=debian\n`)
  log0(`完成：${TARBALL}（${(size / 1024 / 1024).toFixed(1)} MB，sha256=${sha.slice(0, 12)}…）`)
} else {
  const pkgCount = targets.length
  const volume = `rootfs 预估 xz 300-350MB / 解压 ~1GB（R-3，实测为准）`
  log0(`${DRY}计划就绪：${plan.length} 个执行步骤；目标包 ${pkgCount} 个；${volume}`)
  log0(`${DRY}产物：${TARBALL}（rootfs/ + home/ 布局 = D-4 提案，P2 定案）`)
  for (const s of plan) console.log(`  - ${s.title}\n      ${s.cmd.replace(/\n/g, ' ')}`)
}
