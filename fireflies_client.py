"""Клиент к Fireflies GraphQL API для поиска встреч конкретного участника."""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass

import requests

import config

API_URL = "https://api.fireflies.ai/graphql"

TRANSCRIPTS_QUERY = """
query Transcripts($fromDate: DateTime, $toDate: DateTime, $limit: Int, $skip: Int) {
  transcripts(fromDate: $fromDate, toDate: $toDate, limit: $limit, skip: $skip) {
    id
    title
    date
    summary {
      overview
      short_summary
      bullet_gist
      keywords
      action_items
      topics_discussed
    }
  }
}
"""


@dataclass
class Meeting:
    id: str
    title: str
    date: dt.datetime
    overview: str
    short_summary: str
    bullet_gist: str
    action_items: str


def _iso(d: dt.date | dt.datetime) -> str:
    if isinstance(d, dt.datetime):
        return d.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    return d.strftime("%Y-%m-%dT00:00:00.000Z")


FIREFLIES_PAGE_SIZE = 50  # жёсткий максимум на стороне Fireflies API


def _fetch_page(
    api_key: str, date_from: dt.date, date_to: dt.date, skip: int
) -> list[dict]:
    resp = requests.post(
        API_URL,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={
            "query": TRANSCRIPTS_QUERY,
            "variables": {
                "fromDate": _iso(date_from),
                "toDate": _iso(date_to),
                "limit": FIREFLIES_PAGE_SIZE,
                "skip": skip,
            },
        },
        timeout=30,
    )
    resp.raise_for_status()
    payload = resp.json()
    if "errors" in payload and payload["errors"]:
        raise RuntimeError(f"Fireflies API error: {payload['errors']}")
    return payload["data"]["transcripts"]


def get_transcripts(
    date_from: dt.date, date_to: dt.date, max_results: int = 500
) -> list[Meeting]:
    """Все транскрипты за период [date_from, date_to] (пагинация по 50)."""
    api_key = config.require("FIREFLIES_API_KEY", config.FIREFLIES_API_KEY)

    raw: list[dict] = []
    skip = 0
    while len(raw) < max_results:
        page = _fetch_page(api_key, date_from, date_to, skip)
        raw.extend(page)
        if len(page) < FIREFLIES_PAGE_SIZE:
            break
        skip += FIREFLIES_PAGE_SIZE

    meetings = []
    for t in raw[:max_results]:
        summary = t.get("summary") or {}
        meetings.append(
            Meeting(
                id=t["id"],
                title=t.get("title") or "",
                date=dt.datetime.fromtimestamp(t["date"] / 1000, tz=dt.timezone.utc)
                if isinstance(t.get("date"), (int, float))
                else dt.datetime.fromisoformat(str(t.get("date"))),
                overview=summary.get("overview") or "",
                short_summary=summary.get("short_summary") or "",
                bullet_gist=summary.get("bullet_gist") or "",
                action_items=summary.get("action_items") or "",
            )
        )
    return meetings


def _name_variants(fio: str) -> list[str]:
    """'Волов Илья' -> ['Волов Илья', 'Илья Волов'] для поиска в title."""
    parts = fio.split()
    variants = {fio.strip()}
    if len(parts) == 2:
        variants.add(f"{parts[1]} {parts[0]}")
    return list(variants)


def find_meetings_for(
    fio: str,
    date_from: dt.date,
    date_to: dt.date,
    all_meetings: list[Meeting] | None = None,
) -> list[Meeting]:
    """Встречи за период, где в названии есть Фамилия и Имя участника.

    Если all_meetings не передан, транскрипты запрашиваются заново (удобно
    для разового вызова, но неэффективно при переборе всего ростера — тогда
    лучше один раз вызвать get_transcripts и передавать результат сюда).
    """
    if all_meetings is None:
        all_meetings = get_transcripts(date_from, date_to)
    parts = [re.escape(p) for p in fio.split()]
    if not parts:
        return []
    # обе части ФИО должны встретиться в названии (в любом порядке, любые доп. слова)
    patterns = [re.compile(p, re.IGNORECASE) for p in parts]
    return [
        m
        for m in all_meetings
        if all(p.search(m.title) for p in patterns)
    ]
