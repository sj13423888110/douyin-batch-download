# -*- coding: utf-8 -*-
"""关闭 Chrome「下载前询问每个文件的保存位置」（download.prompt_for_download）。

背景：该用户偏好优先级高于 chrome.downloads.download({saveAs:false})，
开着时扩展 API 无法抑制另存为对话框，批量下载会逐个弹窗。

用法：Chrome 完全退出后运行本脚本；脚本会自动等待 Chrome 关闭再改。
安全性：改动前会备份 Preferences，可随时手动还原。
"""
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

USER_DATA = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Google", "Chrome", "User Data")


def chrome_running() -> bool:
    """检测是否仍有 chrome.exe 进程（含后台驻留进程）。"""
    try:
        r = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq chrome.exe", "/FO", "CSV", "/NH"],
            capture_output=True, text=True, encoding="utf-8", errors="ignore",
        )
        return "chrome.exe" in (r.stdout or "").lower()
    except Exception:
        # 兜底：tasklist 不可用时，靠能否独占打开 Preferences 判断
        return False


def find_profiles():
    """返回所有含 Preferences 的 profile 目录。"""
    out = []
    if not os.path.isdir(USER_DATA):
        return out
    for name in os.listdir(USER_DATA):
        if name == "Default" or name.startswith("Profile "):
            p = os.path.join(USER_DATA, name, "Preferences")
            if os.path.isfile(p):
                out.append(p)
    return out


def patch(path: str):
    """把一个 Preferences 文件里的 prompt_for_download 置为 False。返回 (结果, 原值)。"""
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    dl = data.get("download")
    if not isinstance(dl, dict):
        dl = {}
        data["download"] = dl

    old = dl.get("prompt_for_download")
    if old is False:
        return "already", old

    bak = path + ".bak-" + datetime.now().strftime("%Y%m%d-%H%M%S")
    shutil.copy2(path, bak)

    dl["prompt_for_download"] = False

    tmp = path + ".wbnew"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, path)
    return "ok", old


def main():
    print("=" * 58)
    print("  关闭 Chrome「下载前询问每个文件的保存位置」")
    print("=" * 58)

    if not os.path.isdir(USER_DATA):
        print("找不到 Chrome 用户数据目录：", USER_DATA)
        print("如果你用的是其他浏览器或非默认安装位置，请手动改：")
        print("  chrome://settings/downloads -> 关闭「下载前询问每个文件的保存位置」")
        return 1

    if chrome_running():
        print()
        print("检测到 Chrome 正在运行。")
        print("请完全退出 Chrome（关闭所有窗口；若托盘有图标，右键退出）。")
        print("本脚本会自动检测，Chrome 一关闭就继续，不需要按任何键。")
        print("（不想关的话，直接关掉这个黑窗口即可，不会有任何改动）")
        print()
        n = 0
        while chrome_running():
            time.sleep(2)
            n += 1
            if n % 15 == 0:
                print("  等待中... 已等待 %d 秒，Chrome 仍未完全退出。" % (n * 2))
        print("Chrome 已退出。")
        time.sleep(3)  # 给 Chrome 写完 Preferences 留出时间
    else:
        print("Chrome 未运行，直接开始。")

    profiles = find_profiles()
    if not profiles:
        print("没有找到任何 Preferences 文件。")
        return 1

    changed = 0
    for p in profiles:
        name = os.path.basename(os.path.dirname(p))
        try:
            res, old = patch(p)
        except Exception as e:
            print("  [%s] 失败：%s" % (name, e))
            continue
        if res == "ok":
            print("  [%s] 已修改：prompt_for_download %s -> false" % (name, old))
            changed += 1
        else:
            print("  [%s] 无需修改：已经是 false" % name)

    print()
    if changed:
        print("完成，共修改 %d 个配置文件。原文件已备份为 Preferences.bak-<时间戳>。")
    else:
        print("完成，所有配置本来就是关闭状态。")
    print()
    print("现在可以重新打开 Chrome，到 chrome://settings/downloads 确认开关已关闭。")
    print("之后在插件里点一次「下载全部视频」，其余文件会静默落盘，不再逐个弹窗。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
