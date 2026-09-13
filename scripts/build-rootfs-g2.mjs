#!/usr/bin/env node
// build-rootfs-g2.mjs — 4Debian P2：一键固化 G2 载荷（Debian rootfs + 设备基座 + 引擎 overlay + koffi 平台包）。
//
// 配方来源（坑 98/99/100 的手工流程固化）：
//   ① Debian rootfs（build-rootfs-debian.mjs 产物 snapshot.tar.xz）
//   ② 仓内 LFS 基座：base-dsh.tar.xz（home/.dsh 纯 JS）+ base-usr-<abi>.tar.xz（引擎本体 + usr/bin/dsh 链接）
//   ③ 引擎 overlay：scripts/snapshot-config/engine-overlay.json 登记表逐包覆盖到目标版本
//      （rootPackage 只换 lib/+README+package.json；packages/vendorTop/nested/pins 全目录替换但保留
//       旧包嵌套 node_modules；sha512 校验 + npm 镜像链；缓存 .deploy-tmp/engine-overlay/ 共享幂等）
//   ④ koffi 平台包补配：树内 build/koffi/linux-<abi>/ 是空壳（坑 99）→ @koromix/koffi-linux-<abi>@<树内版本>
//      双保险放置（loadStatic 平台包路径 + loadDynamic 下划线 triplet 路径）
//   ⑤ 归档：--exclude=rootfs/dev + --hard-dereference（坑 97：设备端 mknod/hardlink 双拒）
//
// 与 Termux 快照流程的差异：不施加 engine scope 补丁（那是 bionic/Termux 适配面；Debian 是 linux-gnu
// 目标，原生行为即正确）；不注入 pnpm/cordis（后续通道按需接线）。
//
// 用法：node scripts/build-rootfs-g2.mjs [arm64|x86_64]     # 默认 arm64
// 输出：.deploy-tmp/tools/rootfs-g2-<abi>.tar
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CFG = (f) => JSON.parse(readFileSync(join(ROOT, 'scripts/snapshot-config', f), 'utf8'))
const ABI = process.argv[2] ?? 'arm64'
const TARBALL_ABI = { arm64: 'arm64', x86_64: 'x86_64' }[ABI]
const KOFFI_ARCH = { arm64: 'arm64', x86_64: 'x64' }[ABI]
if (!TARBALL_ABI) { console.error(`未知 ABI: ${ABI}`); process.exit(2) }

// 宿主路径 → 容器内 /repo 相对路径
const rp = (p) => '/repo' + p.slice(ROOT.length)
const ROOTFS_SRC = join(ROOT, `.deploy-tmp/rootfs-debian/${TARBALL_ABI}/snapshot.tar.xz`)
const BASE_DSH = join(ROOT, 'base/base-dsh.tar.xz')
const BASE_USR = join(ROOT, `base/base-usr-${TARBALL_ABI}.tar.xz`)
const OVERLAY = CFG('engine-overlay.json')
const MIRRORS = CFG('preinstall.json').npmMirrors
const CACHE = join(ROOT, '.deploy-tmp/engine-overlay')
const OUT = join(ROOT, `.deploy-tmp/tools/rootfs-g2-${TARBALL_ABI}.tar`)
const log = (m) => console.log(`[g2] ${m}`)

// ── 0. 前置校验 + LFS 指针自动拉取 ──────────────────────────
if (!existsSync(ROOTFS_SRC)) {
  console.error(`缺 Debian rootfs 快照: ${ROOTFS_SRC}\n先跑: node scripts/build-rootfs-debian.mjs ${TARBALL_ABI}`)
  process.exit(2)
}
const HOOK = join(ROOT, `.deploy-tmp/tools/d6-exec-hook-${TARBALL_ABI}.so`)
if (!existsSync(HOOK)) {
  console.error(`缺 D-6 exec 钩子: ${HOOK}\n先跑: node scripts/build-d6-hook.mjs ${TARBALL_ABI}`)
  process.exit(2)
}
const ensureLfs = async (file) => {
  if (statSync(file).size > 1000) return
  const oid = readFileSync(file, 'utf8').match(/oid sha256:([0-9a-f]{64})/)?.[1]
  if (!oid) { console.error(`${file} 是 LFS 指针但无法解析 oid`); process.exit(2) }
  const url = `https://media.githubusercontent.com/media/cofecafe/dsh-mobile-linux-apk/main/${file.slice(ROOT.length + 1)}`
  log(`拉取 LFS 真身: ${file.slice(ROOT.length + 1)}`)
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer())
  if (createHash('sha256').update(buf).digest('hex') !== oid) { console.error(`LFS sha256 不匹配: ${file}`); process.exit(2) }
  writeFileSync(file, buf)
}
await ensureLfs(BASE_DSH)
await ensureLfs(BASE_USR)

// ── 1. overlay tgz 下载（宿主网络 → 共享缓存，幂等）───────────
mkdirSync(CACHE, { recursive: true })
const cacheFile = (name, version) => `${name.replace('@', '').replace('/', '-')}-${version}.tgz`
const fetchMeta = async (name) => {
  for (const m of MIRRORS) {
    try {
      const r = await fetch(`${m}/${name}`, { signal: AbortSignal.timeout(30000) })
      if (r.ok) return await r.json()
    } catch { /* 下一镜像 */ }
  }
  throw new Error(`元数据不可得: ${name}`)
}
const overlayTgz = async (name, version) => {
  const dest = join(CACHE, cacheFile(name, version))
  if (existsSync(dest)) return dest
  const dist = (await fetchMeta(name))?.versions?.[version]?.dist
  if (!dist) throw new Error(`registry 无此版本: ${name}@${version}`)
  const buf = Buffer.from(await (await fetch(dist.tarball, { signal: AbortSignal.timeout(300000) })).arrayBuffer())
  if (dist.sha512 && createHash('sha512').update(buf).digest('base64') !== dist.sha512) {
    throw new Error(`sha512 不匹配: ${name}@${version}`)
  }
  writeFileSync(dest, buf)
  return dest
}
log(`overlay 下载（root + ${Object.keys(OVERLAY.packages).length} packages + ${Object.keys(OVERLAY.vendorTop ?? {}).length} vendorTop + …）`)
await overlayTgz(OVERLAY.rootPackage.name, OVERLAY.rootPackage.version)
for (const section of ['packages', 'vendorTop', 'pins']) {
  for (const [n, v] of Object.entries(OVERLAY[section] ?? {})) await overlayTgz(n, v)
}
for (const children of Object.values(OVERLAY.nested ?? {})) {
  for (const [n, v] of Object.entries(children)) await overlayTgz(n, v)
}

// koffi 平台包（koffi 不在 overlay 覆盖面 → 版本读基座 tarball 的 package.json，坑 99 精确锁版）
const koffiVer = JSON.parse(execFileSync('tar',
  ['-xJOf', BASE_USR, 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/koffi/package.json'], { encoding: 'utf8' })).version
const koffiPlat = `@koromix/koffi-linux-${KOFFI_ARCH}`
await overlayTgz(koffiPlat, koffiVer)
log(`overlay tgz 就绪 · koffi 平台包 ${koffiPlat}@${koffiVer}`)

// ── 2. manifest（tgz 文件名 + 目标相对 NM 路径；npm 布局下 scoped 名即路径）────
const lines = []
for (const [n, v] of Object.entries(OVERLAY.packages ?? {})) lines.push(`${cacheFile(n, v)}|${n}`)
for (const [n, v] of Object.entries(OVERLAY.vendorTop ?? {})) lines.push(`${cacheFile(n, v)}|${n}`)
for (const [n, v] of Object.entries(OVERLAY.pins ?? {})) lines.push(`${cacheFile(n, v)}|${n}`)
for (const [host, children] of Object.entries(OVERLAY.nested ?? {})) {
  for (const [n, v] of Object.entries(children)) lines.push(`${cacheFile(n, v)}|${host}/node_modules/${n}`)
}
const MANIFEST = join(CACHE, `g2-manifest-${TARBALL_ABI}.txt`)
writeFileSync(MANIFEST, lines.join('\n') + '\n')

// ── 3. 容器构建 ─────────────────────────────────────────────
const keepList = (OVERLAY.keepUnpublished ?? []).map((e) => `'${e.replace(/ \(.+\)$/, '')}'`).join(' ')
const sh = `#!/bin/bash
set -euo pipefail
W=/tmp/g2build; rm -rf "\$W"; mkdir -p "\$W"; cd "\$W"
echo "[容器] ① 解 Debian rootfs + 基座"
tar -xJf ${rp(ROOTFS_SRC)}
tar -xJf ${rp(BASE_USR)} usr/lib/node_modules
cp -a usr/lib/node_modules rootfs/usr/lib/
ln -sf ../lib/node_modules/@deepseek-ai/dsh/lib/bin.js rootfs/usr/bin/dsh
rm -rf rootfs/home/.dsh
tar -xJf ${rp(BASE_DSH)}
cp -a home/.dsh rootfs/home/.dsh
mkdir -p rootfs/tmp rootfs/root rootfs/var/tmp
E=rootfs/usr/lib/node_modules/@deepseek-ai/dsh
NM=\$E/node_modules
echo "[容器] ② 引擎 overlay（登记表驱动，保留旧包嵌套 node_modules）"
n=0
while IFS='|' read -r tgz rel; do
  [ -n "\$tgz" ] || continue
  src="${rp(CACHE)}/\$tgz"; target="\$NM/\$rel"
  test -f "\$src" || { echo "缺 tgz: \$src"; exit 4; }
  saved=""; if [ -d "\$target/node_modules" ]; then saved="\$target.__nm_saved"; rm -rf "\$saved"; mv "\$target/node_modules" "\$saved"; fi
  rm -rf "\$target"; mkdir -p "\$target"
  tar -xzf "\$src" -C "\$target" --strip-components=1
  chmod -R u+rwX "\$target"
  if [ -n "\$saved" ]; then mkdir -p "\$target/node_modules"; mv "\$saved"/* "\$target/node_modules"/ 2>/dev/null || true; rm -rf "\$saved"; fi
  n=\$((n+1))
done < "${rp(MANIFEST)}"
echo "[容器]   覆盖 \$n 包"
echo "[容器] ③ rootPackage（换 lib/ + package.json + README）"
rm -rf "\$E/lib" "\$E/README.md" 2>/dev/null || true
tar -xzf "${rp(join(CACHE, cacheFile(OVERLAY.rootPackage.name, OVERLAY.rootPackage.version)))}" -C "\$E" --strip-components=1
chmod -R u+rwX "\$E"
echo "[容器] ④ koffi 平台包双保险（坑 99）"
rm -rf /tmp/kpkg; mkdir -p /tmp/kpkg
tar -xzf "${rp(join(CACHE, cacheFile(koffiPlat, koffiVer)))}" -C /tmp/kpkg
mkdir -p "\$NM/@koromix/${koffiPlat.split('/')[1]}" "\$NM/koffi/build/koffi/linux_${KOFFI_ARCH}"
cp -a "/tmp/kpkg/package/linux_${KOFFI_ARCH}" "\$NM/@koromix/${koffiPlat.split('/')[1]}/linux_${KOFFI_ARCH}"
cp "/tmp/kpkg/package/linux_${KOFFI_ARCH}/koffi.node" "\$NM/koffi/build/koffi/linux_${KOFFI_ARCH}/"
echo "[容器] ⑤ D-6 启动器钩子（LD_PRELOAD exec 族拦截器，P2 原型）"
mkdir -p rootfs/opt/d6
cp ${rp(join(ROOT, `.deploy-tmp/tools/d6-exec-hook-${TARBALL_ABI}.so`))} rootfs/opt/d6/libd6exec.so
test -f rootfs/opt/d6/libd6exec.so || { echo "d6 钩子缺失"; exit 5; }
echo "[容器] ⑥ 断言 + 归档"
PJ_VER=\$(python3 -c "import json; print(json.load(open('\$E/package.json'))['version'])")
[ "\$PJ_VER" = "${OVERLAY.engineVersion}" ] || { echo "根包版本 \$PJ_VER != ${OVERLAY.engineVersion}"; exit 5; }
test -f "\$E/lib/bin.js" || { echo "lib/bin.js 缺失"; exit 5; }
test -f "\$NM/koffi/build/koffi/linux_${KOFFI_ARCH}/koffi.node" || { echo "koffi 补配缺失"; exit 5; }
for entry in ${keepList}; do
  test -f "\$NM/\$entry/package.json" || { echo "keepUnpublished 缺席: \$entry"; exit 5; }
done
tar -c --hard-dereference --sort=name --numeric-owner --exclude=rootfs/dev -f ${rp(OUT)} rootfs home
echo "[容器] 完成: ${OUT}"
`
const shPath = join(CACHE, `g2-build-${TARBALL_ABI}.sh`)
writeFileSync(shPath, sh)
execFileSync('bash', ['-c',
  `docker run --rm --platform linux/${ABI === 'x86_64' ? 'amd64' : ABI} -v ${ROOT}:/repo node:22-bookworm bash ${rp(shPath)}`,
], { stdio: 'inherit' })
log(`完成: ${OUT}（${(statSync(OUT).size / 1048576).toFixed(0)}MB）`)
log(`引擎 @ ${OVERLAY.engineVersion} · koffi ${koffiVer} 平台包已补`)
