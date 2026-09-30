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
            con = sqlite3.connect(h, timeout=8)
            cur = con.cursor()
            cur.execute("SELECT COUNT(*) FROM downloads WHERE state != 1")
            n = cur.fetchone()[0]
            if n:
                cur.execute("DELETE FROM downloads WHERE state != 1")
                con.commit()
                print("  [%s] 清掉 %d 条未完成下载记录（已完成的保留）" % (name, n))
                total += n
            con.close()
        except Exception as e:
            print("  [%s] 处理失败：%s" % (name, e))
    if total == 0:
        print("  没有未完成的下载记录。")


# ---------- 4. 清理 .tmp 中间文件 ----------

def trash_tmp():
    try:
        from send2trash import send2trash
    except ImportError:
        print("  缺少 send2trash，跳过（pip install send2trash 可安装）。")
        return
    if not os.path.isdir(DOWNLOADS):
        return
    files = [f for f in os.listdir(DOWNLOADS)
             if f.lower().endswith(".tmp") and os.path.isfile(os.path.join(DOWNLOADS, f))]
    if not files:
        print("  Downloads 里没有 .tmp 中间文件。")
        return
    ok = 0
    size = 0
    for i, f in enumerate(files):
        p = os.path.join(DOWNLOADS, f)
        try:
            size += os.path.getsize(p)
        except OSError:
            pass
        try:
            send2trash(p)
            ok += 1
        except Exception:
            pass
        if (i + 1) % 10 == 0:
            time.sleep(0.1)
    print("  已移入回收站 %d/%d 个，合计 %.1f MB" % (ok, len(files), size / 1048576))


def main():
    print("=" * 62)
    print("  紧急止血 —— Chrome 批量下载雪崩收尾")
    print("=" * 62)
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
    trash_tmp()

    print()
    print("=" * 62)
    print("全部完成。接下来：")
    print("  1. 重新打开 Chrome（可以「恢复上次会话」找回标签页）")
    print("  2. 到 chrome://extensions 把抖音下载插件「重新加载」")
    print("     —— 插件已升级到 v1.1.0，第一个下载被拦就会自动中止，")
    print("        不会再出现一口气触发几百个任务把浏览器拖死的情况")
    print("  3. 确认 chrome://settings/downloads 里「下载前询问每个文件的保存位置」是关闭的")
    print("=" * 62)
    return 0


if __name__ == "__main__":
    sys.exit(main())
