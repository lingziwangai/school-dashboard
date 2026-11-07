"""循环规则展开与阶段日期计算。

设计要点：
- 循环展开交给 python-dateutil 的 rrule，不手写，避免跨年/周起点算错。
- 阶段日期默认用 offset（相对活动当天的天数偏移），这样阶段自动跟随活动的年循环。
- 查询日历区间时要按阶段的最大负偏移放大查询窗口，否则「报名截止」这类提前阶段永远查不到。
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta

from dateutil.rrule import DAILY, MONTHLY, WEEKLY, YEARLY, MO, TU, WE, TH, FR, SA, SU, rrule

WEEKDAYS = [MO, TU, WE, TH, FR, SA, SU]
WEEKDAY_CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]
WEEKDAY_NAMES_ZH = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
WEEKDAY_NAMES_EN = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

FREQ_NONE = "none"
FREQ_DAILY = "daily"
FREQ_WEEKLY = "weekly"
FREQ_MONTHLY = "monthly"
FREQ_MONTHLY_LAST = "monthly_last"
FREQ_YEARLY = "yearly"
FREQ_YEARLY_NTH = "yearly_nth"

FREQ_LABELS = {
    FREQ_NONE: ("不重复", "Does not repeat"),
    FREQ_DAILY: ("每天", "Daily"),
    FREQ_WEEKLY: ("每周", "Weekly"),
    FREQ_MONTHLY: ("每月", "Monthly"),
    FREQ_MONTHLY_LAST: ("每月最后一天", "Last day of month"),
    FREQ_YEARLY: ("每年", "Yearly"),
    FREQ_YEARLY_NTH: ("每年第 N 个星期 X", "Nth weekday of a month, yearly"),
}


@dataclass
class Recurrence:
    freq: str = FREQ_NONE
    interval: int = 1
    starts_on: str = ""
    until_on: str | None = None
    max_count: int | None = None
    byweekday: int | None = None       # 0=周一 .. 6=周日
    bynth: int | None = None           # 1..5，-1=最后一个
    bymonth: int | None = None
    bymonthday: int | None = None

    @classmethod
    def from_row(cls, row) -> "Recurrence":
        return cls(
            freq=row["freq"],
            interval=row["interval"] or 1,
            starts_on=row["starts_on"],
            until_on=row["until_on"],
            max_count=row["max_count"],
            byweekday=row["byweekday"],
            bynth=row["bynth"],
            bymonth=row["bymonth"],
            bymonthday=row["bymonthday"],
        )


@dataclass
class Stage:
    id: int
    seq: int
    name_zh: str = ""
    name_en: str = ""
    date_mode: str = "offset"           # offset | fixed_md | fixed_date
    offset_days: int = 0
    fixed_md: str | None = None         # "MM-DD"
    fixed_date: str | None = None       # "YYYY-MM-DD"
    show_on_calendar: bool = True
    show_in_banner: bool = True
    color: str | None = None

    @classmethod
    def from_row(cls, row) -> "Stage":
        return cls(
            id=row["id"],
            seq=row["seq"],
            name_zh=row["name_zh"] or "",
            name_en=row["name_en"] or "",
            date_mode=row["date_mode"],
            offset_days=row["offset_days"] or 0,
            fixed_md=row["fixed_md"],
            fixed_date=row["fixed_date"],
            show_on_calendar=bool(row["show_on_calendar"]),
            show_in_banner=bool(row["show_in_banner"]),
            color=row["color"],
        )

    def resolve(self, occurrence: date) -> date | None:
        if self.date_mode == "offset":
            return occurrence + timedelta(days=self.offset_days)
        if self.date_mode == "fixed_md" and self.fixed_md:
            month, day = (int(x) for x in self.fixed_md.split("-"))
            year = occurrence.year
            try:
                return date(year, month, day)
            except ValueError:
                # 2 月 29 日遇到平年 -> 退到 2 月 28 日
                if month == 2 and day == 29:
                    return date(year, 2, 28)
                return None
        if self.date_mode == "fixed_date" and self.fixed_date:
            return date.fromisoformat(self.fixed_date)
        return None


def _build_rrule(rec: Recurrence):
    base = dict(
        dtstart=datetime.combine(date.fromisoformat(rec.starts_on), time.min),
        interval=max(1, rec.interval or 1),
        wkst=MO,
    )
    if rec.until_on:
        base["until"] = date.fromisoformat(rec.until_on)
    if rec.max_count:
        base["count"] = rec.max_count

    if rec.freq == FREQ_DAILY:
        return DAILY, base
    if rec.freq == FREQ_WEEKLY:
        base["byweekday"] = WEEKDAYS[(rec.byweekday or 0) % 7]
        return WEEKLY, base
    if rec.freq == FREQ_MONTHLY:
        base["bymonthday"] = rec.bymonthday or 1
        return MONTHLY, base
    if rec.freq == FREQ_MONTHLY_LAST:
        base["bymonthday"] = -1
        return MONTHLY, base
    if rec.freq == FREQ_YEARLY:
        base["bymonth"] = rec.bymonth if rec.bymonth else int(rec.starts_on[5:7])
        base["bymonthday"] = rec.bymonthday if rec.bymonthday else int(rec.starts_on[8:10])
        return YEARLY, base
    if rec.freq == FREQ_YEARLY_NTH:
        base["bymonth"] = rec.bymonth or 1
        weekday = WEEKDAYS[(rec.byweekday or 0) % 7]
        base["byweekday"] = weekday(rec.bynth or 1)
        return YEARLY, base
    return None, None


def expand(rec: Recurrence, start: date, end: date) -> list[date]:
    """展开 [start, end] 区间内该循环规则命中的所有日期（含端点）。"""
    if not rec.starts_on:
        return []
    if rec.freq == FREQ_NONE:
        try:
            d = date.fromisoformat(rec.starts_on)
        except ValueError:
            return []
        return [d] if start <= d <= end else []

    freq, base = _build_rrule(rec)
    if freq is None:
        return []
    try:
        rule = rrule(freq, **base)
    except (ValueError, TypeError):
        return []
    return [x.date() for x in rule.between(
        datetime.combine(start, time.min), datetime.combine(end, time.max), inc=True
    )]


def stage_window(stages: list[Stage]) -> tuple[int, int]:
    """返回 (最小偏移, 最大偏移)。偏移是相对活动当天的天数，通常为负。"""
    low = 0
    high = 0
    for st in stages:
        if st.date_mode == "offset":
            low = min(low, st.offset_days)
            high = max(high, st.offset_days)
    return low, high


def occurrence_dates(
    rec: Recurrence,
    stages: list[Stage],
    start: date,
    end: date,
) -> list[tuple[date, list[tuple[Stage, date]]]]:
    """返回 [(活动日期, [(阶段, 阶段日期), ...]), ...]。

    查询窗口会按阶段偏移自动放宽，保证「报名截止」这类提前阶段能被查到。
    阶段日期 = 活动日期 + 偏移，所以要让阶段落进 [start, end]，
    活动日期本身可能落在 [start - 最大偏移, end - 最小偏移] 里。
    """
    low, high = stage_window(stages)
    wide_start = start - timedelta(days=high)
    wide_end = end - timedelta(days=low)
    out = []
    for occ in expand(rec, wide_start, wide_end):
        resolved = []
        for st in stages:
            d = st.resolve(occ)
            if d is None:
                continue
            resolved.append((st, d))
        out.append((occ, resolved))
    return out


def describe(rec: Recurrence) -> str:
    """生成一句人类可读的循环说明（中文），显示在老师端表单下方。"""
    label = FREQ_LABELS.get(rec.freq, (rec.freq, rec.freq))[0]
    parts = [label]
    if rec.freq == FREQ_WEEKLY and rec.byweekday is not None:
        parts.append("的" + WEEKDAY_NAMES_ZH[rec.byweekday % 7])
    if rec.freq == FREQ_YEARLY_NTH:
        nth = rec.bynth or 1
        nth_txt = {1: "第一个", 2: "第二个", 3: "第三个", 4: "第四个", 5: "第五个", -1: "最后一个"}.get(nth, f"第 {nth} 个")
        wd = WEEKDAY_NAMES_ZH[(rec.byweekday or 0) % 7]
        month = rec.bymonth or 1
        parts.append(f"{month} 月{nth_txt}{wd}")
    if rec.freq == FREQ_MONTHLY and rec.bymonthday:
        parts.append(f"{rec.bymonthday} 号")
    if rec.freq == FREQ_YEARLY and rec.bymonth:
        parts.append(f"{rec.bymonth} 月 {rec.bymonthday or 1} 日")
    if rec.interval and rec.interval > 1 and rec.freq not in (FREQ_YEARLY, FREQ_YEARLY_NTH):
        parts.append(f"（每 {rec.interval} 次）")
    if rec.until_on:
        parts.append(f"，直到 {rec.until_on}")
    return "".join(parts)
