"""FastAPI 后端：日历、公告、老师端管理、图片、表情状态、AI 聊天。"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from datetime import date, datetime, timedelta
from pathlib import Path

from fastapi import Cookie, Depends, FastAPI, File, Form, Header, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
import httpx

from . import ai as ai_mod
from .db import (
    DATA_DIR,
    MEDIA_DIR,
    SUBJECTS,
    bump_revision,
    connect,
    db,
    get_setting,
    hash_password,
    now_iso,
    set_setting,
    verify_password,
)
from .recurrence import Recurrence, Stage, occurrence_dates
from .uploads import UploadError, save_image

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"

app = FastAPI(title="Robot Board API", version="1.0", docs_url="/api/docs")

SESSION_COOKIE = "rb_session"
SESSION_TTL = 60 * 60 * 24 * 14  # 两周


# ---------------------------------------------------------------- 工具函数

def now() -> str:
    return now_iso()


def pick(lang: str, zh, en):
    """按语言取文本，另一种语言作为回退。返回 (文本, 实际语言)。"""
    if lang == "en":
        if en and str(en).strip():
            return str(en).strip(), "en"
        if zh and str(zh).strip():
            return str(zh).strip(), "zh"
        return "", ""
    if zh and str(zh).strip():
        return str(zh).strip(), "zh"
    if en and str(en).strip():
        return str(en).strip(), "en"
    return "", ""


def parse_date(value: str | None, field: str) -> str:
    if not value:
        raise HTTPException(400, f"{field} 不能为空")
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        raise HTTPException(400, f"{field} 必须是 YYYY-MM-DD 格式")


def session_secret(conn) -> str:
    secret = get_setting(conn, "session_secret")
    if not secret:
        secret = os.urandom(32).hex()
        set_setting(conn, "session_secret", secret)
    return secret


def make_token(conn, ttl: int = SESSION_TTL) -> str:
    exp = str(int(time.time()) + ttl)
    sig = hmac.new(session_secret(conn).encode(), exp.encode(), hashlib.sha256).hexdigest()
    return base64.urlsafe_b64encode(f"{exp}.{sig}".encode()).decode()


def check_token(conn, token: str | None) -> bool:
    if not token:
        return False
    try:
        raw = base64.urlsafe_b64decode(token.encode()).decode()
        exp, sig = raw.split(".", 1)
    except Exception:
        return False
    if int(exp) < time.time():
        return False
    expect = hmac.new(session_secret(conn).encode(), exp.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(sig, expect)


def require_auth(rb_session: str | None = Cookie(default=None)) -> None:
    with db() as conn:
        if not check_token(conn, rb_session):
            raise HTTPException(401, "请先登录")


# ---------------------------------------------------------------- 限流

# 部署到公网后，登录接口和 AI 接口不登录就能调，得挡住暴力破解和刷接口。
_LOGIN_FAILS: dict[str, list[float]] = {}
_AI_HITS: dict[str, list[float]] = {}
LOGIN_MAX_FAILS = 10         # 10 分钟内错这么多次就锁住
LOGIN_WINDOW = 10 * 60
AI_MAX_PER_MIN = 30         # AI 接口每个 IP 每分钟最多问这么多次


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _recent(bucket: dict[str, list[float]], key: str, window: float) -> list[float]:
    now_ts = time.time()
    hits = [t for t in bucket.get(key, []) if now_ts - t < window]
    bucket[key] = hits
    return hits


def _prune(bucket: dict[str, list[float]], window: float) -> None:
    """桶里 IP 太多时清一遍过期记录，免得被刷爆内存。"""
    if len(bucket) < 500:
        return
    now_ts = time.time()
    for key in [k for k, v in bucket.items() if not [t for t in v if now_ts - t < window]]:
        bucket.pop(key, None)


def _is_blocked(bucket: dict[str, list[float]], key: str, limit: int, window: float) -> bool:
    return len(_recent(bucket, key, window)) >= limit


def _record(bucket: dict[str, list[float]], key: str, window: float) -> None:
    hits = _recent(bucket, key, window)
    hits.append(time.time())
    bucket[key] = hits
    _prune(bucket, window)


def _allow(bucket: dict[str, list[float]], key: str, limit: int, window: float) -> bool:
    hits = _recent(bucket, key, window)
    if len(hits) >= limit:
        return False
    hits.append(time.time())
    bucket[key] = hits
    return True


@app.middleware("http")
async def _security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "same-origin"
    return response


def load_stages(conn, event_id: int) -> list[Stage]:
    rows = conn.execute(
        "SELECT * FROM stages WHERE event_id = ? ORDER BY seq, id", (event_id,)
    ).fetchall()
    return [Stage.from_row(r) for r in rows]


def load_tags(conn, event_id: int) -> list[dict]:
    rows = conn.execute(
        "SELECT tag_id, weight FROM event_tags WHERE event_id = ? ORDER BY tag_id",
        (event_id,),
    ).fetchall()
    return [{"tag_id": r["tag_id"], "weight": r["weight"]} for r in rows]


def subject_color(conn, subject_id: str) -> str:
    row = conn.execute("SELECT color FROM subjects WHERE id = ?", (subject_id,)).fetchone()
    return row["color"] if row else "#9a8f85"


def event_payload(conn, row, lang: str) -> dict:
    title, title_src = pick(lang, row["title_zh"], row["title_en"])
    body, body_src = pick(lang, row["body_zh"], row["body_en"])
    location, _ = pick(lang, row["location_zh"], row["location_en"])
    stages = load_stages(conn, row["id"])
    return {
        "id": row["id"],
        "title": title,
        "title_src": title_src,
        "body": body,
        "body_src": body_src,
        "location": location,
        "subject": row["subject_id"],
        "color": subject_color(conn, row["subject_id"]),
        "photo_id": row["photo_id"],
        "version": row["version"],
        "updated_at": row["updated_at"],
        "tags": load_tags(conn, row["id"]),
        "stages": [
            {
                "id": s.id,
                "seq": s.seq,
                "name": pick(lang, s.name_zh, s.name_en)[0],
                "date_mode": s.date_mode,
                "offset_days": s.offset_days,
                "fixed_md": s.fixed_md,
                "fixed_date": s.fixed_date,
                "show_on_calendar": s.show_on_calendar,
                "show_in_banner": s.show_in_banner,
                "color": s.color,
            }
            for s in stages
        ],
    }


# ---------------------------------------------------------------- 启动钩子

@app.on_event("startup")
def _startup() -> None:
    from .db import init_db, seed_demo

    init_db()
    seed_demo()
    with db() as conn:
        if get_setting(conn, "session_secret") == "":
            set_setting(conn, "session_secret", os.urandom(32).hex())


# ---------------------------------------------------------------- 公开接口

@app.get("/api/meta")
def api_meta():
    with db() as conn:
        subjects = [
            {
                "id": r["id"],
                "name_zh": r["name_zh"],
                "name_en": r["name_en"],
                "color": r["color"],
            }
            for r in conn.execute("SELECT * FROM subjects ORDER BY sort_order")
        ]
        return {
            "subjects": subjects,
            "revision": int(get_setting(conn, "revision", "1")),
            "academic_year_start": get_setting(conn, "academic_year_start", "08-01"),
            "school_name_zh": get_setting(conn, "school_name_zh"),
            "school_name_en": get_setting(conn, "school_name_en"),
            "ai_model": get_setting(conn, "ai_model"),
            "ai_available": ai_mod.health(),
        }


@app.get("/api/sync/version")
def api_version():
    with db() as conn:
        return {"revision": int(get_setting(conn, "revision", "1"))}


def expand_event_chips(conn, start_d: date, end_d: date, lang: str, today_d: date | None = None) -> list[dict]:
    """把活动按循环规则展开成区间内的日历条目。"""
    today_d = today_d or date.today()
    chips = []
    rows = conn.execute(
        "SELECT e.*, r.* , e.id AS eid FROM events e "
        "JOIN recurrences r ON r.id = e.recurrence_id "
        "WHERE e.deleted = 0"
    ).fetchall()

    for row in rows:
        rec = Recurrence(
            freq=row["freq"],
            interval=row["interval"],
            starts_on=row["starts_on"],
            until_on=row["until_on"],
            max_count=row["max_count"],
            byweekday=row["byweekday"],
            bynth=row["bynth"],
            bymonth=row["bymonth"],
            bymonthday=row["bymonthday"],
        )
        stages = load_stages(conn, row["id"])
        tags = load_tags(conn, row["id"])
        title, title_src = pick(lang, row["title_zh"], row["title_en"])
        color = subject_color(conn, row["subject_id"])

        for occ, resolved in occurrence_dates(rec, stages, start_d, end_d):
            # 同一次活动的所有阶段日期。屏幕上要画时间线，
            # 光有「这一天有哪些条目」不够，得知道这次活动的每个节点落在哪天。
            stage_dates = [
                {
                    "stage_id": s.id,
                    "name": pick(lang, s.name_zh, s.name_en)[0],
                    "date": d.isoformat(),
                    "color": s.color or color,
                    "show_on_calendar": s.show_on_calendar,
                    "show_in_banner": s.show_in_banner,
                    "offset_days": s.offset_days,
                }
                for s, d in resolved
            ]
            if start_d <= occ <= end_d:
                chips.append({
                    "event_id": row["id"],
                    "stage_id": None,
                    "date": occ.isoformat(),
                    "occurrence_date": occ.isoformat(),
                    "stage_dates": stage_dates,
                    "title": title,
                    "title_src": title_src,
                    "subject": row["subject_id"],
                    "color": color,
                    "tags": tags,
                    "is_stage": False,
                    "seq": -1,
                    "photo_id": row["photo_id"],
                    "banner_text": title,
                    "past": occ < today_d,
                })
            for st, sd in resolved:
                if not st.show_on_calendar:
                    continue
                if not (start_d <= sd <= end_d):
                    continue
                sname, _ = pick(lang, st.name_zh, st.name_en)
                chips.append({
                    "event_id": row["id"],
                    "stage_id": st.id,
                    "date": sd.isoformat(),
                    "occurrence_date": occ.isoformat(),
                    "stage_dates": stage_dates,
                    "title": title,
                    "title_src": title_src,
                    "stage_name": sname,
                    "subject": row["subject_id"],
                    "color": st.color or color,
                    "tags": tags,
                    "is_stage": True,
                    "seq": st.seq,
                    "photo_id": row["photo_id"],
                    "show_in_banner": st.show_in_banner,
                    "banner_text": f"{title} · {sname}" if sname else title,
                    "past": sd < today_d,
                })
    return chips


def announcement_active(row, today: date) -> bool:
    """公告在有效期内才该出现在屏幕上。"""
    for field, cmp in (("starts_on", "gt"), ("ends_on", "lt")):
        raw = row[field]
        if not raw:
            continue
        try:
            d = date.fromisoformat(raw)
        except ValueError:
            continue
        if cmp == "gt" and d > today:
            return False
        if cmp == "lt" and d < today:
            return False
    return True


def announcement_expired(row, today: date) -> bool:
    """过期公告不撤下，只是显示成灰色。"""
    raw = row["ends_on"]
    if not raw:
        return False
    try:
        return date.fromisoformat(raw) < today
    except ValueError:
        return False


def announcement_payload(conn, row, lang: str) -> dict:
    title, title_src = pick(lang, row["title_zh"], row["title_en"])
    body, body_src = pick(lang, row["body_zh"], row["body_en"])
    today = date.today()
    return {
        "id": row["id"],
        "title": title,
        "title_src": title_src,
        "body": body,
        "body_src": body_src,
        "photo_id": row["photo_id"],
        "starts_on": row["starts_on"],
        "ends_on": row["ends_on"],
        "show_on_calendar": bool(row["show_on_calendar"]),
        "version": row["version"],
        "updated_at": row["updated_at"],
        # 过期的不撤下，只是置灰
        "expired": announcement_expired(row, today),
        "active": announcement_active(row, today),
        # 老师端要能同时编辑中英文
        "title_zh": row["title_zh"],
        "title_en": row["title_en"],
        "body_zh": row["body_zh"],
        "body_en": row["body_en"],
    }


@app.get("/api/calendar/range")
def api_calendar_range(start: str, end: str, lang: str = "zh", today: str | None = None):
    start_d = date.fromisoformat(start)
    end_d = date.fromisoformat(end)
    if end_d < start_d:
        raise HTTPException(400, "end 不能早于 start")

    today_d = date.fromisoformat(today) if today else date.today()

    with db() as conn:
        chips = expand_event_chips(conn, start_d, end_d, lang, today_d)

        ann_rows = conn.execute(
            "SELECT * FROM announcements WHERE show_on_calendar = 1 ORDER BY created_at DESC"
        ).fetchall()
        for a in ann_rows:
            d = a["starts_on"] or a["created_at"][:10]
            try:
                dd = date.fromisoformat(d)
            except ValueError:
                continue
            if not (start_d <= dd <= end_d):
                continue
            title, title_src = pick(lang, a["title_zh"], a["title_en"])
            chips.append({
                "event_id": None,
                "announcement_id": a["id"],
                "stage_id": None,
                "date": dd.isoformat(),
                "occurrence_date": dd.isoformat(),
                "stage_dates": [],
                "title": title,
                "title_src": title_src,
                "subject": "activity",
                "color": "#9a8f85",
                "tags": [],
                "is_stage": False,
                "seq": -1,
                "photo_id": a["photo_id"],
                "is_announcement": True,
                "banner_text": title,
                "past": announcement_expired(a, today_d),
            })

    chips.sort(key=lambda c: (c["date"], c["seq"]))
    return {"start": start, "end": end, "today": today, "chips": chips}


@app.get("/api/banner")
def api_banner(lang: str = "zh", days: int = 30):
    """公告栏内容：校园公告 + 未来若干天内到期、且勾了「在公告栏显示」的节点。"""
    today = date.today()
    span = max(1, min(days, 180))
    end_d = today + timedelta(days=span)

    with db() as conn:
        chips = expand_event_chips(conn, today, end_d, lang)

        deadlines = []
        upcoming = []
        by_event = {}
        for c in chips:
            by_event.setdefault(c["event_id"], []).append(c)

        for group in by_event.values():
            stage_dates = {c["date"] for c in group if c["is_stage"]}
            for c in group:
                d = date.fromisoformat(c["date"])
                if d < today:
                    continue
                # 活动当天正好有阶段节点时只留阶段那条，否则同一天会显示两遍
                if not c["is_stage"] and c["date"] in stage_dates:
                    continue
                item = {
                    "kind": "deadline" if c["is_stage"] else "event",
                    "event_id": c["event_id"],
                    "stage_id": c["stage_id"],
                    "date": c["date"],
                    "title": c["title"],
                    "stage_name": c.get("stage_name", ""),
                    "text": c["banner_text"],
                    "subject": c["subject"],
                    "color": c["color"],
                    "days_left": (d - today).days,
                }
                # 「即将到来」要包含活动本身（可能没有阶段节点）
                upcoming.append(item)
                # 公告栏只放老师勾了「在公告栏显示」的阶段节点
                if c["is_stage"] and c.get("show_in_banner"):
                    deadlines.append(item)
        deadlines.sort(key=lambda x: (x["date"], x["stage_id"] or 0))
        upcoming.sort(key=lambda x: (x["date"], x["stage_id"] or 0))

        anns = []
        expired = []
        for a in conn.execute("SELECT * FROM announcements ORDER BY created_at DESC").fetchall():
            title, title_src = pick(lang, a["title_zh"], a["title_en"])
            item = {
                "kind": "announcement",
                "id": a["id"],
                "title": title,
                "text": title,
                "photo_id": a["photo_id"],
                "starts_on": a["starts_on"],
                "ends_on": a["ends_on"],
                "expired": announcement_expired(a, today),
            }
            # 过期公告不撤下，排在最后并且置灰
            if item["expired"]:
                expired.append(item)
            else:
                anns.append(item)
        anns.extend(expired[:20])

    return {
        "announcements": anns,
        "deadlines": deadlines,
        "upcoming": upcoming,
    }


@app.get("/api/events/{event_id}")
def api_event_detail(event_id: int, lang: str = "zh"):
    with db() as conn:
        row = conn.execute("SELECT * FROM events WHERE id = ? AND deleted = 0", (event_id,)).fetchone()
        if not row:
            raise HTTPException(404, "找不到这个活动")
        rec_row = conn.execute("SELECT * FROM recurrences WHERE id = ?", (row["recurrence_id"],)).fetchone()
        rec = Recurrence.from_row(rec_row)
        payload = event_payload(conn, row, lang)
        payload["recurrence"] = {
            "freq": rec.freq,
            "interval": rec.interval,
            "starts_on": rec.starts_on,
            "until_on": rec.until_on,
            "max_count": rec.max_count,
            "byweekday": rec.byweekday,
            "bynth": rec.bynth,
            "bymonth": rec.bymonth,
            "bymonthday": rec.bymonthday,
        }
        return payload


@app.get("/api/announcements")
def api_announcements(lang: str = "zh", scope: str = "all"):
    """scope=all 给老师端看全部；scope=active 只给屏幕端看还没过期的。"""
    today = date.today()
    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM announcements ORDER BY COALESCE(starts_on, created_at) DESC, id DESC"
        ).fetchall()
        out = []
        for r in rows:
            if scope == "active" and not announcement_active(r, today):
                continue
            out.append(announcement_payload(conn, r, lang))
        return {"announcements": out}


@app.get("/api/uploads/{upload_id}")
def api_upload(upload_id: int):
    with db() as conn:
        row = conn.execute("SELECT * FROM uploads WHERE id = ?", (upload_id,)).fetchone()
    if not row:
        raise HTTPException(404, "图片不存在")
    path = MEDIA_DIR / Path(row["path"]).name
    if not path.exists():
        raise HTTPException(404, "图片文件已丢失")
    return FileResponse(path, media_type=row["mime"])


@app.get("/api/face/state")
def api_face_get():
    with db() as conn:
        row = conn.execute("SELECT * FROM face_states WHERE id = 1").fetchone()
        if not row:
            return {"expression": "idle", "intensity": 1.0, "updated_at": None}
        return {"expression": row["expression"], "intensity": row["intensity"], "updated_at": row["updated_at"]}


@app.post("/api/face/state")
def api_face_set(payload: dict, _: None = Depends(require_auth)):
    expr = str(payload.get("expression", "idle"))
    if expr not in {"idle", "thinking", "happy", "alert"}:
        raise HTTPException(400, "expression 只能是 idle / thinking / happy / alert")
    intensity = float(payload.get("intensity", 1.0))
    with db() as conn:
        conn.execute(
            "UPDATE face_states SET expression = ?, intensity = ?, updated_at = ? WHERE id = 1",
            (expr, intensity, now()),
        )
    return {"expression": expr, "intensity": intensity}


@app.get("/api/ai/health")
def api_ai_health():
    return {"available": ai_mod.health(), "model": ai_mod.model_name()}


@app.post("/api/ai/test")
def api_ai_test(_: None = Depends(require_auth)):
    """老师点「测试连接」：真发一句话过去，看能不能回。"""
    try:
        answer = ai_mod.complete([{"role": "user", "content": "用一句话说你好"}])
        return {"ok": True, "answer": answer[:200]}
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code
        hint = {
            400: "地址或模型名不对",
            401: "密钥不对，或者没填",
            403: "这个密钥没有权限用这个模型",
            404: "地址或模型名不对",
            429: "额度用完了，或者被限流",
        }.get(status, f"接口返回 {status}")
        return {"ok": False, "error": hint}
    except Exception as exc:
        return {"ok": False, "error": str(exc)[:200]}


# ---------------------------------------------------------------- 登录

@app.post("/api/auth/login")
def api_login(request: Request, response: Response, payload: dict):
    ip = _client_ip(request)
    if _is_blocked(_LOGIN_FAILS, ip, LOGIN_MAX_FAILS, LOGIN_WINDOW):
        raise HTTPException(429, "密码错太多次了，等 10 分钟再试")
    password = str(payload.get("password", ""))
    with db() as conn:
        stored = get_setting(conn, "admin_password_hash")
        if not verify_password(password, stored):
            _record(_LOGIN_FAILS, ip, LOGIN_WINDOW)
            raise HTTPException(401, "密码不对")
        token = make_token(conn)
    _LOGIN_FAILS.pop(ip, None)
    secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    response.set_cookie(
        SESSION_COOKIE, token, httponly=True, samesite="lax", secure=secure,
        max_age=SESSION_TTL, path="/"
    )
    return {"ok": True}


@app.post("/api/auth/logout")
def api_logout(response: Response):
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


@app.get("/api/auth/me")
def api_me(rb_session: str | None = Cookie(default=None)):
    with db() as conn:
        return {"authenticated": check_token(conn, rb_session)}


# ---------------------------------------------------------------- 事件管理

def _recurrence_payload(payload: dict) -> dict:
    rec = payload.get("recurrence") or {}
    freq = str(rec.get("freq", "none"))
    allowed = {"none", "daily", "weekly", "monthly", "monthly_last", "yearly", "yearly_nth"}
    if freq not in allowed:
        raise HTTPException(400, f"循环方式只能是 {', '.join(sorted(allowed))}")
    starts_on = parse_date(rec.get("starts_on"), "开始日期")
    until_on = rec.get("until_on") or None
    if until_on:
        until_on = parse_date(until_on, "结束日期")
    return {
        "freq": freq,
        "interval": int(rec.get("interval") or 1),
        "starts_on": starts_on,
        "until_on": until_on,
        "max_count": int(rec["max_count"]) if rec.get("max_count") else None,
        "byweekday": int(rec["byweekday"]) if rec.get("byweekday") is not None else None,
        "bynth": int(rec["bynth"]) if rec.get("bynth") is not None else None,
        "bymonth": int(rec["bymonth"]) if rec.get("bymonth") is not None else None,
        "bymonthday": int(rec["bymonthday"]) if rec.get("bymonthday") is not None else None,
    }


def _stage_payload(s: dict, seq: int) -> tuple:
    name_zh = (s.get("name_zh") or "").strip()
    name_en = (s.get("name_en") or "").strip()
    if not name_zh and not name_en:
        raise HTTPException(400, "阶段名称不能为空")
    mode = str(s.get("date_mode") or "offset")
    if mode not in {"offset", "fixed_md", "fixed_date"}:
        raise HTTPException(400, "阶段日期方式只能是 offset / fixed_md / fixed_date")
    fixed_md = s.get("fixed_md") or None
    if mode == "fixed_md" and not fixed_md:
        raise HTTPException(400, "固定月日格式的阶段必须填写 MM-DD")
    fixed_date = s.get("fixed_date") or None
    if mode == "fixed_date":
        fixed_date = parse_date(fixed_date, "固定日期")
    return (
        name_zh, name_en, mode, int(s.get("offset_days") or 0),
        fixed_md, fixed_date,
        1 if s.get("show_on_calendar", True) else 0,
        1 if s.get("show_in_banner", True) else 0,
        s.get("color") or None,
        seq,
    )


def _write_stages(conn, event_id: int, stages: list) -> None:
    conn.execute("DELETE FROM stages WHERE event_id = ?", (event_id,))
    for i, s in enumerate(stages or []):
        (name_zh, name_en, mode, offset_days, fixed_md, fixed_date,
         show_cal, show_banner, color, seq) = _stage_payload(s, i)
        conn.execute(
            "INSERT INTO stages(event_id, seq, name_zh, name_en, date_mode, offset_days, "
            "fixed_md, fixed_date, show_on_calendar, show_in_banner, color) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (event_id, seq, name_zh, name_en, mode, offset_days, fixed_md, fixed_date,
             show_cal, show_banner, color),
        )


def _write_tags(conn, event_id: int, tags: list) -> None:
    conn.execute("DELETE FROM event_tags WHERE event_id = ?", (event_id,))
    valid = {r["id"] for r in conn.execute("SELECT id FROM subjects")}
    for t in tags or []:
        tag_id = str(t.get("tag_id") or "")
        if tag_id not in valid:
            raise HTTPException(400, f"不存在的科目标签：{tag_id}")
        weight = int(t.get("weight") or 0)
        if weight <= 0:
            continue
        if weight > 100:
            raise HTTPException(400, "标签权重不能超过 100")
        conn.execute(
            "INSERT INTO event_tags(event_id, tag_id, weight) VALUES (?,?,?)",
            (event_id, tag_id, weight),
        )


@app.get("/api/admin/events")
def api_admin_events(lang: str = "zh", _: None = Depends(require_auth)):
    """老师端用：列出全部活动（含循环规则和阶段），方便编辑。"""
    with db() as conn:
        rows = conn.execute(
            "SELECT e.*, r.freq, r.interval, r.starts_on, r.until_on, r.max_count, "
            "r.byweekday, r.bynth, r.bymonth, r.bymonthday "
            "FROM events e JOIN recurrences r ON r.id = e.recurrence_id "
            "WHERE e.deleted = 0 ORDER BY e.id DESC"
        ).fetchall()
        out = []
        for row in rows:
            item = event_payload(conn, row, lang)
            item["recurrence"] = {
                "freq": row["freq"],
                "interval": row["interval"],
                "starts_on": row["starts_on"],
                "until_on": row["until_on"],
                "max_count": row["max_count"],
                "byweekday": row["byweekday"],
                "bynth": row["bynth"],
                "bymonth": row["bymonth"],
                "bymonthday": row["bymonthday"],
            }
            item["title_zh"] = row["title_zh"]
            item["title_en"] = row["title_en"]
            item["body_zh"] = row["body_zh"]
            item["body_en"] = row["body_en"]
            item["location_zh"] = row["location_zh"]
            item["location_en"] = row["location_en"]
            # 老师端要能同时编辑中英文，所以这里给原始字段，不给按语言选过的那一份
            item["stages"] = [
                {
                    "id": s["id"],
                    "seq": s["seq"],
                    "name_zh": s["name_zh"] or "",
                    "name_en": s["name_en"] or "",
                    "date_mode": s["date_mode"],
                    "offset_days": s["offset_days"],
                    "fixed_md": s["fixed_md"],
                    "fixed_date": s["fixed_date"],
                    "show_on_calendar": bool(s["show_on_calendar"]),
                    "show_in_banner": bool(s["show_in_banner"]),
                    "color": s["color"],
                }
                for s in conn.execute(
                    "SELECT * FROM stages WHERE event_id = ? ORDER BY seq, id", (row["id"],)
                ).fetchall()
            ]
            out.append(item)
    return {"events": out}


@app.post("/api/recurrence/preview")
def api_preview(payload: dict, _: None = Depends(require_auth)):
    """老师端预览：给定循环规则和阶段，算出接下来几次发生的实际日期。"""
    rec = _recurrence_payload(payload)
    rec_obj = Recurrence(
        freq=rec["freq"], interval=rec["interval"], starts_on=rec["starts_on"],
        until_on=rec["until_on"], max_count=rec["max_count"],
        byweekday=rec["byweekday"], bynth=rec["bynth"],
        bymonth=rec["bymonth"], bymonthday=rec["bymonthday"],
    )
    stages = []
    for i, s in enumerate(payload.get("stages") or []):
        mode = str(s.get("date_mode") or "offset")
        stages.append(Stage(
            id=i, seq=i,
            name_zh=(s.get("name_zh") or "").strip(),
            name_en=(s.get("name_en") or "").strip(),
            date_mode=mode,
            offset_days=int(s.get("offset_days") or 0),
            fixed_md=s.get("fixed_md") or None,
            fixed_date=s.get("fixed_date") or None,
        ))
    start = date.fromisoformat(rec["starts_on"])
    end = start + timedelta(days=760)
    out = []
    for occ, resolved in occurrence_dates(rec_obj, stages, start, end):
        out.append({
            "date": occ.isoformat(),
            "stages": [
                {"idx": s.id, "name": s.name_zh or s.name_en, "date": d.isoformat()}
                for s, d in resolved
            ],
        })
        if len(out) >= 4:
            break
    return {"occurrences": out}


@app.post("/api/events")
def api_create_event(payload: dict, _: None = Depends(require_auth)):
    title_zh = (payload.get("title_zh") or "").strip()
    title_en = (payload.get("title_en") or "").strip()
    if not title_zh and not title_en:
        raise HTTPException(400, "标题不能为空")
    subject_id = str(payload.get("subject_id") or "activity")
    with db() as conn:
        if not conn.execute("SELECT 1 FROM subjects WHERE id = ?", (subject_id,)).fetchone():
            raise HTTPException(400, "不存在的分类")
        rec = _recurrence_payload(payload)
        cur = conn.execute(
            "INSERT INTO recurrences(freq, interval, starts_on, until_on, max_count, "
            "byweekday, bynth, bymonth, bymonthday) VALUES (?,?,?,?,?,?,?,?,?)",
            (rec["freq"], rec["interval"], rec["starts_on"], rec["until_on"], rec["max_count"],
             rec["byweekday"], rec["bynth"], rec["bymonth"], rec["bymonthday"]),
        )
        rec_id = cur.lastrowid
        ts = now()
        cur = conn.execute(
            "INSERT INTO events(title_zh, title_en, body_zh, body_en, location_zh, location_en, "
            "subject_id, recurrence_id, photo_id, version, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,1,?,?)",
            (title_zh, title_en, payload.get("body_zh"), payload.get("body_en"),
             payload.get("location_zh"), payload.get("location_en"),
             subject_id, rec_id, payload.get("photo_id"), ts, ts),
        )
        event_id = cur.lastrowid
        _write_stages(conn, event_id, payload.get("stages"))
        _write_tags(conn, event_id, payload.get("tags"))
        bump_revision(conn)
    return {"id": event_id}


@app.patch("/api/events/{event_id}")
def api_update_event(event_id: int, payload: dict, if_match: str | None = Header(default=None),
                     _: None = Depends(require_auth)):
    with db() as conn:
        row = conn.execute("SELECT * FROM events WHERE id = ? AND deleted = 0", (event_id,)).fetchone()
        if not row:
            raise HTTPException(404, "找不到这个活动")
        if if_match is not None and str(row["version"]) != str(if_match):
            raise HTTPException(409, "这条内容刚被其他人改过，请刷新后重试")

        fields = {}
        for key in ("title_zh", "title_en", "body_zh", "body_en", "location_zh", "location_en"):
            if key in payload:
                fields[key] = payload[key]
        if "subject_id" in payload:
            subject_id = str(payload["subject_id"])
            if not conn.execute("SELECT 1 FROM subjects WHERE id = ?", (subject_id,)).fetchone():
                raise HTTPException(400, "不存在的分类")
            fields["subject_id"] = subject_id
        if "photo_id" in payload:
            fields["photo_id"] = payload["photo_id"]

        if "recurrence" in payload:
            rec = _recurrence_payload(payload)
            conn.execute(
                "UPDATE recurrences SET freq=?, interval=?, starts_on=?, until_on=?, max_count=?, "
                "byweekday=?, bynth=?, bymonth=?, bymonthday=? WHERE id = ?",
                (rec["freq"], rec["interval"], rec["starts_on"], rec["until_on"], rec["max_count"],
                 rec["byweekday"], rec["bynth"], rec["bymonth"], rec["bymonthday"], row["recurrence_id"]),
            )
        if "stages" in payload:
            _write_stages(conn, event_id, payload["stages"])
        if "tags" in payload:
            _write_tags(conn, event_id, payload["tags"])

        if fields:
            fields["version"] = row["version"] + 1
            fields["updated_at"] = now()
            sets = ", ".join(f"{k} = :{k}" for k in fields)
            conn.execute(f"UPDATE events SET {sets} WHERE id = :id", {**fields, "id": event_id})
        bump_revision(conn)
    return {"ok": True, "version": row["version"] + 1}


@app.delete("/api/events/{event_id}")
def api_delete_event(event_id: int, _: None = Depends(require_auth)):
    with db() as conn:
        row = conn.execute("SELECT id FROM events WHERE id = ? AND deleted = 0", (event_id,)).fetchone()
        if not row:
            raise HTTPException(404, "找不到这个活动")
        conn.execute("UPDATE events SET deleted = 1, updated_at = ? WHERE id = ?", (now(), event_id))
        bump_revision(conn)
    return {"ok": True}


@app.put("/api/events/{event_id}/tags")
def api_set_tags(event_id: int, payload: dict, _: None = Depends(require_auth)):
    tags = payload.get("tags") if isinstance(payload, dict) else payload
    with db() as conn:
        if not conn.execute("SELECT 1 FROM events WHERE id = ? AND deleted = 0", (event_id,)).fetchone():
            raise HTTPException(404, "找不到这个活动")
        _write_tags(conn, event_id, tags or [])
        bump_revision(conn)
    return {"ok": True}


# ---------------------------------------------------------------- 公告管理

@app.post("/api/announcements")
def api_create_announcement(payload: dict, _: None = Depends(require_auth)):
    title_zh = (payload.get("title_zh") or "").strip()
    title_en = (payload.get("title_en") or "").strip()
    if not title_zh and not title_en:
        raise HTTPException(400, "标题不能为空")
    ts = now()
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO announcements(title_zh, title_en, body_zh, body_en, photo_id, "
            "starts_on, ends_on, show_on_calendar, version, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,1,?,?)",
            (title_zh, title_en, payload.get("body_zh"), payload.get("body_en"),
             payload.get("photo_id"), payload.get("starts_on"), payload.get("ends_on"),
             1 if payload.get("show_on_calendar") else 0, ts, ts),
        )
        bump_revision(conn)
    return {"id": cur.lastrowid}


@app.patch("/api/announcements/{ann_id}")
def api_update_announcement(ann_id: int, payload: dict,
                            if_match: str | None = Header(default=None),
                            _: None = Depends(require_auth)):
    with db() as conn:
        row = conn.execute("SELECT * FROM announcements WHERE id = ?", (ann_id,)).fetchone()
        if not row:
            raise HTTPException(404, "找不到这条公告")
        if if_match is not None and str(row["version"]) != str(if_match):
            raise HTTPException(409, "这条内容刚被其他人改过，请刷新后重试")
        fields = {}
        for key in ("title_zh", "title_en", "body_zh", "body_en", "starts_on", "ends_on"):
            if key in payload:
                fields[key] = payload[key]
        if "photo_id" in payload:
            fields["photo_id"] = payload["photo_id"]
        if "show_on_calendar" in payload:
            fields["show_on_calendar"] = 1 if payload["show_on_calendar"] else 0
        if fields:
            fields["version"] = row["version"] + 1
            fields["updated_at"] = now()
            sets = ", ".join(f"{k} = :{k}" for k in fields)
            conn.execute(f"UPDATE announcements SET {sets} WHERE id = :id", {**fields, "id": ann_id})
        bump_revision(conn)
    return {"ok": True, "version": row["version"] + 1}


@app.delete("/api/announcements/{ann_id}")
def api_delete_announcement(ann_id: int, _: None = Depends(require_auth)):
    with db() as conn:
        if not conn.execute("SELECT 1 FROM announcements WHERE id = ?", (ann_id,)).fetchone():
            raise HTTPException(404, "找不到这条公告")
        conn.execute("DELETE FROM announcements WHERE id = ?", (ann_id,))
        bump_revision(conn)
    return {"ok": True}


# ---------------------------------------------------------------- 图片上传

@app.post("/api/uploads")
async def api_upload(file: UploadFile = File(...), _: None = Depends(require_auth)):
    raw = await file.read()
    try:
        info = save_image(raw, file.filename or "")
    except UploadError as exc:
        raise HTTPException(400, str(exc))
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO uploads(path, mime, width, height, bytes, original_name, created_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (info["path"], info["mime"], info["width"], info["height"], info["bytes"],
             info["original_name"], info["created_at"]),
        )
        bump_revision(conn)
    return {
        "id": cur.lastrowid,
        "url": f"/api/uploads/{cur.lastrowid}",
        "width": info["width"],
        "height": info["height"],
    }


# ---------------------------------------------------------------- 设置

def _mask_key(key: str) -> str:
    """只显示末尾 4 位，完整密钥永远不回传给前端。"""
    if not key:
        return ""
    if len(key) <= 8:
        return "••••"
    return "••••" + key[-4:]


@app.get("/api/settings")
def api_get_settings(_: None = Depends(require_auth)):
    with db() as conn:
        return {
            "ai_provider": get_setting(conn, "ai_provider", "ollama"),
            "ai_base_url": ai_mod.base_url(),
            "ai_model": get_setting(conn, "ai_model"),
            "ai_api_key_masked": _mask_key(ai_mod.api_key()),
            "ai_key_source": ai_mod.key_source(),
            "ai_num_ctx": get_setting(conn, "ai_num_ctx"),
            "academic_year_start": get_setting(conn, "academic_year_start"),
            "school_name_zh": get_setting(conn, "school_name_zh"),
            "school_name_en": get_setting(conn, "school_name_en"),
        }


@app.put("/api/settings")
def api_put_settings(payload: dict, _: None = Depends(require_auth)):
    with db() as conn:
        for key in ("ai_provider", "ai_base_url", "ai_model", "ai_num_ctx",
                    "academic_year_start", "school_name_zh", "school_name_en"):
            if key in payload:
                set_setting(conn, key, str(payload[key]).strip())
        if payload.get("new_password"):
            pwd = str(payload["new_password"])
            if len(pwd) < 4:
                raise HTTPException(400, "新密码至少 4 位")
            set_setting(conn, "admin_password_hash", hash_password(pwd))
        # 密钥：留空 = 不改动；clear_ai_api_key = 删掉数据库里那一份
        if payload.get("clear_ai_api_key"):
            set_setting(conn, "ai_api_key", "")
        elif payload.get("ai_api_key"):
            set_setting(conn, "ai_api_key", str(payload["ai_api_key"]).strip())
        bump_revision(conn)
    return {"ok": True}


# ---------------------------------------------------------------- AI 聊天

# AI 对话是公开的：屏幕端是公共布告板，学生随时可以提问，不需要登录
@app.post("/api/ai/chat")
def api_ai_chat(request: Request, payload: dict):
    if not _allow(_AI_HITS, _client_ip(request), AI_MAX_PER_MIN, 60):
        raise HTTPException(429, "问得太快了，歇一会儿")
    messages = payload.get("messages") or []
    if not messages:
        raise HTTPException(400, "没有消息")
    answer = ai_mod.complete(messages)
    return {"answer": answer}


@app.post("/api/ai/chat/stream")
async def api_ai_chat_stream(request: Request, payload: dict):
    if not _allow(_AI_HITS, _client_ip(request), AI_MAX_PER_MIN, 60):
        raise HTTPException(429, "问得太快了，歇一会儿")
    messages = payload.get("messages") or []
    if not messages:
        raise HTTPException(400, "没有消息")
    if not ai_mod.health():
        return JSONResponse(status_code=503, content={"error": "ai_unavailable"})

    async def gen():
        try:
            async for token in ai_mod.stream(messages):
                yield f"data: {json.dumps({'token': token}, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as exc:  # 网络中断等
            yield f"data: {json.dumps({'error': str(exc)}, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---------------------------------------------------------------- 静态页面

@app.get("/")
def index():
    return FileResponse(WEB_DIR / "display.html")


app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
