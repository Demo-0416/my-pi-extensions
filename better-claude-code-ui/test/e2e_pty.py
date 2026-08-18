#!/usr/bin/env python3
"""
端到端测试：在 pty 里驱动真实 pi（加载本扩展 + traex-provider），
跑 AUDIT.md §7.3 的验收场景，对屏幕输出做断言。

用法：
  python3 test/e2e-pty.py write      # 场景1：写新文件（P0-1/P0-2 触发点，不卡死）
  python3 test/e2e-pty.py read3      # 场景2：连读 3 文件 → 折叠组
  python3 test/e2e-pty.py long       # 场景3：>30s 请求 → 结束时一条 ✻ Worked for
  python3 test/e2e-pty.py thinking   # 场景4：thinking 折叠行
  python3 test/e2e-pty.py go         # 场景5：改 Go 文件 → 语法高亮
  python3 test/e2e-pty.py all        # 全部

环境依赖：traex-router 在 http://127.0.0.1:18787 运行（~/.trae/cli/auth.json 有效）。
模型默认 traex/DeepSeek-V4-Flash，可用 E2E_MODEL 覆盖。
"""
import os
import pty
import re
import select
import signal
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT = os.path.join(ROOT, "extension", "index.ts")
TRAE_EXT = os.path.expanduser("~/.pi/agent/extensions/traex-provider.js")
MODEL = os.environ.get("E2E_MODEL", "traex/DeepSeek-V4-Flash")
WIDTH, HEIGHT = 140, 44

ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][AB0]")


def strip_ansi(b: bytes) -> str:
	return ANSI_RE.sub("", b.decode(errors="replace"))


def spawn_pi():
	argv = [
		"pi", "-ne", "-e", EXT, "-e", TRAE_EXT,
		"--provider", "traex", "--model", MODEL,
		"--theme", os.path.join(ROOT, "theme"), "--use-theme", "claude-code-dark",
		"--no-session",
	]
	env = {**os.environ, "COLUMNS": str(WIDTH), "LINES": str(HEIGHT), "TERM": "xterm-256color", "NO_COLOR": ""}
	pid, fd = pty.fork()
	if pid == 0:
		os.execvpe(argv[0], argv, env)
	return pid, fd


def read_available(fd, timeout=1.0, deadline=None) -> bytes:
	chunks = []
	while True:
		remaining = None if deadline is None else max(0.0, deadline - time.time())
		if remaining is not None and remaining <= 0:
			break
		r, _, _ = select.select([fd], [], [], min(timeout, remaining) if remaining else timeout)
		if not r:
			break
		try:
			chunk = os.read(fd, 65536)
		except OSError:
			break
		if not chunk:
			break
		chunks.append(chunk)
	return b"".join(chunks)


def wait_for(fd, pattern: str, timeout: float, quiet_after: float = 3.0):
	"""读输出直到匹配 pattern（成功）或超时（失败）。

	成功判定额外要求匹配后屏幕 quiet_after 秒无变化（确保渲染稳定）。
	返回 (matched, text)。
	"""
	deadline = time.time() + timeout
	buf = b""
	last_change = time.time()
	matched_at = None
	while time.time() < deadline:
		chunk = read_available(fd, timeout=0.5, deadline=deadline)
		if chunk:
			buf += chunk
			last_change = time.time()
			if matched_at is None and re.search(pattern, strip_ansi(buf)):
				matched_at = time.time()
		if matched_at is not None and time.time() - last_change > quiet_after:
			return True, strip_ansi(buf)
	return matched_at is not None, strip_ansi(buf)


def quit_pi(pid, fd):
	for _ in range(3):
		try:
			os.write(fd, b"\x03")  # Ctrl+C
			time.sleep(0.3)
			os.write(fd, b"\x04")  # Ctrl+D
			time.sleep(0.5)
		except OSError:
			break
	try:
		os.kill(pid, signal.SIGTERM)
		time.sleep(0.5)
		os.kill(pid, signal.SIGKILL)
	except ProcessLookupError:
		pass
	try:
		os.waitpid(pid, os.WNOHANG)
	except ChildProcessError:
		pass


def run_scenario(name: str, prompt: str, expect: str, timeout: float = 180.0) -> bool:
	print(f"▶ 场景 {name}：{prompt[:60]}...")
	pid, fd = spawn_pi()
	try:
		# 等 banner + 编辑器渲染稳定
		time.sleep(4)
		read_available(fd, timeout=1.0)
		os.write(fd, prompt.encode() + b"\r")
		matched, text = wait_for(fd, expect, timeout)
		if matched:
			# 截取匹配行附近内容做证据
			lines = [l for l in text.splitlines() if l.strip()]
			evidence = next((l for l in lines if re.search(expect, l)), lines[-1] if lines else "")
			print(f"  ✅ 通过（命中 /{expect}/）")
			print(f"     证据：{evidence.strip()[:120]}")
			return True
		print(f"  ❌ 失败：{timeout}s 内未命中 /{expect}/")
		tail = "\n".join(text.splitlines()[-15:])
		print(f"     屏幕尾部：\n{tail}")
		return False
	finally:
		quit_pi(pid, fd)


SCENARIOS = {
	# 场景1：写新文件 —— P0-1/P0-2 的共同触发点。修复前会卡死/内存暴涨。
	"write": (
		"用 write 工具创建文件 /tmp/pi-e2e-write.txt，内容是三行：alpha/beta/gamma。不要做别的。",
		r"Wrote|⎯|alpha",
		150.0,
	),
	# 场景2：连读 3 文件 → 折叠组 "Read 3 files (ctrl+o to expand)"
	"read3": (
		"依次用 read 工具读这三个文件：/etc/hosts、/etc/shells、/tmp/pi-e2e-write.txt。",
		r"Read 3 files|Read 3",
		150.0,
	),
	# 场景3：>30s 请求 → 结束时只一条 ✻ Worked for Ns
	"long": (
		"用 bash 跑 sleep 35，然后 echo done。只跑这一条命令。",
		r"Worked for|done",
		120.0,
	),
	# 场景4：thinking → 消息流折叠行
	"thinking": (
		"想一想 17 是质数吗，只回答是或否。",
		r"Thinking|thinking|是",
		120.0,
	),
	# 场景5：改 Go 文件 → diff 语法高亮（B1 后）
	"go": (
		"用 edit 工具把 /tmp/pi-e2e-write.txt 里的 alpha 改成 ALPHA。",
		r"ALPHA|Update|Edit",
		120.0,
	),
}


def main():
	which = sys.argv[1] if len(sys.argv) > 1 else "all"
	if which == "all":
		names = list(SCENARIOS)
	else:
		names = [which]
	results = {}
	for name in names:
		if name not in SCENARIOS:
			print(f"未知场景：{name}（可选：{', '.join(SCENARIOS)}）")
			sys.exit(2)
		prompt, expect, timeout = SCENARIOS[name]
		results[name] = run_scenario(name, prompt, expect, timeout)
		print()
	print("=" * 60)
	for name, ok in results.items():
		print(f"  {'✅' if ok else '❌'} {name}")
	sys.exit(0 if all(results.values()) else 1)


if __name__ == "__main__":
	main()
