#!/usr/bin/env node
// 坑104 修复器：Android 14 app 域 seccomp 参数敏感过滤杀 glibc 的
// set_robust_list(99)/rseq(293) 真参调用 + clone3(435) nr 级杀。
// 手法：扫 arm64 ELF 里 [movz x8/w8,#NR] 后 4~12B 内的 svc #0，把 svc 换 nop。
// x0（入参指针）残留为返回值 → 非负 → glibc 视为成功。
// 用法：node patch-seccomp-syscalls.mjs <root-dir> [--dry]
import { readdirSync, lstatSync, statSync, realpathSync, readFileSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';

const NRS = [99, 293, 435, 439]; // +439 faccessat2：glibc 2.36 access() 内联 svc，白名单外被 KILL（strace 实锤 si_syscall=439），伪造 ENOSYS 让 glibc 回退老 faccessat
// 改写语义（v2，坑 104 修正）：nr→1301（未实现）→ kernel ENOSYS → glibc 优雅禁用
// robust-list/rseq。v1 的 svc→nop 会让 x0=入参指针被当"成功"→glibc 假注册 rseq
// →锁语义与内核脱钩 → libuv fd 事件瘫痪（无 socket 调用卡 futex 风暴实锤）。
const SVC = Buffer.from([0x01, 0x00, 0x00, 0xd4]);
const NOP = Buffer.from([0x1f, 0x20, 0x03, 0xd5]);
// v3：nr 装载指令 → movn x0,#37 (=x0=-38 ENOSYS)，svc → nop。
// syscall 不发出（白名单外 nr 会被 KILL，ENOSYS 伪造 nr 此路不通——v2 教训），
// x0=-38 让 glibc 走「老内核」优雅禁用路径（v1 的 nop-only 假成功会毒化 rseq 锁语义）。
const MOVN_X0_ENOSYS = [0xa0, 0x04, 0x80, 0x92]; // movn x0, #37（小端）
const dry = process.argv.includes('--dry');
const root = process.argv[2];
// --files a,b,c：只补丁指定相对路径（生产管线用，避免误伤 312 包树内其它 arm64 ELF——
// Rust/musl 静态二进制自带 ENOSYS 回退，但无必要不碰）。缺省 = 走全树（诊断用）。
const filesArg = (process.argv.find(a => a.startsWith('--files=')) || '').slice(8);
const onlyFiles = filesArg ? filesArg.split(',').map(x => x.trim()).filter(Boolean) : null;
if (!root) { console.error('usage: patch-seccomp-syscalls.mjs <root-dir> [--dry] [--files=a,b]'); process.exit(2); }

const enc = (nr) => [0x52800000, 0xd2800000].map(base => base | (nr << 5) | 8)
  .map(w => Buffer.from([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, (w >> 24) & 0xff]));
const movz = (nr) => enc(nr);
const movzNew = () => enc(1301); // ENOSYS 触发 nr

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    if (e === 'dev') continue; // rootfs/dev（/proc 符号链接迷宫，归档本就排除）
    const p = join(dir, e);
    const st = lstatSync(p); // 不跟符号链接（dangling 目标会 ENOENT）
    if (st.isDirectory()) { yield* walk(p); continue; }
    if (st.isSymbolicLink()) {
      // --files 指定项可能是符号链接（g2 工作树 libc.so.6 → libc-2.36.so；asset 归档
      // --hard-dereference 之后才变实体）——解析真实目标补丁，避免版本号硬编码。
      if (onlyFiles && onlyFiles.some(f => p.endsWith(f))) {
        try { yield realpathSync(p); } catch { /* dangling */ }
      }
      continue;
    }
    else if (st.isFile() && st.size > 4096 && st.mode & 0o111) {
      if (onlyFiles && !onlyFiles.some(f => p.endsWith(f))) continue;
      const fd = openSync(p, 'r');
      const head = Buffer.alloc(20);
      readSync(fd, head, 0, 20, 0);
      closeSync(fd);
      if (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46 && head[4] === 2 && head[18] === 0xb7 && head[19] === 0)
        yield p; // ELF64 EM_AARCH64(183)
    }
  }
}

let totalPatched = 0, filesPatched = 0;
for (const p of walk(root)) {
  const data = readFileSync(p);
  let hits = 0;
  const out = Buffer.from(data);
  for (const nr of NRS) {
    for (const pat of movz(nr)) {
      let i = data.indexOf(pat);
      while (i !== -1) {
        for (let gap = 4; gap <= 40; gap += 4) {
          if (out.subarray(i + gap, i + gap + 4).equals(SVC)) {
            // 守卫：mov→svc 区间内不得出现其他 x8/w8 装载或其他 svc（防误伤）
            let clean = true;
            for (let k = 4; k < gap; k += 4) {
              const w = out.readUInt32LE(i + k);
              const isX8Load = (w & 0xFFE0001F) === 0x52800008 || (w & 0xFFE0001F) === 0xD2800008 || w === 0xD4000001;
              if (isX8Load) { clean = false; break; }
            }
            if (clean) {
              Buffer.from(MOVN_X0_ENOSYS).copy(out, i);   // movz nr → movn x0,#37
              NOP.copy(out, i + gap);                      // svc → nop
              hits++;
            }
            break;
          }
        }
        i = data.indexOf(pat, i + 4);
      }
    }
  }
  if (hits) {
    filesPatched++; totalPatched += hits;
    console.log(`${dry ? '[dry] ' : ''}${p}: ${hits} 处 (99/293/435→nop)`);
    if (!dry) writeFileSync(p, out);
  }
}
console.log(`共 ${filesPatched} 文件 / ${totalPatched} 处${dry ? '（dry-run 未写盘）' : ' 已补丁'}`);
// 门禁：--files 精确模式下 0 命中即失败（glibc 升级改指令形态时防静默漏打 → 设备端必死于 SIGSYS）
if (onlyFiles && !dry && totalPatched === 0) {
  console.error('坑104 门禁：指定文件 0 命中，指令形态可能已变，拒绝出货');
  process.exit(6);
}
