#!/usr/bin/env bash
# g2-emulator.sh — 4Debian P1 G2：Android（模拟器或真机，ARM64）上以 D-6 直启链拉起 dsh 引擎并实测 HTTP。
# 链路：/system/bin/sh → guest ld.so（无 PT_INTERP 自足）→ glibc node → bin.js web --no-open
# env 口径复刻 EngineManager.shellEnv()（PATH/LD_LIBRARY_PATH/HOME/DSH_HOME/TMPDIR/证书）。
# 前置：.deploy-tmp/tools/rootfs-g2-arm64.tar（引擎树已嫁接 + koffi linux_arm64 已补）
# 用法：scripts/g2-emulator.sh [serial]                    # 默认 emulator-5554，端口 3080
#       PORT=3081 SKIP_PUSH=1 scripts/g2-emulator.sh <serial>   # 载荷已在设备时跳过推送
# 真机注意（坑 100）：dsh-mobile app 自身引擎常驻 127.0.0.1:3080 —— 真机复验必须 PORT=3081+，
#       否则 EADDRINUSE（vivo PJZ110 实锤，app 引擎与 shell 域各占各的 netns 无关，loopback 全局共享）。
set -euo pipefail
SER="${1:-emulator-5554}"
PORT="${PORT:-3080}"
FWD=$((PORT + 10000))
ADB="$(cd "$(dirname "$0")/.." && pwd)/.deploy-tmp/tools/platform-tools/adb"
TOOLS="$(cd "$(dirname "$0")/.." && pwd)/.deploy-tmp/tools"
D=/data/local/tmp/g2
STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT

$ADB -s $SER wait-for-device
B=$($ADB -s $SER shell getprop sys.boot_completed | tr -d '\r'); [ "$B" = "1" ] || { echo "✗ 设备未完成引导"; exit 2; }
echo "── 设备：Android $($ADB -s $SER shell getprop ro.build.version.release | tr -d '\r') / $($ADB -s $SER shell getprop ro.product.cpu.abi | tr -d '\r') / $($ADB -s $SER shell getprop ro.product.model | tr -d '\r')"

if [ "${SKIP_PUSH:-0}" = "1" ] && $ADB -s $SER shell "test -f $D/rootfs/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js" 2>/dev/null; then
  echo "── 1/4 跳过推送（SKIP_PUSH=1 且载荷在位）"
else
  echo "── 1/4 推送 G2 载荷（~950MB）"
  $ADB -s $SER shell "rm -rf $D && mkdir -p $D/tmp"
  $ADB -s $SER push "$TOOLS/rootfs-g2-arm64.tar" "$D/rootfs.tar" >/dev/null
  $ADB -s $SER shell "cd $D && tar -xf rootfs.tar && rm rootfs.tar && mkdir -p $D/tmp && test -f $D/rootfs/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js && echo unpacked"
fi

# 设备侧启动脚本（单层调用；全 exec 经 ld.so 包装 = D-6 设计约束；@PORT@ 由宿主 sed 注入）
cat > "$STAGE/g2run.sh" <<'EOS'
#!/system/bin/sh
D=/data/local/tmp/g2
R=$D/rootfs
L=$R/usr/lib/aarch64-linux-gnu
export LD_LIBRARY_PATH=$L
export HOME=$R/home
export DSH_HOME=$R/home/.dsh
export TMPDIR=$R/tmp
export PATH=$R/usr/bin:/system/bin
export SSL_CERT_FILE=$R/etc/ssl/certs/ca-certificates.crt
export CURL_CA_BUNDLE=$R/etc/ssl/certs/ca-certificates.crt
case "$1" in
  start)
    cd $R/home
    exec $L/ld-linux-aarch64.so.1 $R/usr/bin/node --expose-internals \
      $R/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js web --port @PORT@ --no-open
    ;;
  probe)
    # 设备端自检：node fetch 127.0.0.1:@PORT@（不经 adb forward 的原位证据）
    exec $L/ld-linux-aarch64.so.1 $R/usr/bin/node -e '
      fetch("http://127.0.0.1:@PORT@/").then(r => {
        console.log("HTTP", r.status, r.headers.get("content-type") || "");
        process.exit(r.status === 200 ? 0 : 1);
      }).catch(e => { console.log("FETCH_FAIL", e.cause?.code || e.message); process.exit(1); })'
    ;;
esac
echo "usage: g2run.sh start|probe" >&2; exit 64
EOS
sed -i '' "s/@PORT@/$PORT/g" "$STAGE/g2run.sh"
$ADB -s $SER push "$STAGE/g2run.sh" "$D/g2run.sh" >/dev/null
$ADB -s $SER shell "chmod +x $D/g2run.sh"

echo "── 2/4 D-6 链启动引擎（后台，端口 ${PORT}）"
$ADB -s $SER shell "sh $D/g2run.sh start > $D/engine.log 2>&1" &
ENGPID=$!

echo "── 3/4 等 boot 完成（最多 90s）"
OK=0
for i in $(seq 1 90); do
  sleep 1
  $ADB -s $SER shell "grep -q 'dsh web' $D/engine.log 2>/dev/null" && { OK=1; break; }
done
[ "$OK" = 1 ] || { echo "✗ 引擎未在 90s 内就绪；日志尾部："; $ADB -s $SER shell "tail -12 $D/engine.log"; kill $ENGPID 2>/dev/null; exit 3; }
$ADB -s $SER shell "grep 'dsh web' $D/engine.log"

echo "── 4/4 双重验收：设备端 fetch + adb forward 宿主 curl"
$ADB -s $SER shell "sh $D/g2run.sh probe"
$ADB -s $SER forward tcp:$FWD tcp:$PORT >/dev/null
curl -s -o /dev/null -w "宿主经 forward: HTTP %{http_code}\n" http://127.0.0.1:$FWD/
curl -s http://127.0.0.1:$FWD/ | head -c 120; echo

echo "── ALL PASS（G2 · $SER · Android D-6 直启链 · dsh web @${PORT}）"
