#!/usr/bin/env node
// build-d6-hook.mjs — 4Debian D-6 启动器原型：编译 d6-exec-hook.c（glibc exec 族拦截器）。
// 产物：.deploy-tmp/tools/d6-exec-hook-<abi>.so（arm64 / x86_64 双 ABI）
// 用法：node scripts/build-d6-hook.mjs [arm64|x86_64]    # 无参 = 双 ABI
import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'scripts/d6-exec-hook.c')
const TOOLS = join(ROOT, '.deploy-tmp/tools')
const ABIS = process.argv[2] ? [process.argv[2]] : ['arm64', 'x86_64']
const PLATFORM = { arm64: 'linux/arm64', x86_64: 'linux/amd64' }
const log = (m) => console.log(`[d6-hook] ${m}`)

if (!existsSync(SRC)) { console.error(`缺源码: ${SRC}`); process.exit(2) }
for (const abi of ABIS) {
  const out = join(TOOLS, `d6-exec-hook-${abi}.so`)
  log(`编译 ${abi} …`)
  execFileSync('bash', ['-c',
    `docker run --rm --platform ${PLATFORM[abi]} -v ${ROOT}:/repo node:22-bookworm ` +
    `gcc -shared -fPIC -O2 -Wall -Wextra -o /repo/${out.slice(ROOT.length + 1)} /repo/scripts/d6-exec-hook.c -ldl`,
  ], { stdio: 'inherit' })
  log(`${abi}: ${out}（${(statSync(out).size / 1024).toFixed(0)}KB）`)
}
log('完成（gdb 里可用 set environment LD_PRELOAD=… 复现加载；判定/包装语义见源码头注）')
