import asyncio
import json
import logging
import os
import sqlite3
import re
import threading
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from dataclasses import dataclass
from urllib.parse import parse_qs, quote, urlparse
from typing import Any, Dict, List, Optional

import httpx
from telegram import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    KeyboardButton,
    ReplyKeyboardMarkup,
    Update,
    WebAppInfo,
)
from telegram.constants import ParseMode
from telegram.error import BadRequest, TelegramError
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)


logging.basicConfig(level=logging.INFO)

BOT_TOKEN = os.getenv("BOT_TOKEN")
if not BOT_TOKEN:
    raise RuntimeError("Set BOT_TOKEN env var (your Telegram bot token).")

DEEZER_SEARCH_URL = "https://api.deezer.com/search"
RESULTS_PER_PAGE = 6
MAX_QUERY_LEN = 120
COMMENT_MAX_LEN = 500

WEBAPP_URL = os.getenv("WEBAPP_URL")  # Must be an HTTPS URL to a hosted Telegram Web App.

if WEBAPP_URL:
    # Sometimes users copy the URL with surrounding parentheses/spaces and Bot API rejects it.
    WEBAPP_URL = WEBAPP_URL.strip().strip('"').strip("'")
    if WEBAPP_URL.startswith("(") and WEBAPP_URL.endswith(")"):
        WEBAPP_URL = WEBAPP_URL[1:-1].strip()
    # Collapse duplicate slashes in the path, but keep the `https://` part intact.
    WEBAPP_URL = re.sub(r"(?<!:)//+", "/", WEBAPP_URL)

    if not WEBAPP_URL.startswith("https://"):
        logging.warning("WEBAPP_URL must start with https://, got: %r", WEBAPP_URL)
        WEBAPP_URL = None

# Публичный HTTPS URL до HTTP-API бота (тот же процесс, что polling), без слэша в конце.
# Важно: часть клиентов Telegram обрезает query (?api=...) у WebApp URL, поэтому добавляем ещё и #api=...
BOT_PUBLIC_API_URL = (os.getenv("BOT_PUBLIC_API_URL") or "").strip().rstrip("/")


def _webapp_url_for_open() -> Optional[str]:
    if not WEBAPP_URL or not _validate_webapp_url(WEBAPP_URL):
        return None
    if not BOT_PUBLIC_API_URL:
        return WEBAPP_URL
    base = WEBAPP_URL.split("#", 1)[0]
    sep = "&" if "?" in base else "?"
    encoded = quote(BOT_PUBLIC_API_URL, safe="")
    # query + hash: фронт прочитает что доступно
    return f"{base}{sep}api={encoded}#api={encoded}"


def _validate_webapp_url(url: Optional[str]) -> bool:
    if not url:
        return False
    if any(ch.isspace() for ch in url):
        return False
    try:
        p = urlparse(url)
    except Exception:
        return False
    return p.scheme == "https" and bool(p.netloc)

DB_PATH = Path(__file__).with_name("bot_music.sqlite3")


@dataclass
class SearchSession:
    query: str
    offset: int
    tracks: List[Dict[str, Any]]


# In-memory sessions: session_id -> SearchSession
SESSIONS: Dict[str, SearchSession] = {}

# Waiting for user to send a text comment after pressing "Комментарий" button.
AWAITING_COMMENT: Dict[int, int] = {}  # user_id -> track_id


def _now_iso() -> str:
    # Keep it local to avoid extra imports at module level.
    import datetime

    return datetime.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def _init_db() -> None:
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                user_id INTEGER PRIMARY KEY,
                username TEXT,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS likes (
                user_id INTEGER NOT NULL,
                track_id INTEGER NOT NULL,
                liked_at TEXT NOT NULL,
                PRIMARY KEY (user_id, track_id)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS comments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                track_id INTEGER NOT NULL,
                comment TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.commit()


def _ensure_user(user_id: int, username: Optional[str]) -> None:
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            INSERT OR IGNORE INTO users(user_id, username, created_at)
            VALUES(?, ?, ?)
            """,
            (user_id, username, _now_iso()),
        )
        conn.commit()


def _set_like(user_id: int, track_id: int, liked: bool) -> None:
    with sqlite3.connect(DB_PATH) as conn:
        if liked:
            conn.execute(
                """
                INSERT OR REPLACE INTO likes(user_id, track_id, liked_at)
                VALUES(?, ?, ?)
                """,
                (user_id, track_id, _now_iso()),
            )
        else:
            conn.execute("DELETE FROM likes WHERE user_id = ? AND track_id = ?", (user_id, track_id))
        conn.commit()


def _add_comment(user_id: int, track_id: int, comment: str) -> None:
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            INSERT INTO comments(user_id, track_id, comment, created_at)
            VALUES(?, ?, ?, ?)
            """,
            (user_id, track_id, comment, _now_iso()),
        )
        conn.commit()


def _get_like_track_ids(user_id: int, limit: int = 10) -> List[int]:
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            "SELECT track_id FROM likes WHERE user_id = ? ORDER BY liked_at DESC LIMIT ?",
            (user_id, limit),
        ).fetchall()
    return [int(r[0]) for r in rows]


def _get_user_comments(user_id: int, track_id: int, limit: int = 10) -> List[tuple[str, str]]:
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            """
            SELECT comment, created_at
            FROM comments
            WHERE user_id = ? AND track_id = ?
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (user_id, track_id, limit),
        ).fetchall()
    return [(str(r[0]), str(r[1])) for r in rows]


def _get_track_comments(track_id: int, limit: int = 30) -> List[tuple[str, int, str, str]]:
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            """
            SELECT u.username, c.user_id, c.comment, c.created_at
            FROM comments c
            LEFT JOIN users u ON u.user_id = c.user_id
            WHERE c.track_id = ?
            ORDER BY c.created_at DESC
            LIMIT ?
            """,
            (track_id, limit),
        ).fetchall()
    return [
        (
            str(r[0]) if r[0] is not None else "",
            int(r[1]),
            str(r[2]),
            str(r[3]),
        )
        for r in rows
    ]


def _comments_api_json_payload(track_id: int, limit: int = 100) -> Dict[str, Any]:
    rows = _get_track_comments(track_id, limit=limit)
    comments: List[Dict[str, Any]] = []
    for username, author_id, comment, created_at in rows:
        comments.append(
            {
                "username": username,
                "user_id": author_id,
                "text": comment,
                "created_at": created_at,
                "author": f"@{username}" if username else f"id:{author_id}",
            }
        )
    return {"comments": comments}


def _like_counts_for_tracks(track_ids: List[int]) -> Dict[int, int]:
    """How many distinct users liked each track (global, from SQLite)."""
    uniq: List[int] = []
    seen: set[int] = set()
    for tid in track_ids:
        if tid in seen:
            continue
        seen.add(tid)
        uniq.append(tid)
    if not uniq:
        return {}
    out: Dict[int, int] = {tid: 0 for tid in uniq}
    placeholders = ",".join("?" * len(uniq))
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            f"SELECT track_id, COUNT(*) FROM likes WHERE track_id IN ({placeholders}) GROUP BY track_id",
            uniq,
        ).fetchall()
    for tid, cnt in rows:
        out[int(tid)] = int(cnt)
    return out


class MiniAppAPIHandler(BaseHTTPRequestHandler):
    """
    Лёгкий HTTP-интерфейс к SQLite для Mini App (без API-ключей).
    Должен быть доступен по публичному HTTPS (тот же VPS, что и бот).
    """

    def log_message(self, format: str, *args: Any) -> None:
        logging.info("%s - %s", self.address_string(), format % args)

    def _send_cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _write_json(self, status: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._send_cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._send_cors()
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/likes":
            qs = parse_qs(parsed.query)
            ids_raw = (qs.get("ids") or [""])[0]
            parts = [p.strip() for p in ids_raw.split(",") if p.strip()]
            track_ids: List[int] = []
            for p in parts[:50]:
                try:
                    track_ids.append(int(p))
                except ValueError:
                    continue
            counts = _like_counts_for_tracks(track_ids)
            self._write_json(200, {"likes": {str(k): v for k, v in counts.items()}})
            return

        if path.startswith("/api/comments/"):
            tail = path[len("/api/comments/") :].strip("/")
            if not tail:
                self.send_error(404)
                return
            try:
                track_id = int(tail.split("/", 1)[0])
            except ValueError:
                self._write_json(400, {"error": "bad track id"})
                return
            payload = _comments_api_json_payload(track_id)
            self._write_json(200, payload)
            return

        self.send_error(404)


def _start_comments_api_server() -> None:
    port_raw = os.getenv("COMMENTS_API_PORT", "8765")
    host = os.getenv("COMMENTS_API_HOST", "0.0.0.0")
    try:
        port = int(port_raw)
    except ValueError:
        logging.warning("Invalid COMMENTS_API_PORT=%r, skipping comments API server.", port_raw)
        return
    try:
        server = HTTPServer((host, port), MiniAppAPIHandler)
    except OSError as exc:
        logging.warning("Could not start comments API on %s:%s: %s", host, port, exc)
        return
    thread = threading.Thread(target=server.serve_forever, daemon=True, name="comments-api")
    thread.start()
    logging.info(
        "Mini App data API: http://%s:%s — /api/comments/<trackId>, /api/likes?ids=1,2 "
        "(публичный HTTPS на сервере бота; BOT_PUBLIC_API_URL или ?api= в WebApp)",
        host,
        port,
    )


async def deezer_get_track(track_id: int) -> Optional[Dict[str, Any]]:
    url = f"https://api.deezer.com/track/{track_id}"
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        return resp.json()


def _make_session_id() -> str:
    # Keep callback_data length small.
    return uuid.uuid4().hex[:10]


def _safe_str(x: Any) -> str:
    return str(x) if x is not None else ""


def _build_tracks_keyboard(session_id: str, tracks: List[Dict[str, Any]], page: int) -> InlineKeyboardMarkup:
    rows: List[List[InlineKeyboardButton]] = []

    for idx, t in enumerate(tracks):
        artist = (t.get("artist") or {}).get("name") or "Unknown"
        title = t.get("title") or "Track"
        album_title = (t.get("album") or {}).get("title") or ""
        preview = t.get("preview")

        primary_text = f"{artist} - {title}".strip()
        if len(primary_text) > 44:
            primary_text = primary_text[:41] + "…"

        # Row 1: Preview + open in Deezer
        if preview:
            rows.append(
                [
                    InlineKeyboardButton(
                        text=f"▶ {primary_text}",
                        callback_data=f"preview:{session_id}:{idx}",
                    ),
                    InlineKeyboardButton(
                        text="Открыть в Deezer",
                        url=t.get("link") or f"https://www.deezer.com/track/{t.get('id', '')}",
                    ),
                ]
            )
        else:
            rows.append(
                [
                    InlineKeyboardButton(text=primary_text, callback_data="noop"),
                    InlineKeyboardButton(
                        text="Открыть в Deezer",
                        url=t.get("link") or f"https://www.deezer.com/track/{t.get('id', '')}",
                    ),
                ]
            )

        # Row 2: refine search (artist/album)
        # (Use callback-based search to avoid typing.)
        short_artist = artist
        if len(short_artist) > 26:
            short_artist = short_artist[:23] + "…"

        short_album = album_title
        if len(short_album) > 22:
            short_album = short_album[:19] + "…"

        rows.append(
            [
                InlineKeyboardButton(
                    text=f"Ещё от: {short_artist}",
                    callback_data=f"artistq:{session_id}:{idx}",
                ),
                InlineKeyboardButton(
                    text=f"Альбом: {short_album}" if short_album else "Альбом трека",
                    callback_data=f"albumq:{session_id}:{idx}",
                ),
            ]
        )

    # Pagination
    pagination: List[InlineKeyboardButton] = []
    if page > 1:
        pagination.append(InlineKeyboardButton(text="◀️ Назад", callback_data=f"page:{session_id}:-1"))
    pagination.append(InlineKeyboardButton(text=f"Стр. {page}", callback_data="noop"))
    pagination.append(InlineKeyboardButton(text="Далее ▶️", callback_data=f"page:{session_id}:1"))
    rows.append(pagination)

    return InlineKeyboardMarkup(inline_keyboard=rows)


async def deezer_search(query: str, offset: int, limit: int) -> List[Dict[str, Any]]:
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.get(
            DEEZER_SEARCH_URL,
            params={"q": query, "index": str(offset), "limit": str(limit)},
        )
        resp.raise_for_status()
        data = resp.json()

    items = data.get("data") or []
    tracks: List[Dict[str, Any]] = []
    for it in items:
        tracks.append(
            {
                "id": it.get("id"),
                "title": it.get("title"),
                "link": it.get("link"),
                "preview": it.get("preview"),
                "duration": it.get("duration"),
                "artist": it.get("artist"),
                "album": it.get("album"),
            }
        )
    return tracks


def _make_tracks_caption(query: str, offset: int) -> str:
    page = offset // RESULTS_PER_PAGE + 1
    return f"Результаты Deezer для: “{query}” (стр. {page}, offset {offset})"


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    webapp_open_url = _webapp_url_for_open()
    reply_markup = None

    if webapp_open_url:
        # Use ReplyKeyboard WebApp button for reliable WebApp.sendData delivery.
        # In some Telegram clients, data from inline web_app buttons is less reliable.
        reply_markup = ReplyKeyboardMarkup(
            [
                [
                    KeyboardButton(
                        text="Открыть мини‑приложение",
                        web_app=WebAppInfo(url=webapp_open_url),
                    )
                ]
            ],
            resize_keyboard=True,
            is_persistent=True,
        )

    mini_hint = "мини‑приложение отключено (WEBAPP_URL не задан)."
    if webapp_open_url:
        mini_hint = "мини‑приложение включено."

    try:
        await update.message.reply_text(
            "Бот: поиск музыки в Deezer.\n\n"
            "Команды:\n"
            "/search <запрос> — результаты с кнопками.\n"
            "/likes — мои лайки.\n\n"
            f"Статус: {mini_hint}\n\n"
            "Открывай Mini App через кнопку клавиатуры под сообщением.\n\n"
            "В Telegram отправляется только `preview` (короткий фрагмент) и ссылка на Deezer.\n",
            parse_mode=ParseMode.MARKDOWN,
            reply_markup=reply_markup,
        )
    except BadRequest as e:
        # If Telegram rejects the web_app url, fall back to plain message.
        logging.warning("BadRequest while sending /start message with webapp: %s", e)
        await update.message.reply_text(
            "Бот: поиск музыки в Deezer.\n\n"
            "Команды:\n"
            "/search <запрос> — результаты с кнопками.\n"
            "/likes — мои лайки.\n\n"
            "Мини‑приложение временно отключено из-за некорректного URL.\n",
            parse_mode=ParseMode.MARKDOWN,
        )


async def cmd_search(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    args = context.args or []
    if not args:
        await update.message.reply_text("Использование: /search <запрос>")
        return

    query = " ".join(args).strip()
    if not query:
        await update.message.reply_text("Введите запрос после команды.")
        return
    if len(query) > MAX_QUERY_LEN:
        await update.message.reply_text(f"Запрос слишком длинный (до {MAX_QUERY_LEN} символов).")
        return

    msg = await update.message.reply_text("Ищу в Deezer...")
    session_id = _make_session_id()

    try:
        tracks = await deezer_search(query=query, offset=0, limit=RESULTS_PER_PAGE)
    except httpx.HTTPError as e:
        logging.exception("Deezer search failed")
        await msg.edit_text(f"Ошибка при поиске в Deezer: {e}")
        return

    SESSIONS[session_id] = SearchSession(query=query, offset=0, tracks=tracks)
    kb = _build_tracks_keyboard(session_id=session_id, tracks=tracks, page=1)
    await msg.edit_text(_make_tracks_caption(query=query, offset=0), reply_markup=kb)


async def on_noop(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    q = update.callback_query
    if q:
        await q.answer()


async def on_preview(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    q = update.callback_query
    if not q or not q.data:
        return

    try:
        _, session_id, idx_str = q.data.split(":", 2)
        idx = int(idx_str)
    except Exception:
        await q.answer("Некорректные данные", show_alert=True)
        return

    session = SESSIONS.get(session_id)
    if not session:
        await q.answer("Сессия устарела. Повтори /search.", show_alert=True)
        return

    if idx < 0 or idx >= len(session.tracks):
        await q.answer("Трек не найден", show_alert=True)
        return

    track = session.tracks[idx]
    preview_url: Optional[str] = track.get("preview")
    if not preview_url:
        await q.answer("У этого трека нет preview.", show_alert=True)
        return

    title = track.get("title") or "Track"
    performer = (track.get("artist") or {}).get("name") or "Unknown"

    await q.answer()
    await context.bot.send_audio(
        chat_id=q.message.chat_id,
        audio=preview_url,
        title=title,
        performer=performer,
    )


async def on_page(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    q = update.callback_query
    if not q or not q.data:
        return

    try:
        _, session_id, delta_str = q.data.split(":", 2)
        delta = int(delta_str)
    except Exception:
        await q.answer("Некорректные данные", show_alert=True)
        return

    session = SESSIONS.get(session_id)
    if not session:
        await q.answer("Сессия устарела. Повтори /search.", show_alert=True)
        return

    new_offset = session.offset + delta * RESULTS_PER_PAGE
    if new_offset < 0:
        new_offset = 0

    await q.answer()

    try:
        tracks = await deezer_search(query=session.query, offset=new_offset, limit=RESULTS_PER_PAGE)
    except httpx.HTTPError:
        await q.message.reply_text("Ошибка при подгрузке страницы.")
        return

    session.offset = new_offset
    session.tracks = tracks

    page = new_offset // RESULTS_PER_PAGE + 1
    kb = _build_tracks_keyboard(session_id=session_id, tracks=tracks, page=page)
    await q.message.edit_text(_make_tracks_caption(query=session.query, offset=new_offset), reply_markup=kb)


async def cmd_likes(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    if not user:
        return

    track_ids = _get_like_track_ids(user.id, limit=10)
    if not track_ids:
        await update.message.reply_text(
            "Пока нет лайков. Открой мини‑приложение и нажми “Лайк”."
        )
        return

    # Fetch details in parallel (best-effort).
    async with httpx.AsyncClient(timeout=20) as client:
        tasks = [client.get(f"https://api.deezer.com/track/{tid}") for tid in track_ids]
        responses = await asyncio.gather(*tasks, return_exceptions=True)

    lines: List[str] = []
    for resp, tid in zip(responses, track_ids):
        if isinstance(resp, Exception):
            continue
        if getattr(resp, "status_code", 0) != 200:
            continue
        data = resp.json()
        title = data.get("title") or "Track"
        artist = (data.get("artist") or {}).get("name") or "Unknown"
        lines.append(f"- {artist} — {title} (id: {tid})")

    await update.message.reply_text("Твои лайки:\n" + "\n".join(lines))


async def cmd_comments(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    args = context.args or []
    if not args:
        await update.message.reply_text("Использование: /comments <trackId>")
        return

    try:
        track_id = int(args[0])
    except Exception:
        await update.message.reply_text("trackId должен быть числом.")
        return

    user = update.effective_user
    if not user:
        return

    comments = _get_user_comments(user.id, track_id, limit=10)
    if not comments:
        await update.message.reply_text("Нет комментариев для этого трека.")
        return

    lines = [f"- {created_at}: {comment}" for comment, created_at in comments]
    await update.message.reply_text("Твои комментарии:\n" + "\n".join(lines))


def _is_liked(user_id: int, track_id: int) -> bool:
    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute(
            "SELECT 1 FROM likes WHERE user_id = ? AND track_id = ?",
            (user_id, track_id),
        ).fetchone()
        return row is not None


async def on_web_action_play(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    q = update.callback_query
    if not q or not q.data or not q.from_user:
        return
    try:
        _, tid_str = q.data.split(":", 1)
        track_id = int(tid_str)
    except Exception:
        await q.answer("Некорректно", show_alert=True)
        return

    await q.answer()
    try:
        track = await deezer_get_track(track_id)
    except httpx.HTTPError:
        await q.message.reply_text("Не удалось загрузить трек из Deezer.")
        return

    preview_url: Optional[str] = (track or {}).get("preview")
    title = (track or {}).get("title") or "Track"
    performer = ((track or {}).get("artist") or {}).get("name") or "Unknown"
    if preview_url:
        await context.bot.send_audio(
            chat_id=q.message.chat_id,
            audio=preview_url,
            title=title,
            performer=performer,
        )
    else:
        await context.bot.send_message(chat_id=q.message.chat_id, text=f"{performer} — {title}")


async def on_web_action_like(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    q = update.callback_query
    user = update.effective_user
    if not q or not q.data or not user:
        return
    try:
        _, tid_str = q.data.split(":", 1)
        track_id = int(tid_str)
    except Exception:
        await q.answer("Некорректно", show_alert=True)
        return

    current = _is_liked(user.id, track_id)
    _set_like(user.id, track_id=track_id, liked=not current)

    await q.answer()
    await q.message.reply_text("Готово: лайк обновлен.")


async def on_web_action_comment(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    q = update.callback_query
    user = update.effective_user
    if not q or not q.data or not user:
        return
    try:
        _, tid_str = q.data.split(":", 1)
        track_id = int(tid_str)
    except Exception:
        await q.answer("Некорректно", show_alert=True)
        return

    AWAITING_COMMENT[user.id] = track_id
    await q.answer()
    await q.message.reply_text("Напиши комментарий к этому треку сообщением. (Например: 'классно!')")


async def on_comment_text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    if not user or not update.message or not update.message.text:
        return
    if user.id not in AWAITING_COMMENT:
        return

    track_id = AWAITING_COMMENT.pop(user.id)
    comment = update.message.text.strip()
    if not (1 <= len(comment) <= COMMENT_MAX_LEN):
        await update.message.reply_text(f"Комментарий должен быть от 1 до {COMMENT_MAX_LEN} символов. Попробуй снова.")
        AWAITING_COMMENT[user.id] = track_id
        return

    _add_comment(user.id, track_id=track_id, comment=comment)
    await update.message.reply_text("Комментарий сохранен.")


async def on_webapp_data(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """
    Receives JSON payloads from Telegram Web App (WebApp.sendData()).
    Payload format:
      { "action": "like"|"comment"|"play", "trackId": 123, ... }
    """
    message = update.effective_message
    webapp_data = getattr(message, "web_app_data", None)
    if not webapp_data or not getattr(webapp_data, "data", None):
        return

    user = update.effective_user
    if not user:
        return
    chat = update.effective_chat
    chat_id = chat.id if chat else user.id

    try:
        payload = json.loads(webapp_data.data)
    except Exception:
        return

    action = payload.get("action")

    _ensure_user(user.id, getattr(user, "username", None))

    if action == "search":
        query = _safe_str(payload.get("query")).strip()
        if not query:
            await context.bot.send_message(chat_id=chat_id, text="Пустой запрос.")
            return

        # Server-side search via Deezer (avoids WebView fetch restrictions).
        try:
            tracks = await deezer_search(query=query, offset=0, limit=RESULTS_PER_PAGE)
        except httpx.HTTPError as e:
            await context.bot.send_message(chat_id=chat_id, text=f"Ошибка Deezer: {e}")
            return

        # Build keyboard with bot-mediated actions.
        rows: List[List[InlineKeyboardButton]] = []
        for t in tracks:
            tid = int(t.get("id", 0))
            if not tid:
                continue
            title = t.get("title") or "Track"
            artist = (t.get("artist") or {}).get("name") if isinstance(t.get("artist"), dict) else None
            artist = artist or "Unknown"
            link = t.get("link") or f"https://www.deezer.com/track/{tid}"

            rows.append(
                [
                    InlineKeyboardButton(text=f"▶ {artist} - {title}", callback_data=f"webplay:{tid}"),
                    InlineKeyboardButton(text="Открыть в Deezer", url=link),
                ]
            )
            rows.append(
                [
                    InlineKeyboardButton(text="Лайк", callback_data=f"weblike:{tid}"),
                    InlineKeyboardButton(text="Комментарий", callback_data=f"webcomment:{tid}"),
                ]
            )

        if not rows:
            await context.bot.send_message(chat_id=chat_id, text="Ничего не найдено.")
            return

        kb = InlineKeyboardMarkup(inline_keyboard=rows)
        await context.bot.send_message(
            chat_id=chat_id,
            text=f"Результаты Deezer: {query}",
            reply_markup=kb,
        )
        return

    # For actions other than search we require trackId.
    track_id_raw = payload.get("trackId")
    try:
        track_id = int(track_id_raw)
    except Exception:
        return

    if action == "like":
        liked = bool(payload.get("liked", True))
        _set_like(user.id, track_id=track_id, liked=liked)
        # No chat spam: Mini App shows likes in "Профиль".
        return

    if action == "comment":
        comment = _safe_str(payload.get("comment")).strip()
        if not (1 <= len(comment) <= COMMENT_MAX_LEN):
            await context.bot.send_message(
                chat_id=chat_id,
                text=f"Комментарий должен быть от 1 до {COMMENT_MAX_LEN} символов.",
            )
            return
        _add_comment(user.id, track_id=track_id, comment=comment)
        # Mini App shows comments in modal; avoid duplicate messages in chat.
        return

    if action == "view_comments":
        # Comments are loaded in Mini App via HTTP API (see _start_comments_api_server).
        return

    if action == "play":
        # Re-fetch from Deezer for safety.
        try:
            track = await deezer_get_track(track_id)
        except httpx.HTTPError:
            await context.bot.send_message(chat_id=chat_id, text="Не удалось загрузить трек.")
            return

        preview_url: Optional[str] = (track or {}).get("preview")
        title = (track or {}).get("title") or "Track"
        performer = ((track or {}).get("artist") or {}).get("name") or "Unknown"
        deezer_link = (track or {}).get("link") or f"https://www.deezer.com/track/{track_id}"

        if preview_url:
            await context.bot.send_audio(
                chat_id=chat_id,
                audio=preview_url,
                title=title,
                performer=performer,
            )
        else:
            await context.bot.send_message(
                chat_id=chat_id,
                text=f"{performer} — {title}\n{deezer_link}",
            )
        return

    return


async def _reload_and_edit(
    q,
    context: ContextTypes.DEFAULT_TYPE,
    session: SearchSession,
    session_id: str,
    new_query: str,
) -> None:
    # Helper: reload tracks by query and update inline keyboard.
    session.query = new_query
    session.offset = 0

    try:
        tracks = await deezer_search(query=session.query, offset=0, limit=RESULTS_PER_PAGE)
    except httpx.HTTPError:
        await q.message.reply_text("Ошибка при поиске по артисту/альбому.")
        return

    session.tracks = tracks
    kb = _build_tracks_keyboard(session_id=session_id, tracks=tracks, page=1)
    await q.message.edit_text(_make_tracks_caption(query=session.query, offset=0), reply_markup=kb)


async def on_artistq(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    q = update.callback_query
    if not q or not q.data:
        return

    try:
        _, session_id, idx_str = q.data.split(":", 2)
        idx = int(idx_str)
    except Exception:
        await q.answer("Некорректные данные", show_alert=True)
        return

    session = SESSIONS.get(session_id)
    if not session:
        await q.answer("Сессия устарела. Повтори /search.", show_alert=True)
        return

    if idx < 0 or idx >= len(session.tracks):
        await q.answer("Трек не найден", show_alert=True)
        return

    artist_name = (session.tracks[idx].get("artist") or {}).get("name") or ""
    if not artist_name:
        await q.answer("Нет данных об артисте.", show_alert=True)
        return

    await q.answer()
    await _reload_and_edit(q, context, session, session_id=session_id, new_query=artist_name)


async def on_albumq(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    q = update.callback_query
    if not q or not q.data:
        return

    try:
        _, session_id, idx_str = q.data.split(":", 2)
        idx = int(idx_str)
    except Exception:
        await q.answer("Некорректные данные", show_alert=True)
        return

    session = SESSIONS.get(session_id)
    if not session:
        await q.answer("Сессия устарела. Повтори /search.", show_alert=True)
        return

    if idx < 0 or idx >= len(session.tracks):
        await q.answer("Трек не найден", show_alert=True)
        return

    track = session.tracks[idx]
    artist_name = (track.get("artist") or {}).get("name") or ""
    album_title = (track.get("album") or {}).get("title") or ""
    if not album_title:
        await q.answer("Нет данных об альбоме.", show_alert=True)
        return

    await q.answer()
    # Slightly better query: include artist.
    new_query = f"{artist_name} {album_title}".strip() if artist_name else album_title
    await _reload_and_edit(q, context, session, session_id=session_id, new_query=new_query)


def main() -> None:
    _init_db()
    _start_comments_api_server()
    logging.info("WEBAPP_URL=%s", WEBAPP_URL)
    logging.info("BOT_PUBLIC_API_URL=%s", BOT_PUBLIC_API_URL or "(not set — comments API only in Mini App if you set it)")
    application = Application.builder().token(BOT_TOKEN).build()

    application.add_handler(CommandHandler("start", cmd_start))
    application.add_handler(CommandHandler("search", cmd_search))
    application.add_handler(CommandHandler("likes", cmd_likes))
    application.add_handler(CommandHandler("comments", cmd_comments))

    application.add_handler(CallbackQueryHandler(on_noop, pattern=r"^noop$"))
    application.add_handler(CallbackQueryHandler(on_preview, pattern=r"^preview:"))
    application.add_handler(CallbackQueryHandler(on_artistq, pattern=r"^artistq:"))
    application.add_handler(CallbackQueryHandler(on_albumq, pattern=r"^albumq:"))
    application.add_handler(CallbackQueryHandler(on_page, pattern=r"^page:"))
    # Some clients can deliver WebApp payloads in message updates that don't match
    # StatusUpdate.WEB_APP_DATA consistently. We handle all messages and return early
    # in on_webapp_data when there's no web_app_data payload.
    application.add_handler(MessageHandler(filters.ALL, on_webapp_data))
    application.add_handler(CallbackQueryHandler(on_web_action_play, pattern=r"^webplay:"))
    application.add_handler(CallbackQueryHandler(on_web_action_like, pattern=r"^weblike:"))
    application.add_handler(CallbackQueryHandler(on_web_action_comment, pattern=r"^webcomment:"))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, on_comment_text))

    application.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()

