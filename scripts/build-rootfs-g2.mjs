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

// node-addon-system 平台包（坑107：flock-F3 补丁在 linux 上 require.resolve 平台包 → 缺包即
// 「Cannot find module .../node-addon-system-linux-arm64/package.json」，会话首回合即炸——
// 引擎 overlay 登记表不含 optional 平台依赖，base-usr 树同缺。版本锁 node-addon-system 的
// package.json optionalDependencies；包内自带 bin/glibc/system.node + bin/landlock-run）
const nasVer = JSON.parse(execFileSync('tar',
  ['-xzOf', join(CACHE, cacheFile('@deepseek-ai/node-addon-system', '0.1.2')), 'package/package.json'], { encoding: 'utf-8' })).optionalDependencies[`@deepseek-ai/node-addon-system-linux-${ABI === 'arm64' ? 'arm64' : 'x64'}`]
if (!nasVer) throw new Error('node-addon-system@0.1.2 未声明平台包版本')
const nasPlat = `@deepseek-ai/node-addon-system-linux-${ABI === 'arm64' ? 'arm64' : 'x64'}`
await overlayTgz(nasPlat, nasVer)
log(`node-addon-system 平台包 ${nasPlat}@${nasVer} 就绪`)

// @napi-rs/canvas 平台包（坑108 同类：optionalDependencies 暗缺 → 引擎警告 Cannot find native
// binding，图片渲染/read_image 全废；版本锁 base-dsh profile 里的 canvas 主包）
const canvasVer = JSON.parse(execFileSync('tar',
  ['-xJOf', BASE_DSH, 'home/.dsh/profiles/web/node_modules/@napi-rs/canvas/package.json'], { encoding: 'utf-8' })).version
const canvasPlat = `@napi-rs/canvas-linux-${ABI === 'arm64' ? 'arm64-gnu' : 'x64-gnu'}`
await overlayTgz(canvasPlat, canvasVer)
log(`canvas 平台包 ${canvasPlat}@${canvasVer} 就绪`)
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
# ── Debian 口味端口适配（P2.5）：@dsh-android 插件把信任 authority 硬编码为 3080（Termux 端口），
#    Debian flavor 引擎在 3081（EngineManager ENGINE_PORT，与 vivo 原应用共存不抢端口）——
#    file-incoming 三条 exact 路由与 browser 插件的 Host 白名单必须同步，否则恒 403 空体。
for f in rootfs/home/.dsh/profiles/*/node_modules/@dsh-android/dsh-android-file-open/lib/route-auth.js \\
         rootfs/home/.dsh/profiles/*/node_modules/@dsh-android/dsh-android-file-open/lib/types/route-auth.d.ts \\
         rootfs/home/.dsh/profiles/*/node_modules/@dsh-android/dsh-android-browser/lib/index.js; do
  [ -f "\$f" ] && sed -i "s/127\\.0\\.0\\.1:3080/127.0.0.1:3081/g; s/localhost:3080/localhost:3081/g" "\$f"
done
grep -r -l 3080 rootfs/home/.dsh/profiles/*/node_modules/@dsh-android/ 2>/dev/null && { echo "残留 3080 硬编码"; exit 6; } || true

# ── ①c shell-termux 配置对齐（坑110 用户实测定版）：上游快照 yml 的 prefix 指
#    files/usr（顶层）——那里只有 Termux 时代孤儿 bash（缺 libtinfo 跑不动）；完整
#    工具链在双层 usr（files/usr/usr/bin/bash + libtinfo ✓ 实测 GUEST-BASH-OK）。
#    bashPath 上游已双 usr；prefix 统一双 usr；home/cwd 保持 files/home（与
#    EngineManager HOME 一致，rootfs 的 home/ 条目经事务 livePath 落位 files/home）。
#    旧包名门禁防 Termux 惯性再泄（坑1：跨应用 uid 私有目录互不可见）。
#    注意两份 home 都要 sed：rootfs/home/.dsh（rootfs tar 内）与顶级 home/.dsh
#    （BASE_DSH 解包残留——apk-asset 步实际打包的是后者，漏 sed 即回退单层）。
for Y in rootfs/home/.dsh/profiles/*/cordis.patch.yml home/.dsh/profiles/*/cordis.patch.yml; do
  [ -f "\$Y" ] && sed -i "s#^\\(\\s*prefix:\\s\\)/data/data/com\\.dsharnessmobile\\.shell4d/files/usr\\s*\\$#\\1/data/data/com.dsharnessmobile.shell4d/files/usr/usr#" "\$Y"
done
grep -qE "^\s*prefix:\s*/data/data/com\.dsharnessmobile\.shell4d/files/usr\s*$" rootfs/home/.dsh/profiles/*/cordis.patch.yml home/.dsh/profiles/*/cordis.patch.yml 2>/dev/null && { echo "prefix 仍指单层 usr（孤儿 bash 区）"; exit 9; } || true
grep -q "/data/data/com\.dsharnessmobile\.shell/" rootfs/home/.dsh/profiles/*/cordis.patch.yml home/.dsh/profiles/*/cordis.patch.yml 2>/dev/null && { echo "yml 泄漏旧应用包名"; exit 10; } || true

echo "[容器] ①b resolv.conf 消毒（坑108：构建容器的 Docker 内部 DNS 会烤进 rootfs——0.x 不可路由，guest 全量出站 ENOTFOUND：模型 API/z.ai/插件市场全断）"
printf "nameserver 223.5.5.5\nnameserver 119.29.29.29\nnameserver 8.8.8.8\n" > rootfs/etc/resolv.conf
grep -q "nameserver 0\." rootfs/etc/resolv.conf && { echo "resolv.conf 仍含 0.x"; exit 7; } || true

echo "[容器] ④d @napi-rs/canvas 平台包（坑108 同类暗缺 → Cannot find native binding，图片渲染废）"
rm -rf /tmp/canvaspkg; mkdir -p /tmp/canvaspkg
tar -xzf "${rp(join(CACHE, cacheFile(canvasPlat, canvasVer)))}" -C /tmp/canvaspkg
for P in rootfs/home/.dsh/profiles/web rootfs/home/.dsh/profiles/headless; do
  [ -d "\$P/node_modules/@napi-rs" ] || continue
  rm -rf "\$P/node_modules/${canvasPlat}"
  cp -a "/tmp/canvaspkg/package" "\$P/node_modules/${canvasPlat}"
done
test -f "rootfs/home/.dsh/profiles/web/node_modules/${canvasPlat}/skia.linux-${ABI === 'arm64' ? 'arm64' : 'x64'}-gnu.node" || { echo "canvas 平台包缺失"; exit 8; }
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
echo "[容器] ⑤¾ 引擎运行时补丁（对齐 Termux 生产件：F2-F7/G1/G2/N1，registry 登记表同一来源）"
node /repo/scripts/patches/apply-patches.mjs rootfs --apply --scope engine

echo "[容器] ④b node-addon-system 平台包（坑107：flock-F3 的 require.resolve 目标，缺包会话首回合即炸）"
rm -rf /tmp/naspkg; mkdir -p /tmp/naspkg
tar -xzf "${rp(join(CACHE, cacheFile(nasPlat, nasVer)))}" -C /tmp/naspkg
rm -rf "\$NM/@deepseek-ai/node-addon-system-linux-${ABI === 'arm64' ? 'arm64' : 'x64'}"
cp -a "/tmp/naspkg/package" "\$NM/@deepseek-ai/node-addon-system-linux-${ABI === 'arm64' ? 'arm64' : 'x64'}"
test -f "\$NM/@deepseek-ai/node-addon-system-linux-${ABI === 'arm64' ? 'arm64' : 'x64'}/bin/glibc/system.node" || { echo "node-addon-system 平台包缺失"; exit 5; }

echo "[容器] ④e pnpm（坑111：引擎装插件 shell 出 pnpm——Debian 基座只有 npm/corepack，pnpm 缺位即「pnpm not found on PATH」插件全装不了）"
rm -rf /tmp/pnpmpkg; mkdir -p /tmp/pnpmpkg
tar -xzf "${rp(join(CACHE, 'pnpm-10.14.0.tgz'))}" -C /tmp/pnpmpkg
mkdir -p rootfs/usr/lib/node_modules
rm -rf rootfs/usr/lib/node_modules/pnpm
cp -a /tmp/pnpmpkg/package rootfs/usr/lib/node_modules/pnpm
# shebang 改 guest 树绝对路径：#!/usr/bin/env node 的 env+单参数模式钩子不支持
# （d6_shebang_interp 无参版本），改 #!/usr/bin/node → 钩子重映射 $D6_ROOT/usr/bin/node 包装 exec
sed -i "1s|.*|#!/usr/bin/node|" rootfs/usr/lib/node_modules/pnpm/bin/pnpm.cjs
ln -sf ../lib/node_modules/pnpm/bin/pnpm.cjs rootfs/usr/bin/pnpm
test -f rootfs/usr/bin/pnpm || { echo "pnpm bin 缺失"; exit 11; }

echo "[容器] ⑤ D-6 启动器钩子（LD_PRELOAD exec 族拦截器，P2 原型）"
mkdir -p rootfs/opt/d6
cp ${rp(join(ROOT, `.deploy-tmp/tools/d6-exec-hook-${TARBALL_ABI}.so`))} rootfs/opt/d6/libd6exec.so
test -f rootfs/opt/d6/libd6exec.so || { echo "d6 钩子缺失"; exit 5; }
echo "[容器] ⑤½ seccomp 补丁（坑104：app 域白名单外 nr 伪造 ENOSYS，只动 libc+ld.so）"
node /repo/scripts/patch-seccomp-syscalls.mjs rootfs --files=usr/lib/aarch64-linux-gnu/libc.so.6,usr/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1
test -f rootfs/usr/lib/aarch64-linux-gnu/libc.so.6 || { echo "libc 缺失"; exit 5; }
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

// ── 4. --apk-asset：产出 debian flavor 的 APK 内嵌资产 ─────────────
// 布局契约（EngineManager 布局复用）：rootfs/ 改名 usr/ + home/ 原样 → debian-rootfs.tar.xz
// （顶层 usr/+home/，解压事务/指纹机制零改动）；同产 debian-rootfs.sha256（不透明指纹串）。
if (process.argv.includes('--apk-asset')) {
  const ASSET_DIR = join(ROOT, 'app/src/debian/assets')
  const sh2 = `#!/bin/bash
set -euo pipefail
cd /tmp && rm -rf apkasset && mkdir apkasset && cd apkasset
echo "[apk-asset] 变换布局 rootfs/ → usr/"
tar -xf ${rp(OUT)}
mv rootfs usr
echo "[apk-asset] xz 压缩（-T0 并行，数分钟）"
tar -c --sort=name usr home | xz -T0 -6 > /repo/${(join(ASSET_DIR, 'debian-rootfs.tar.xz').slice(ROOT.length + 1))}
echo "[apk-asset] 完成"
`
  const { mkdirSync: md } = await import('node:fs')
  md(ASSET_DIR, { recursive: true })
  const sh2Path = join(CACHE, `g2-apk-asset-${TARBALL_ABI}.sh`)
  writeFileSync(sh2Path, sh2)
  execFileSync('bash', ['-c',
    `docker run --rm --platform linux/${ABI === 'x86_64' ? 'amd64' : ABI} -v ${ROOT}:/repo node:22-bookworm bash ${rp(sh2Path)}`,
  ], { stdio: 'inherit' })
  const xzPath = join(ASSET_DIR, 'debian-rootfs.tar.xz')
  const { createHash: ch } = await import('node:crypto')
  const digest = ch('sha256').update(readFileSync(xzPath)).digest('hex')
  writeFileSync(join(ASSET_DIR, 'debian-rootfs.sha256'), digest + '\n')
  log(`APK 资产: ${xzPath}（${(statSync(xzPath).size / 1048576).toFixed(0)}MB）sha256=${digest.slice(0, 12)}…`)
}
