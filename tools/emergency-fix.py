# -*- coding: utf-8 -*-
"""紧急止血：Chrome 批量下载雪崩收尾。

适用于「插件批量触发下载 -> 每个都弹另存为 -> Chrome 卡死」的场景。

依次执行：
  1. 强制结束所有 chrome.exe（含后台驻留进程）
  2. 关闭「下载前询问每个文件的保存位置」（download.prompt_for_download）
  3. 清掉 Chrome 下载记录里「未完成」的项（已完成的下载历史保留）
  4. 把 Downloads 根目录的 .tmp 下载中间文件移入回收站

危险动作已隔离在第 1 步，且必须在运行前手动输入确认（见同名 .cmd）。
改 Preferences 前会先生成 .bak-<时间戳> 备份。
"""
import json
import os
import shutil
import subprocess
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

USER_DATA = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Google", "Chrome", "User Data")
DOWNLOADS = os.path.join(os.environ.get("USERPROFILE", ""), "Downloads")

STAMP = time.strftime("%Y%m%d-%H%M%S")


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="ignore")


def count_chrome():
    out = (run(["tasklist", "/FI", "IMAGENAME eq chrome.exe", "/FO", "CSV", "/NH"]).stdout or "")
    return sum(1 for line in out.splitlines() if "chrome.exe" in line.lower())


def profile_dirs():
    """返回 [(profile名, 目录路径)]"""
    out = []
    if os.path.isdir(USER_DATA):
        for n in sorted(os.listdir(USER_DATA)):
            if n == "Default" or n.startswith("Profile "):
                out.append((n, os.path.join(USER_DATA, n)))
    return out


# ---------- 1. 结束 Chrome ----------

def kill_chrome():
    n = count_chrome()
    if n == 0:
        print("  Chrome 未运行，跳过。")
        return True
    print("  正在结束 %d 个 chrome.exe ..." % n)
    run(["taskkill", "/F", "/IM", "chrome.exe", "/T"])
    for _ in range(20):
        time.sleep(1)
        if count_chrome() == 0:
            print("  Chrome 已全部结束。")
            return True
    left = count_chrome()
    print("  [警告] 仍有 %d 个 chrome.exe 残留，请到任务管理器手动结束后再重跑本脚本。" % left)
    return False


# ---------- 2. 关闭「下载前询问保存位置」 ----------

def fix_prompt():
    changed = 0
    for name, d in profile_dirs():
        p = os.path.join(d, "Preferences")
        if not os.path.isfile(p):
            continue
        try:
            with open(p, encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            print("  [%s] 读取失败：%s" % (name, e))
            continue
        dl = data.get("download")
        if not isinstance(dl, dict):
            dl = {}
            data["download"] = dl
        if dl.get("prompt_for_download") is False:
            print("  [%s] 本来就是关闭状态" % name)
            continue
        shutil.copy2(p, p + ".bak-" + STAMP)
        dl["prompt_for_download"] = False
        tmp = p + ".wbnew"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, p)
        print("  [%s] 已关闭「下载前询问每个文件的保存位置」" % name)
        changed += 1
    return changed


# ---------- 3. 清掉未完成的下载记录 ----------

def clear_pending():
    try:
        import sqlite3
    except ImportError:
        print("  本机 Python 无 sqlite3，跳过。")
        return
    total = 0
    for name, d in profile_dirs():
        h = os.path.join(d, "History")
        if not os.path.isfile(h):
            continue
        try:
            shutil.copy2(h, h + ".bak-" + STAMP)  # 删记录前先备份
            con = sqlite3.connect(h, timeout=8)
            cur = con.cursor()
            cur.execute("SELECT COUNT(*) FROM downloads WHERE state != 1")
            n = cur.fetchone()[0]
            if n:
                cur.execute("DELETE FROM downloads WHERE state != 1")
                con.commit()
                print("  [%s] 清掉 %d 条未完成下载记录（已完成的保留，已备份 History）" % (name, n))
                total += n
            con.close()
        except Exception as e:
            print("  [%s] 处理失败：%s" % (name, e))
    if total == 0:
        print("  没有未完成的下载记录。")


# ---------- 4. 清理 .tmp 中间文件 ----------
#
# 用 Windows 自带的 SHFileOperationW 送回收站，**不依赖任何第三方库**。
# 早先版本用 send2trash，结果在用户机器上因解释器里没装这个包而整步空转
# （2026-09-30 实际发生），所以这里改成零依赖实现，并保留两级降级。

_FO_DELETE = 0x0003
_FOF_SILENT = 0x0004
_FOF_NOCONFIRMATION = 0x0010
_FOF_ALLOWUNDO = 0x0040
_FOF_NOERRORUI = 0x0400


def _make_recycler():
    """构造「送回收站」函数；环境不支持时返回 None。"""
    if os.name != "nt":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        class _SHFILEOPSTRUCTW(ctypes.Structure):
            _fields_ = [
                ("hwnd", wintypes.HWND),
                ("wFunc", wintypes.UINT),
                ("pFrom", wintypes.LPCWSTR),
                ("pTo", wintypes.LPCWSTR),
                ("fFlags", ctypes.c_uint16),
                ("fAnyOperationsAborted", wintypes.BOOL),
                ("hNameMappings", ctypes.c_void_p),
                ("lpszProgressTitle", wintypes.LPCWSTR),
            ]

        fn = ctypes.windll.shell32.SHFileOperationW
        fn.argtypes = [ctypes.POINTER(_SHFILEOPSTRUCTW)]
        fn.restype = ctypes.c_int

        def send(paths):
            # pFrom 必须是「以 \0 分隔、并以双 \0 结尾」的绝对路径串
            blob = "\0".join(os.path.abspath(p) for p in paths) + "\0\0"
            op = _SHFILEOPSTRUCTW()
            op.wFunc = _FO_DELETE
            op.pFrom = blob
            op.pTo = None
            op.fFlags = (_FOF_ALLOWUNDO | _FOF_NOCONFIRMATION
                         | _FOF_SILENT | _FOF_NOERRORUI)
            op.fAnyOperationsAborted = False
            rc = fn(ctypes.byref(op))
            if rc != 0:
                raise OSError("SHFileOperationW 返回码 %d" % rc)

        return send
    except Exception:
        return None


def _recycle(paths):
    """把一批文件送进回收站，返回「仍留在原地的」路径列表（空=全部成功）。"""
    if not paths:
        return []
    send = _make_recycler()
    if send is not None:
        try:
            send(paths)
        except Exception:
            pass
        return [p for p in paths if os.path.exists(p)]

    # 降级 2：send2trash（若恰好装了）
    try:
        from send2trash import send2trash
    except ImportError:
        return list(paths)
    for p in paths:
        try:
            send2trash(p)
        except Exception:
            pass
    return [p for p in paths if os.path.exists(p)]


def trash_tmp():
    """返回 (成功数, 失败文件路径列表)。"""
    if not os.path.isdir(DOWNLOADS):
        return 0, []
    files = [os.path.join(DOWNLOADS, f) for f in os.listdir(DOWNLOADS)
             if f.lower().endswith(".tmp")
             and os.path.isfile(os.path.join(DOWNLOADS, f))]
    if not files:
        print("  Downloads 里没有 .tmp 中间文件。")
        return 0, []

    size = 0
    for p in files:
        try:
            size += os.path.getsize(p)
        except OSError:
            pass
    print("  正在把 %d 个文件（%.1f GB）移入回收站 ..." % (len(files), size / 1073741824))

    remaining = _recycle(files)
    if remaining:
        print("  批量未全部成功，剩余的逐个重试 ...")
        still = []
        for p in remaining:
            if p in _recycle([p]):
                still.append(p)
        remaining = still

    done = len(files) - len(remaining)
    print("  结果：成功移入回收站 %d 个，失败 %d 个" % (done, len(remaining)))
    if remaining:
        for p in remaining[:8]:
            print("     失败：%s" % os.path.basename(p))
        if len(remaining) > 8:
            print("     ...另有 %d 个" % (len(remaining) - 8))
        print("     失败通常是文件仍被进程占用（Chrome / 下载管理器未完全退出）。")
        print("     可手动选中后按 Delete 删除。")
    return done, remaining


def main():
    print("=" * 62)
    print("  紧急止血 —— Chrome 批量下载雪崩收尾")
    print("=" * 62)
    print()

    # 先报告将要清理的垃圾体积，让用户心里有数
    junk = []
    if os.path.isdir(DOWNLOADS):
        junk = [f for f in os.listdir(DOWNLOADS)
                if f.lower().endswith(".tmp") and os.path.isfile(os.path.join(DOWNLOADS, f))]
    junk_size = 0
    for f in junk:
        try:
            junk_size += os.path.getsize(os.path.join(DOWNLOADS, f))
        except OSError:
            pass
    if junk:
        print("待清理的下载中间文件：%d 个，合计 %.1f GB（将移入回收站，可还原）" % (
            len(junk), junk_size / 1073741824))
        print("注意：回收站会继续占用等量磁盘空间，确认文件没问题后可自行清空回收站。")
        print()

    print("[1/4] 结束 Chrome")
    if not kill_chrome():
        print()
        print("中止：Chrome 没有完全退出。请先在任务管理器里结束所有 chrome.exe，再重跑。")
        return 1
    time.sleep(3)  # 给 Chrome 写完落盘留时间

    print()
    print("[2/4] 关闭「下载前询问每个文件的保存位置」")
    fix_prompt()

    print()
    print("[3/4] 清理未完成的下载记录")
    clear_pending()

    print()
    print("[4/4] 清理 Downloads 里的下载中间文件")
    n_done, n_fail = trash_tmp()

    print()
    print("=" * 62)
    print("全部完成。接下来：")
    print("  1. 重新打开 Chrome（可以「恢复上次会话」找回标签页）")
    print("  2. 到 chrome://extensions 把抖音下载插件「重新加载」")
    print("     —— 插件已升级到 v2.0.0，改成直接写盘：")
    print("        不再经过浏览器下载系统，不会再有「另存为」弹窗，")
    print("        也不再产生 .tmp 残渣，已存在的文件会自动跳过")
    print("  3.（可选）到 chrome://downloads 清掉已完成的下载历史")
    print("     未完成的记录上面第 3 步已清理，不必重复操作")
    if n_fail:
        print()
        print("[注意] 有 %d 个中间文件没能移入回收站（多半仍被占用），" % len(n_fail))
        print("       确认 Chrome 完全退出后重跑本脚本，或手动删除。")
    print("=" * 62)
    return 0


if __name__ == "__main__":
    sys.exit(main())
