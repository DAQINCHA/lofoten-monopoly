#!/bin/bash
# 罗弗敦大富翁 —— 双击启动本地服务
# 会先停掉占用 5200 端口的旧进程，再重新启动，然后自动打开浏览器
# 注意：本脚本与 node 服务同属一个进程组，关闭终端窗口（任何方式）
# 都会通过 trap 把服务一起停掉。

DIR="/Users/daqincha/Library/Mobile Documents/com~apple~CloudDocs/Coding/mini-games/lofoten-monopoly"
PORT=5200
LOG=/tmp/lofoten-monopoly.log

cd "$DIR" || { echo "找不到项目目录：$DIR"; exit 1; }

# 挑一个可用的 node：优先系统 PATH，其次 WorkBuddy 自带的
if command -v node >/dev/null 2>&1; then
  NODE=node
elif [ -x "/Users/daqincha/.workbuddy/binaries/node/versions/22.22.2-6/bin/node" ]; then
  NODE="/Users/daqincha/.workbuddy/binaries/node/versions/22.22.2-6/bin/node"
else
  echo "❌ 没找到 node，先安装 Node.js 再运行"
  exit 1
fi

# 停掉旧进程（改过代码后必须重启才会生效）
PID=$(lsof -ti tcp:$PORT 2>/dev/null)
if [ -n "$PID" ]; then
  echo "正在停止旧服务（PID $PID）…"
  kill $PID 2>/dev/null
  sleep 1
fi

# 启动 node（不使用 nohup，使其留在当前进程组，随终端一起结束）
"$NODE" server.js > "$LOG" 2>&1 &
NODE_PID=$!

# 任何导致脚本退出的方式（回车退出 / 关闭窗口收到 SIGHUP / Ctrl-C）
# 都把 node 服务一起停掉
cleanup() {
  if kill -0 "$NODE_PID" 2>/dev/null; then
    echo ""
    echo "正在停止服务（PID $NODE_PID）…"
    kill "$NODE_PID" 2>/dev/null
  fi
}
trap cleanup EXIT INT HUP TERM

echo "启动中…"
sleep 2

# 等服务起来
for i in 1 2 3 4 5; do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/api/status"; then break; fi
  sleep 1
done

LAN=$(ipconfig getifaddr en0 2>/dev/null)
echo ""
echo "  ✅ 罗弗敦大富翁已启动"
echo "  本机:   http://localhost:$PORT"
[ -n "$LAN" ] && echo "  局域网: http://$LAN:$PORT"
echo "  日志:   $LOG"
echo ""
echo "服务随本终端运行，关闭窗口（或按回车）即停止服务。"
read _

# read 返回后脚本正常退出，EXIT trap 会停掉服务
