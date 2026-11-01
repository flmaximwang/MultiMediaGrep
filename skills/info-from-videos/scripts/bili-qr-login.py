"""B站扫码登录（非交互环境版）：二维码存成 PNG，自己轮询 poll 原始响应取 cookie。

为什么不用 `bili login`：它把二维码画在终端里（无人值守时没人看得到），而且实测
**API 层登录成功后它存下的凭证里 `sessdata` 是空的**（库解析 cookie 失败）—— 等于没登录。
本脚本改用同一个库拿二维码，但 poll 的响应自己解析：`Set-Cookie` 头与 URL 查询串两路取
（`sessdata` / `bili_jct` / `dedeuserid` / `ac_time_value`），存进凭证前先调 nav 验一次。

用法（必须用 bilibili-cli 那个 venv 的解释器，依赖 aiohttp / qrcode / bilibili_api）：

    PY=$(ls -d ~/.local/share/uv/tools/bilibili-cli/bin/python)
    "$PY" scripts/bili-qr-login.py /tmp/bili-qr.png

输出（逐行，供 agent 判读）：
    QR_SAVED <路径>         二维码已落盘 —— 把这张图发给用户扫，有效期约 3 分钟
    SCANNED 已扫码，等手机确认
    NAV isLogin: True uname: <用户名>
    LOGIN_OK 凭证已保存并验证
    QR_EXPIRED 二维码过期    — 重新跑一次生成新码（一次性的，不能复用）
    NO_SESSDATA 原始响应里没有 cookie — 丢掉这次，重扫

退出码：0 登录并验证成功｜1 拿不到二维码 / 没取到 cookie / nav 报未登录。
"""

import asyncio
import json
import sys
from urllib.parse import parse_qs, urlparse

import aiohttp
import qrcode
from bilibili_api.login_v2 import QrCodeLogin
from bilibili_api.utils.network import Credential
from bili_cli.auth import save_credential

POLL = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll"
NAV = "https://api.bilibili.com/x/web-interface/nav"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


def extract_cookies(resp, url: str) -> dict:
    """Set-Cookie 头优先，其次 url 查询串（poll 成功时 cookie 只会出现在其中一处）。"""
    ck = {}
    for h in resp.headers.getall("Set-Cookie", []):
        for part in h.split(";"):
            if "=" in part:
                k, v = part.strip().split("=", 1)
                ck.setdefault(k.lower(), v)
    q = urlparse(url).query or (url.split("?", 1)[-1] if "?" in url else "")
    for k, v in parse_qs(q, keep_blank_values=True).items():
        kl = k.lower()
        if kl in ("sessdata", "bili_jct", "dedeuserid", "ac_time_value"):
            ck.setdefault(kl, v[0])
    return ck


async def main(out_path: str) -> int:
    login = QrCodeLogin()
    await login.generate_qrcode()
    link = getattr(login, "_QrCodeLogin__qr_link", None)
    key = getattr(login, "_QrCodeLogin__qr_key", None)
    if not (link and key):
        print("NO_QRCODE 拿不到二维码链接/key", flush=True)
        return 1
    qrcode.make(link).save(out_path)
    print(f"QR_SAVED {out_path}", flush=True)

    async with aiohttp.ClientSession(headers={"User-Agent": UA}) as sess:
        cred = None
        while cred is None:
            async with sess.get(POLL, params={"qrcode_key": key}) as r:
                body = await r.json()
                ck = extract_cookies(r, body.get("data", {}).get("url") or "")
            data = body.get("data", {})
            code = data.get("code")
            if code == 86101:
                pass                                    # 未扫码
            elif code == 86090:
                print("SCANNED 已扫码，等手机确认", flush=True)
            elif code == 86038:
                print("QR_EXPIRED 二维码过期", flush=True)
                return 1
            else:
                print("RAW_RESP", json.dumps(body, ensure_ascii=False)[:500], flush=True)
                print("COOKIE_KEYS", sorted(ck), flush=True)
                if not ck.get("sessdata"):
                    print("NO_SESSDATA 原始响应里没有 cookie", flush=True)
                    return 1
                cred = Credential(
                    sessdata=ck["sessdata"],
                    bili_jct=ck.get("bili_jct", ""),
                    dedeuserid=ck.get("dedeuserid", ""),
                    ac_time_value=data.get("refresh_token", ""),
                )
                break
            await asyncio.sleep(2)

        async with sess.get(NAV, cookies={"SESSDATA": cred.sessdata}) as r:
            nav = await r.json()
        d = nav.get("data", {})
        print("NAV isLogin:", d.get("isLogin"), "uname:", d.get("uname"), flush=True)
        if not d.get("isLogin"):
            print("NAV_FAIL", json.dumps(nav, ensure_ascii=False)[:300], flush=True)
            return 1

    save_credential(cred)
    print("LOGIN_OK 凭证已保存并验证", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "/tmp/bili-qr.png")))
