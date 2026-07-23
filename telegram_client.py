"""Отправка готовых (одобренных) отчётов в Telegram-чат кураторов."""

from __future__ import annotations

import requests

import config

API_URL = "https://api.telegram.org/bot{token}/{method}"
TELEGRAM_MAX_LEN = 4096


def _call(method: str, **params) -> dict:
    token = config.require("TELEGRAM_BOT_TOKEN", config.TELEGRAM_BOT_TOKEN)
    resp = requests.post(API_URL.format(token=token, method=method), json=params, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    if not data.get("ok"):
        raise RuntimeError(f"Telegram API error: {data}")
    return data["result"]


def get_updates() -> list[dict]:
    """Помогает один раз найти chat_id: напишите боту/в группу и вызовите это."""
    return _call("getUpdates")


def send_message(text: str, chat_id: str | None = None) -> None:
    target = chat_id or config.require("TELEGRAM_CHAT_ID", config.TELEGRAM_CHAT_ID)
    for i in range(0, len(text), TELEGRAM_MAX_LEN):
        _call("sendMessage", chat_id=target, text=text[i : i + TELEGRAM_MAX_LEN])


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "whoami":
        updates = get_updates()
        if not updates:
            print(
                "Обновлений нет. Напишите что-нибудь боту в личку или в группу "
                "кураторов (куда он добавлен), затем запустите снова."
            )
        for u in updates:
            chat = (u.get("message") or {}).get("chat") or {}
            print(f"chat_id={chat.get('id')}  title/name={chat.get('title') or chat.get('username')}  type={chat.get('type')}")
    else:
        print("Использование: python telegram_client.py whoami  # чтобы найти chat_id группы кураторов")
