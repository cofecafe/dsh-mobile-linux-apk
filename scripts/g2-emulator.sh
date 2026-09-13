#!/usr/bin/env bash
# g2-emulator.sh — 4Debian P1 G2：模拟器（Android/ARM64）上以 D-6 直启链拉起 dsh 引擎并实测 3080。
# 链路：/system/bin/sh → guest ld.so（无 PT_INTERP 自足）→ glibc node → bin.js web --port 3080 --no-open
# env 口径复刻 EngineManager.shellEnv()（PATH/LD_LIBRARY_PATH/HOME/DSH_HOME/TMPDIR/证书）。
# 前置：.deploy-tmp/tools/rootfs-g2-arm64.tar（引擎树已嫁接 + koffi linux_arm64 已补）
# 用法：scripts/g2-emulator.sh [serial]    # 默认 emulator-5554
set -euo pipefail
SER="${1:-emulator-5554}"
ADB="$(cd "$(dirname "$0")/.." && pwd)/.deploy-tmp/tools/platform-tools/adb"
TOOLS="$(cd "$(dirname "$0")/.." && pwd)/.deploy-tmp/tools"
D=/data/local/tmp/g2
STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT

$ADB -s $SER wait-for-device
B=$($ADB -s $SER shell getprop sys.boot_completed | tr -d '\r'); [ "$B" = "1" ] || { echo "✗ 设备未完成引导"; exit 2; }
echo "── 设备：Android $($ADB -s $SER shell getprop ro.build.version.release | tr -d '\r') / $($ADB -s $SER shell getprop ro.product.cpu.abi | tr -d '\r')"

echo "── 1/4 推送 G2 载荷（~950MB，模拟器共享 FS 数秒）"
$ADB -s $SER shell "rm -rf $D && mkdir -p $D/tmp"
$ADB -s $SER push "$TOOLS/rootfs-g2-arm64.tar" "$D/rootfs.tar" >/dev/null
$ADB -s $SER shell "cd $D && tar -xf rootfs.tar && rm rootfs.tar && test -f $D/rootfs/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js && echo unpacked"

# 设备侧启动脚本（单层调用；全 exec 经 ld.so 包装 = D-6 设计约束）
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
      $R/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 3080 --no-open
    ;;
  probe)
    # 设备端自检：node fetch 127.0.0.1:3080（不经 adb forward 的原位证据）
    exec $L/ld-linux-aarch64.so.1 $R/usr/bin/node -e '
      fetch("http://127.0.0.1:3080/").then(r => {
        console.log("HTTP", r.status, r.headers.get("content-type") || "");
        process.exit(r.status === 200 ? 0 : 1);
      }).catch(e => { console.log("FETCH_FAIL", e.cause?.code || e.message); process.exit(1); })'
    ;;
esac
echo "usage: g2run.sh start|probe" >&2; exit 64
EOS
$ADB -s $SER push "$STAGE/g2run.sh" "$D/g2run.sh" >/dev/null
$ADB -s $SER shell "chmod +x $D/g2run.sh"

echo "── 2/4 D-6 链启动引擎（后台）"
$ADB -s $SER shell "sh $D/g2run.sh start > $D/engine.log 2>&1" &
ENGPID=$!

echo "── 3/4 等 boot 完成（最多 60s）"
OK=0
for i in $(seq 1 60); do
  sleep 1
  $ADB -s $SER shell "grep -q 'dsh web' $D/engine.log 2>/dev/null" && { OK=1; break; }
done
[ "$OK" = 1 ] || { echo "✗ 引擎未在 60s 内就绪；日志尾部："; $ADB -s $SER shell "tail -12 $D/engine.log"; kill $ENGPID 2>/dev/null; exit 3; }
$ADB -s $SER shell "grep 'dsh web' $D/engine.log"

echo "── 4/4 双重验收：设备端 fetch + adb forward 宿主 curl"
$ADB -s $SER shell "sh $D/g2run.sh probe"
$ADB -s $SER forward tcp:13080 tcp:3080 >/dev/null
curl -s -o /dev/null -w "宿主经 forward: HTTP %{http_code}\n" http://127.0.0.1:13080/
curl -s http://127.0.0.1:13080/ | head -c 120; echo

echo "── ALL PASS（G2 · Android 模拟器 · D-6 直启链 · dsh web @3080）"
