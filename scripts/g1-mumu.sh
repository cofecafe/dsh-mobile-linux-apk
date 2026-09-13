#!/usr/bin/env bash
# g1-mumu.sh — 4Debian P1 G1 本体：MuMu（Android/ARM64）上验证 Termux proot 引导 Debian rootfs。
# 依据：design-4debian.md §4.1 启动链（/system/bin/sh + proot -r rootfs -0）；D-2 proot 来自
#   Termux bionic 包（hb/bin/proot + hb/libexec/proot/loader{,32} + hb/lib/libtalloc.so.2，
#   proot 按 exe 相对路径 ../libexec/proot/loader 找 loader，保持 usr 树结构即可）。
# 工程要点：拒绝多层内联 -e 转义（NodeSource 嵌套引号同款雷）——设备侧脚本与 JS 一律
#   生成文件后 adb push，adb shell 只做单层调用。
# 前置：
#   .deploy-tmp/tools/rootfs-arm64.tar        （snapshot.tar.xz 解压出的裸 tar，toybox tar 可解）
#   .deploy-tmp/tools/proot-arm/data/data/com.termux/files/usr/{bin,libexec,lib}
# 用法：scripts/g1-mumu.sh <adb端口|emulator-XXXX串号> [adb路径]
set -euo pipefail
PORT="${1:?用法: g1-mumu.sh <adb端口|emulator-XXXX> [adb路径]}"
ADB="${2:-$(cd "$(dirname "$0")/.." && pwd)/.deploy-tmp/tools/platform-tools/adb}"
TOOLS="$(cd "$(dirname "$0")/.." && pwd)/.deploy-tmp/tools"
D=/data/local/tmp/g1
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

if [[ "$PORT" == emulator-* ]]; then SER="$PORT"; else
  "$ADB" connect "127.0.0.1:$PORT" >/dev/null; SER="127.0.0.1:$PORT"
fi
"$ADB" devices | grep -q "$SER.*device" || { echo "✗ 设备未连上"; exit 2; }
S="$ADB -s $SER"

ABI=$($S shell getprop ro.product.cpu.abi | tr -d '\r')
REL=$($S shell getprop ro.build.version.release | tr -d '\r'); SDK=$($S shell getprop ro.build.version.sdk | tr -d '\r')
KRN=$($S shell uname -r | tr -d '\r')
echo "── 设备 ABI=$ABI Android=$REL SDK=$SDK 内核=$KRN"
case "$ABI" in
  arm64-v8a) A=arm; TAR=rootfs-arm64.tar ;;
  x86_64)    A=x86; TAR=rootfs-x86_64.tar ;;
  *) echo "✗ 不支持的 ABI=$ABI"; exit 3 ;;
esac

echo "── 1/6 推送载荷（proot ~2MB；rootfs 裸 tar ~480MB，耐心）"
$S shell "rm -rf $D; mkdir -p $D/hb/bin $D/hb/libexec/proot $D/hb/lib $D/tmp"
$S push "$TOOLS/proot-$A/data/data/com.termux/files/usr/bin/proot"              "$D/hb/bin/proot" >/dev/null
$S push "$TOOLS/proot-$A/data/data/com.termux/files/usr/libexec/proot/loader"   "$D/hb/libexec/proot/loader" >/dev/null
$S push "$TOOLS/proot-$A/data/data/com.termux/files/usr/libexec/proot/loader32" "$D/hb/libexec/proot/loader32" >/dev/null
$S push "$TOOLS/talloc-$A/data/data/com.termux/files/usr/lib/libtalloc.so.2"       "$D/hb/lib/libtalloc.so.2" >/dev/null
$S push "$TOOLS/shmem-$A/data/data/com.termux/files/usr/lib/libandroid-shmem.so"  "$D/hb/lib/libandroid-shmem.so" >/dev/null
[ -f "$TOOLS/$TAR" ] || { echo "✗ 缺 $TOOLS/$TAR"; exit 4; }
$S push "$TOOLS/$TAR" "$D/rootfs.tar" >/dev/null

echo "── 2/6 设备端解包 rootfs（toybox tar）"
$S shell "cd $D && tar -xf rootfs.tar && rm rootfs.tar && test -x rootfs/usr/bin/node && echo unpacked"

# 设备侧 runner（单层调用；proot 启动链 = /system/bin/sh → proot(bionic) → glibc node）
cat > "$STAGE/run.sh" <<'EOS'
#!/system/bin/sh
D=/data/local/tmp/g1
export LD_LIBRARY_PATH=$D/hb/lib
export PATH=/system/bin:$PATH
export HOME=$D/rootfs/root
export PROOT_TMP_DIR=$D/tmp
PROOT="$D/hb/bin/proot -r $D/rootfs -0 -b /proc -b /dev -b /sys -b /sdcard"
case "$1" in
  chain)   exec $PROOT $D/rootfs/usr/bin/node $D/g1-chain.js ;;
  esbuild) exec $PROOT $D/rootfs/usr/bin/node $D/g1-esbuild.js ;;
  id)      exec $PROOT /usr/bin/id ;;
  pathtr)  exec $PROOT /bin/sh -c 'echo hi > /tmp/g1 && cat /tmp/g1 && echo path-translation OK' ;;
  *)       exec $PROOT /usr/bin/node "$@" ;;
esac
EOS
cat > "$STAGE/g1-chain.js" <<'EJS'
const { execFileSync } = require("child_process");
for (const cmd of ["/usr/bin/rg --version", "/usr/bin/git --version", "/usr/bin/python3 --version"]) {
  const out = execFileSync("/bin/sh", ["-c", cmd], { encoding: "utf8" }).trim().split("\n")[0];
  console.log("chain:", out);
}
console.log("chain OK (node→sh→glibc binaries under proot)");
EJS
cat > "$STAGE/g1-esbuild.js" <<'EJS'
const { execSync } = require("child_process");
execSync("npm install --prefix=/root/g1 --no-audit --no-fund esbuild", { cwd: "/root", stdio: "inherit" });
console.log("esbuild under proot on Android:", execSync("/root/g1/node_modules/.bin/esbuild --version").toString().trim());
EJS
$S push "$STAGE/run.sh" "$D/run.sh" >/dev/null; $S push "$STAGE/g1-chain.js" "$D/g1-chain.js" >/dev/null; $S push "$STAGE/g1-esbuild.js" "$D/g1-esbuild.js" >/dev/null
$S shell "chmod +x $D/run.sh; mkdir -p $D/rootfs/root"

echo "── 3/6 G1 判据①：proot 引导 glibc node"
$S shell "sh $D/run.sh --version"

echo "── 4/6 判据②：fork+exec 链（node→sh→rg/git/python）"
$S shell "sh $D/run.sh chain"

echo "── 5/6 判据③：深层链 npm→esbuild（ptrace 三层 + 原生二进制）"
$S shell "sh $D/run.sh esbuild"

echo "── 6/6 判据④：假根语义（-0 → uid=0）与路径翻译"
$S shell "sh $D/run.sh id | grep 'uid=0' && echo fake-root OK"
$S shell "sh $D/run.sh pathtr"

echo "── ALL PASS（G1 本体 · MuMu · Termux proot → Debian glibc rootfs）"
