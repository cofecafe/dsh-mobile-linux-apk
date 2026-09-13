#!/usr/bin/env bash
# rootfs-smoke.sh — 4Debian P1 G3-lite 烟测：解压产物 → chroot 工具链 → npm 预编译原生包可用性
# 用法（宿主任意，经 docker 平台匹配容器执行）：
#   docker run --rm --platform linux/<arm64|amd64> -v <repo>:/repo -v "$(pwd)/$(dirname $0)":/smoke-src \
#     node:22-bookworm bash /smoke-src/rootfs-smoke.sh /repo/.deploy-tmp/rootfs-debian/<abi>/snapshot.tar.xz
# 说明：tar 里带着构建期 resolv.conf（Docker 内嵌 DNS 127.0.0.11，同网络上下文可用）；
#       出口判据全过 = exit 0；任一失败即非 0（供 CI 门禁复用）。
set -euo pipefail
TARBALL="${1:?用法: rootfs-smoke.sh <snapshot.tar.xz>}"
SMOKE=/tmp/smoke
R=$SMOKE/rootfs

echo "── 解压 $TARBALL"
rm -rf "$SMOKE" && mkdir -p "$SMOKE"
tar -xJf "$TARBALL" -C "$SMOKE"
echo "── 解压树体积: $(du -sh "$R" | cut -f1)  布局: $(ls "$SMOKE" | tr '\n' ' ')"

echo "── 工具链版本"
chroot "$R" /usr/bin/node --version
chroot "$R" /usr/bin/npm --version
chroot "$R" /usr/bin/rg --version | head -1
chroot "$R" /usr/bin/git --version
chroot "$R" /usr/bin/python3 --version
chroot "$R" /usr/bin/ruby --version | head -1
chroot "$R" /usr/bin/ldd --version | head -1

echo "── G3 预编译原生包（esbuild + sharp：glibc 直装即用 = 本方案核心动机）"
chroot "$R" /usr/bin/env HOME=/root npm install --prefix=/root/g3test --no-audit --no-fund esbuild sharp 2>&1 | tail -2
echo "esbuild: $(chroot "$R" /root/g3test/node_modules/.bin/esbuild --version)"
chroot "$R" /usr/bin/env HOME=/root node -e 'const sharp=require("/root/g3test/node_modules/sharp");sharp({create:{width:8,height:8,channels:3,background:"red"}}).png().toBuffer().then(b=>console.log("sharp:",b.length,"bytes PNG OK"))'

echo "── ALL PASS（G3-lite）"
