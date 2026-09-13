#!/usr/bin/env bash
# rootfs-proot-pre.sh — 4Debian P1 G1-pre：在 Linux 容器内用发行版 proot 验证 rootfs 的
#   路径翻译 / 绑定 / 深层 exec 链（node→npm→原生二进制）。Android 专属面（SELinux、
#   Termux bionic proot、exec 拒绝）不在本脚本范围——那部分是 G1 本体（MuMu）与 G4（真机）。
# 用法（宿主经 docker 平台匹配容器执行）：
#   docker run --rm --platform linux/<arm64|amd64> -v <repo>:/repo node:22-bookworm \
#     bash /repo/scripts/rootfs-proot-pre.sh /repo/.deploy-tmp/rootfs-debian/<abi>/snapshot.tar.xz
# 注意：proot 依赖 ptrace；Docker ≥19.03 默认 seccomp 已放行 ptrace，若环境拦截需
#   --security-opt seccomp=unconfined。出口判据全过 = exit 0。
set -euo pipefail
TARBALL="${1:?用法: rootfs-proot-pre.sh <snapshot.tar.xz>}"
W=/tmp/g1pre
R=$W/rootfs

echo "── 安装 proot（发行版）"
apt-get update -qq && apt-get install -y -qq proot >/dev/null
proot --version | head -1

echo "── 解压 $TARBALL"
rm -rf "$W" && mkdir -p "$W"
tar -xJf "$TARBALL" -C "$W"

PROOT="proot -R $R -0 -b /dev -b /proc -b /sys -b /etc/resolv.conf"
# -R = -r + 建议绑定；-0 假根（设计口径 design-4debian.md §4.1）；显式补 /dev /proc /sys /resolv.conf

echo "── 1/5 基础 exec：node / glibc"
$PROOT /usr/bin/node --version
$PROOT /usr/bin/ldd --version | head -1

echo "── 2/5 fork+exec 链（node 子进程起 rg/grep——ptrace 翻译路径）"
$PROOT /usr/bin/node -e 'const{execFileSync}=require("child_process");for(const t of["/usr/bin/rg --version|head -1","/usr/bin/git --version"]){console.log(execFileSync("/bin/sh",["-c",t],{encoding:"utf8"}).trim())}console.log("fork+exec chain OK")'

echo "── 3/5 文件系统翻译（rootfs 内视角路径 /usr /etc /tmp 写入）"
$PROOT /bin/sh -c 'echo hi > /tmp/g1pre && cat /tmp/g1pre && test -f /etc/resolv.conf && echo "path translation OK" && rm /tmp/g1pre'

echo "── 4/5 深层链：npm 安装并执行原生二进制（node→npm→esbuild，ptrace 三层）"
$PROOT /usr/bin/env HOME=/root npm install --prefix=/root/g1 --no-audit --no-fund esbuild >/dev/null 2>&1
echo "esbuild under proot: $($PROOT /root/g1/node_modules/.bin/esbuild --version)"

echo "── 5/5 假根语义（-0：root 身份与 / 可写性，apt 类工具的前置）"
$PROOT /usr/bin/id | grep -q 'uid=0' && echo "fake-root OK"

echo "── ALL PASS（G1-pre）"
