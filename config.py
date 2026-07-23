import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def _load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


_load_dotenv(ROOT / ".env")

FIREFLIES_API_KEY = os.environ.get("FIREFLIES_API_KEY", "")
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")
GOOGLE_SHEET_ID = os.environ.get(
    "GOOGLE_SHEET_ID", "1Jtgk_z0lo30QgFqwfpPuX04vZcRAmxvhpkGLC7KKfo8"
)


def require(name: str, value: str) -> str:
    if not value:
        raise RuntimeError(
            f"{name} не задан. Заполните d:/BM/Sender/.env (см. .env.example)."
        )
    return value
