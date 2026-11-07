"""循环展开与阶段日期的单元测试。

直接跑： ./.venv/bin/python -m backend.test_recurrence
"""
from __future__ import annotations

from datetime import date

from backend.recurrence import (
    FREQ_DAILY, FREQ_MONTHLY, FREQ_MONTHLY_LAST, FREQ_NONE, FREQ_WEEKLY,
    FREQ_YEARLY, FREQ_YEARLY_NTH, Recurrence, Stage, expand, occurrence_dates,
)

FAILED = []


def check(name, actual, expected):
    if actual != expected:
        FAILED.append(f"{name}\n     实际: {actual}\n     期望: {expected}")
        print(f"  ✗ {name}\n     实际: {actual}\n     期望: {expected}")
    else:
        print(f"  ✓ {name}")


def d(s):
    return date.fromisoformat(s)


# ---- 不重复 ----
rec = Recurrence(freq=FREQ_NONE, starts_on="2026-11-05")
check("不重复只出现一次", expand(rec, d("2026-01-01"), d("2026-12-31")), [d("2026-11-05")])
check("不重复不在区间外", expand(rec, d("2027-01-01"), d("2027-12-31")), [])

# ---- 每月 31 号：小月跳过，不钳到月末 ----
rec = Recurrence(freq=FREQ_MONTHLY, starts_on="2026-01-31", bymonthday=31)
got = expand(rec, d("2026-01-01"), d("2026-12-31"))
check(
    "每月 31 号跳过没有 31 号的月份",
    [x.isoformat() for x in got],
    ["2026-01-31", "2026-03-31", "2026-05-31", "2026-07-31",
     "2026-08-31", "2026-10-31", "2026-12-31"],
)
check("1/31 和 2/28 不撞在同一天", len(got) == len(set(got)), True)

# ---- 每月最后一天 ----
rec = Recurrence(freq=FREQ_MONTHLY_LAST, starts_on="2026-01-31")
got = expand(rec, d("2026-01-01"), d("2026-04-30"))
check("每月最后一天", [x.isoformat() for x in got],
      ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"])

# ---- 每年 2 月 29 日：平年跳过 ----
rec = Recurrence(freq=FREQ_YEARLY, starts_on="2024-02-29", bymonth=2, bymonthday=29)
got = expand(rec, d("2024-01-01"), d("2028-12-31"))
check("2/29 只在闰年出现", [x.isoformat() for x in got], ["2024-02-29", "2028-02-29"])

# ---- 每年第 N 个星期 X ----
# 2026 年 11 月第一个周六是 11/7；2027 年是 11/6
rec = Recurrence(freq=FREQ_YEARLY_NTH, starts_on="2026-11-07",
                 bymonth=11, bynth=1, byweekday=5)
got = expand(rec, d("2026-01-01"), d("2027-12-31"))
check("每年 11 月第一个周六", [x.isoformat() for x in got], ["2026-11-07", "2027-11-06"])

# 每年 5 月第一个周三：2026 是 5/6，2027 是 5/5
rec = Recurrence(freq=FREQ_YEARLY_NTH, starts_on="2026-05-06",
                 bymonth=5, bynth=1, byweekday=2)
got = expand(rec, d("2026-01-01"), d("2027-12-31"))
check("每年 5 月第一个周三", [x.isoformat() for x in got], ["2026-05-06", "2027-05-05"])

# 每年 5 月最后一个周三
rec = Recurrence(freq=FREQ_YEARLY_NTH, starts_on="2026-05-27",
                 bymonth=5, bynth=-1, byweekday=2)
got = expand(rec, d("2026-01-01"), d("2026-12-31"))
check("每年 5 月最后一个周三", [x.isoformat() for x in got], ["2026-05-27"])

# ---- 每周 ----
rec = Recurrence(freq=FREQ_WEEKLY, starts_on="2026-11-02", byweekday=0)  # 周一
got = expand(rec, d("2026-11-01"), d("2026-11-30"))
check("每周一", [x.isoformat() for x in got],
      ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30"])

# ---- 每天 + until 闭区间 ----
rec = Recurrence(freq=FREQ_DAILY, starts_on="2026-11-01", until_on="2026-11-05")
got = expand(rec, d("2026-11-01"), d("2026-11-30"))
check("每天 + until（闭区间）", [x.isoformat() for x in got],
      ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"])

# ---- max_count ----
rec = Recurrence(freq=FREQ_DAILY, starts_on="2026-11-01", max_count=3)
got = expand(rec, d("2026-11-01"), d("2026-11-30"))
check("max_count 限制次数", [x.isoformat() for x in got],
      ["2026-11-01", "2026-11-02", "2026-11-03"])

# ---- 阶段 offset：自动跟随活动年循环 ----
rec = Recurrence(freq=FREQ_YEARLY, starts_on="2027-05-10", bymonth=5, bymonthday=10)
stages = [
    Stage(id=1, seq=0, name_zh="报名截止", offset_days=-190),
    Stage(id=2, seq=1, name_zh="考试日", offset_days=0),
]
occ = occurrence_dates(rec, stages, d("2027-01-01"), d("2027-12-31"))
check("AP 阶段跟随年循环", [(o.isoformat(), [(s.name_zh, sd.isoformat()) for s, sd in st])
                    for o, st in occ],
      [("2027-05-10", [("报名截止", "2026-11-01"), ("考试日", "2027-05-10")]),
       ("2028-05-10", [("报名截止", "2027-11-02"), ("考试日", "2028-05-10")])])

# 2028 那场虽然本身在 2028 年，但它的「报名截止」落在 2027 年 11 月，
# 所以查 2027 年时也要能查出来 —— 窗口放大必须把结束侧也放宽。
occ = occurrence_dates(rec, stages, d("2027-01-01"), d("2027-12-31"))
check(
    "下一年考场的报名截止也能查到",
    [sd.isoformat() for _, st in occ for s, sd in st
     if s.name_zh == "报名截止" and sd.year == 2027],
    ["2027-11-02"],
)

# ---- 窗口放大：查询 11 月也能查到提前 190 天的报名截止 ----
occ = occurrence_dates(rec, stages, d("2026-11-01"), d("2026-11-30"))
check(
    "窗口放大能找到提前阶段",
    [(s.name_zh, sd.isoformat()) for _, st in occ for s, sd in st if s.name_zh == "报名截止"],
    [("报名截止", "2026-11-01")],
)

# ---- 偏移量计算 ----
occ = occurrence_dates(rec, stages, d("2026-11-01"), d("2026-11-30"))
check(
    "提前阶段的 chip 落在真正的日期上",
    sorted(sd.isoformat() for _, st in occ for _, sd in st),
    ["2026-11-01", "2027-05-10"],
)

# ---- 阶段 fixed_md 与 fixed_date ----
st = Stage(id=3, seq=0, name_zh="校内截止", date_mode="fixed_md", fixed_md="03-01")
check("fixed_md 用发生年份", st.resolve(d("2027-05-10")).isoformat(), "2027-03-01")
st = Stage(id=4, seq=0, name_zh="特批", date_mode="fixed_date", fixed_date="2027-01-15")
check("fixed_date 绝对日期", st.resolve(d("2027-05-10")).isoformat(), "2027-01-15")
st = Stage(id=5, seq=0, name_zh="闰日", date_mode="fixed_md", fixed_md="02-29")
check("fixed_md 平年退回 2/28", st.resolve(d("2027-05-10")).isoformat(), "2027-02-28")

print()
if FAILED:
    print(f"❌ {len(FAILED)} 个测试没通过")
    raise SystemExit(1)
print("✅ 全部通过")
