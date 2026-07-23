"""
Список участников/родителей/мессенджеров.

Таблица (GOOGLE_SHEET_ID) должна быть открыта на просмотр «всем, у кого есть
ссылка» — тогда её можно скачать как CSV обычным HTTP-запросом, без
Google-credentials. Это нужно, чтобы пайплайн одинаково работал и в этой
сессии, и в облачном cron-агенте (пятничный автозапуск).
"""

from __future__ import annotations

import csv
import io
import json
from dataclasses import asdict, dataclass
from pathlib import Path

import requests

import config

CACHE_PATH = Path(__file__).resolve().parent / "roster.json"
CSV_EXPORT_URL = "https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=csv&gid=0"


@dataclass
class Participant:
    fio: str  # "Фамилия Имя", как в таблице и как ищем в названиях Fireflies-встреч
    parents: str  # "Стас и Елена" — как обращаться в приветствии отчёта
    messenger: str  # "Telegram" | "W/A" — только для шапки, доставка всегда в Telegram


def fetch_roster(sheet_id: str | None = None) -> list[Participant]:
    sheet_id = sheet_id or config.require("GOOGLE_SHEET_ID", config.GOOGLE_SHEET_ID)
    resp = requests.get(CSV_EXPORT_URL.format(sheet_id=sheet_id), timeout=30)
    resp.raise_for_status()
    text = resp.content.decode("utf-8-sig")  # Google отдаёт UTF-8, requests иногда угадывает не ту кодировку
    if text.strip().startswith("<HTML"):
        raise RuntimeError(
            "Таблица недоступна по прямой ссылке. Проверьте, что доступ "
            "выставлен «Все, у кого есть ссылка — Читатель»."
        )

    rows = []
    for cells in csv.reader(io.StringIO(text)):
        cells = [c.strip() for c in cells]
        if len(cells) != 3 or not cells[0]:
            continue
        fio, parents, messenger = cells
        rows.append(Participant(fio=fio, parents=parents, messenger=messenger))
    return rows


def save_roster(rows: list[Participant]) -> None:
    CACHE_PATH.write_text(
        json.dumps([asdict(r) for r in rows], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def load_roster() -> list[Participant]:
    """Свежий список из таблицы; заодно обновляет локальный кэш roster.json."""
    rows = fetch_roster()
    save_roster(rows)
    return rows


if __name__ == "__main__":
    for p in load_roster():
        print(p)
