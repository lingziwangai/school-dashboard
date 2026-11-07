"""示例数据：第一次打开就能看到效果。

全部围绕国际生关心的竞赛与考试，AP 考试带多阶段（报名 / 交作品 / 正式考试），
阶段用 offset 模式，所以会自动跟随活动的年循环。
"""
from __future__ import annotations

from datetime import date

from .db import now_iso


def _rec(conn, *, freq, starts_on, interval=1, until_on=None, max_count=None,
         byweekday=None, bynth=None, bymonth=None, bymonthday=None) -> int:
    cur = conn.execute(
        "INSERT INTO recurrences(freq, interval, starts_on, until_on, max_count, "
        "byweekday, bynth, bymonth, bymonthday) VALUES (?,?,?,?,?,?,?,?,?)",
        (freq, interval, starts_on, until_on, max_count, byweekday, bynth, bymonth, bymonthday),
    )
    return cur.lastrowid


def _event(conn, *, title_zh, title_en=None, body_zh=None, body_en=None,
           location_zh=None, location_en=None, subject_id, rec_id,
           tags=None) -> int:
    ts = now_iso()
    cur = conn.execute(
        "INSERT INTO events(title_zh, title_en, body_zh, body_en, location_zh, location_en, "
        "subject_id, recurrence_id, version, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?,?,?,1,?,?)",
        (title_zh, title_en, body_zh, body_en, location_zh, location_en,
         subject_id, rec_id, ts, ts),
    )
    event_id = cur.lastrowid
    for tag_id, weight in (tags or []):
        conn.execute(
            "INSERT INTO event_tags(event_id, tag_id, weight) VALUES (?,?,?)",
            (event_id, tag_id, weight),
        )
    return event_id


def _stage(conn, event_id, seq, name_zh, name_en=None, *, offset_days=0,
           date_mode="offset", fixed_md=None, fixed_date=None,
           show_on_calendar=1, show_in_banner=1, color=None) -> None:
    conn.execute(
        "INSERT INTO stages(event_id, seq, name_zh, name_en, date_mode, offset_days, "
        "fixed_md, fixed_date, show_on_calendar, show_in_banner, color) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (event_id, seq, name_zh, name_en, date_mode, offset_days, fixed_md, fixed_date,
         show_on_calendar, show_in_banner, color),
    )


def seed_events(conn) -> None:
    year = date.today().year
    anchor = f"{year}-05-10"

    # ---- AP 考试（带完整三阶段）----
    rec = _rec(conn, freq="yearly", starts_on=anchor, bymonth=5, bymonthday=10)
    ev = _event(conn, title_zh="AP 微积分 BC 考试", title_en="AP Calculus BC Exam",
                body_zh="每年 5 月中旬开考。报名在校内统一完成，需提前提交成绩单与预估选课表。",
                body_en="Held every May. Registration is handled by the counseling office.",
                location_zh="教学楼 A 栋 302 考场", location_en="Building A, Room 302",
                subject_id="ap", rec_id=rec,
                tags=[("science", 70), ("engineering", 30)])
    _stage(conn, ev, 0, "报名截止", "Registration Deadline", offset_days=-160,
           color="#d4bb6b")
    _stage(conn, ev, 1, "考试日", "Exam Day", offset_days=0, color="#d4bb6b")

    rec = _rec(conn, freq="yearly", starts_on=anchor, bymonth=5, bymonthday=10)
    ev = _event(conn, title_zh="AP 计算机科学 A", title_en="AP Computer Science A",
                body_zh="包含笔试与作品集两部分，作品集必须在考试前一个月前提交。",
                body_en="Includes a written exam and a portfolio due one month before the exam.",
                location_zh="创客空间", location_en="Makerspace",
                subject_id="ap", rec_id=rec,
                tags=[("engineering", 60), ("science", 40)])
    _stage(conn, ev, 0, "报名截止", "Registration Deadline", offset_days=-160,
           color="#d4bb6b")
    _stage(conn, ev, 1, "交作品", "Portfolio Due", offset_days=-30, color="#d2914a")
    _stage(conn, ev, 2, "正式考试", "Exam Day", offset_days=0, color="#d4bb6b")

    rec = _rec(conn, freq="yearly", starts_on=f"{year}-05-11", bymonth=5, bymonthday=11)
    ev = _event(conn, title_zh="AP 美国历史", title_en="AP US History",
                body_zh="阅读量较大，建议从暑期开始准备 DBQ。",
                body_en="Heavy reading load; start preparing DBQs over the summer.",
                location_zh="教学楼 B 栋 205 考场", location_en="Building B, Room 205",
                subject_id="ap", rec_id=rec,
                tags=[("humanities", 70), ("social", 30)])
    _stage(conn, ev, 0, "报名截止", "Registration Deadline", offset_days=-160,
           color="#d4bb6b")
    _stage(conn, ev, 1, "正式考试", "Exam Day", offset_days=0, color="#d4bb6b")

    # ---- 数学竞赛 ----
    rec = _rec(conn, freq="yearly_nth", starts_on=f"{year}-11-07",
               bymonth=11, bynth=1, byweekday=5)
    ev = _event(conn, title_zh="AMC 12 美国数学竞赛", title_en="AMC 12 Mathematics Contest",
                body_zh="每年 11 月第一个周六上午 8:00 开考，2 小时 30 分钟，共 25 题。",
                body_en="First Saturday of November, 8:00 AM, 25 questions in 150 minutes.",
                location_zh="大礼堂", location_en="Main Auditorium",
                subject_id="science", rec_id=rec,
                tags=[("science", 60), ("engineering", 40)])
    _stage(conn, ev, 0, "校内报名截止", "School Registration Closes", offset_days=-30)
    _stage(conn, ev, 1, "正式比赛", "Contest Day", offset_days=0)

    rec = _rec(conn, freq="yearly", starts_on=f"{year}-03-14", bymonth=3, bymonthday=14)
    ev = _event(conn, title_zh="AIME 美国邀请赛", title_en="AIME Invitational",
                body_zh="AMC 12 成绩达到 100 分以上者方可报名。",
                body_en="Invitation only; requires a qualifying AMC 12 score.",
                location_zh="线上", location_en="Online",
                subject_id="science", rec_id=rec,
                tags=[("science", 100)])
    _stage(conn, ev, 0, "正式比赛", "Contest Day", offset_days=0)

    # ---- 物理 / 工程 ----
    rec = _rec(conn, freq="yearly", starts_on=f"{year}-11-15", bymonth=11, bymonthday=15)
    ev = _event(conn, title_zh="BPhO 英国物理奥林匹克 第一轮", title_en="BPhO Round 1",
                body_zh="5 道简答题 + 1 道实验题，校内设有统一报名名额。",
                body_en="5 short questions plus 1 experimental problem.",
                location_zh="物理实验室 3", location_en="Physics Lab 3",
                subject_id="engineering", rec_id=rec,
                tags=[("engineering", 65), ("science", 35)])
    _stage(conn, ev, 0, "校内报名截止", "School Registration Closes", offset_days=-35)
    _stage(conn, ev, 1, "正式比赛", "Contest Day", offset_days=0)

    rec = _rec(conn, freq="yearly", starts_on=f"{year}-04-20", bymonth=4, bymonthday=20)
    ev = _event(conn, title_zh="丘成桐中学科学奖", title_en="Yau Science Award",
                body_zh="分数学、物理、生物、化学、组队赛五个方向，需提交研究论文。",
                body_en="Five tracks; a research paper is required.",
                location_zh="线上提交", location_en="Online submission",
                subject_id="engineering", rec_id=rec,
                tags=[("engineering", 55), ("science", 45)])
    _stage(conn, ev, 0, "校内报名截止", "School Registration Closes", offset_days=-45)
    _stage(conn, ev, 1, "提交论文", "Paper Submission", offset_days=-20)
    _stage(conn, ev, 2, "正式评选", "Judging", offset_days=0)

    rec = _rec(conn, freq="yearly", starts_on=f"{year}-09-15", bymonth=9, bymonthday=15)
    ev = _event(conn, title_zh="全国中学生物理竞赛 预赛", title_en="National Physics Contest Prelim",
                body_zh="面向高一高二，考查力学与电磁学基础。",
                body_en="Open to grades 10-11; fundamentals of mechanics and E&M.",
                location_zh="阶梯教室", location_en="Lecture Hall",
                subject_id="engineering", rec_id=rec,
                tags=[("engineering", 60), ("science", 40)])
    _stage(conn, ev, 0, "报名截止", "Registration Deadline", offset_days=-25)
    _stage(conn, ev, 1, "预赛", "Preliminary Round", offset_days=0)

    # ---- 商科 ----
    rec = _rec(conn, freq="yearly", starts_on=f"{year}-12-10", bymonth=12, bymonthday=10)
    ev = _event(conn, title_zh="DECA 国际商业挑战赛", title_en="DECA Business Competition",
                body_zh="团队提交商业计划书并做现场展示，决赛在冬季举行。",
                body_en="Team business plan plus a live presentation.",
                location_zh="商科中心", location_en="Business Center",
                subject_id="business", rec_id=rec,
                tags=[("business", 75), ("social", 25)])
    _stage(conn, ev, 0, "组队与报名截止", "Team Registration Closes", offset_days=-45)
    _stage(conn, ev, 1, "初赛", "Preliminary Round", offset_days=0)

    # ---- 社科 / 文科 ----
    rec = _rec(conn, freq="yearly_nth", starts_on=f"{year}-11-20",
               bymonth=11, bynth=3, byweekday=4)
    ev = _event(conn, title_zh="模拟联合国 MUN 秋季会议", title_en="MUN Fall Conference",
                body_zh="立场文件需提前两周提交，英文辩论为主。",
                body_en="Position papers due two weeks in advance; debates in English.",
                location_zh="模拟联合国厅", location_en="MUN Hall",
                subject_id="social", rec_id=rec,
                tags=[("social", 70), ("humanities", 30)])
    _stage(conn, ev, 0, "立场文件截止", "Position Paper Due", offset_days=-14)
    _stage(conn, ev, 1, "会议开始", "Conference", offset_days=0)

    rec = _rec(conn, freq="yearly", starts_on=f"{year}-01-15", bymonth=1, bymonthday=15)
    ev = _event(conn, title_zh="国际象棋校际联赛", title_en="School Chess League",
                body_zh="按积分制进行，每周六下午两轮。",
                body_en="Round-robin league, two rounds every Saturday afternoon.",
                location_zh="图书馆活动区", location_en="Library Activity Area",
                subject_id="humanities", rec_id=rec,
                tags=[("humanities", 85), ("social", 15)])
    _stage(conn, ev, 0, "报名截止", "Registration Deadline", offset_days=-20)
    _stage(conn, ev, 1, "联赛开始", "League Starts", offset_days=0)

    # ---- 其他活动 ----
    rec = _rec(conn, freq="yearly", starts_on=f"{year}-04-10", bymonth=4, bymonthday=10)
    ev = _event(conn, title_zh="春季运动会", title_en="Spring Sports Day",
                body_zh="田赛、径赛与接力赛项目全部面向全校开放。",
                body_en="Track and field events open to all students.",
                location_zh="学校操场", location_en="School Field",
                subject_id="activity", rec_id=rec,
                tags=[("activity", 100)])
    _stage(conn, ev, 0, "报名截止", "Sign-up Closes", offset_days=-14)
    _stage(conn, ev, 1, "运动会", "Sports Day", offset_days=0)

    # ---- 公告 ----
    ts = now_iso()
    conn.execute(
        "INSERT INTO announcements(title_zh, title_en, body_zh, body_en, starts_on, "
        "show_on_calendar, version, created_at, updated_at) VALUES (?,?,?,?,?,?,1,?,?)",
        ("新学期社团招新开始啦", "New Semester Club Sign-ups Open",
         "本学期新增机器人社、模拟联合国社和商业策划社，扫码或到社团墙报名。",
         "Robotics, Model UN and Business Planning clubs are new this term.",
         date.today().isoformat(), 1, ts, ts),
    )
    conn.execute(
        "INSERT INTO announcements(title_zh, title_en, body_zh, body_en, starts_on, "
        "show_on_calendar, version, created_at, updated_at) VALUES (?,?,?,?,?,?,1,?,?)",
        ("SAT 考试报名通道已开放", "SAT Registration Is Open",
         "SAT 校内考次报名截止于本月底，之后不再接受补报。",
         "Register for the on-campus SAT by the end of the month.",
         date.today().isoformat(), 1, ts, ts),
    )
    conn.execute(
        "INSERT INTO announcements(title_zh, title_en, body_zh, body_en, starts_on, "
        "show_on_calendar, version, created_at, updated_at) VALUES (?,?,?,?,?,?,1,?,?)",
        ("图书馆延长开放时间", "Extended Library Hours",
         "备考季期间图书馆工作日开放至晚上十点。",
         "The library now stays open until 10 PM on weekdays during exam season.",
         date.today().isoformat(), 0, ts, ts),
    )
