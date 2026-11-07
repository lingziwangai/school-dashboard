# 国际生竞赛日历布告板

给机器人用的活动布告板。给国际生看的竞赛/考试日历 + 校园公告 + AI 问答小狼。

- **屏幕端**（`display.html`）：给 HDMI 屏显示。平时是日历，随时可问 AI。
- **老师端**（`admin.html`）：老师在浏览器里加竞赛、发公告、改设置，改完自动同步到屏幕。

> 这个仓库是**网页端（大脑）**。树莓派那边只需要一个全屏浏览器和几行脚本，**不用**装这个仓库里的东西。
> 树莓派怎么装 → 看 `robot-board-pi/README-PI.md`。

---

## 一、部署到 Render（云端）

### 传 GitHub

这个文件夹里的**全部文件**传上去就行（`.venv`、`data/` 已经被 `.gitignore` 排除）。

```bash
cd ~/Desktop/weeee/robot-board-web
git init
git add .
git commit -m "学校活动布告板"
```

到 github.com 新建一个仓库（**不要**勾 "Add a README"），然后：

```bash
git remote add origin https://github.com/你的用户名/你的仓库名.git
git push -u origin main
```

### 在 Render 上建服务

Render 控制台 → **New** → **Blueprint** → 选你刚传的仓库 → Apply。

它会自动读 `render.yaml`。也可以手动建（New → Web Service），填：

| 填什么 | 值 |
|---|---|
| Build Command | `pip install -r requirements.txt` |
| Start Command | `uvicorn backend.main:app --host 0.0.0.0 --port $PORT` |
| Health Check Path | `/display.html` |
| Environment | `PYTHON_VERSION` = `3.12.8` |

建完一两分钟就能访问 `https://xxx.onrender.com/display.html`。

### 免费版要注意的两件事

**（1）数据会重置。** 免费版的硬盘是临时的，**每次重新部署或重启，数据库会回到示例数据**。老师新发的公告会丢。

想保住数据，两个办法：
- 在 Render 升到 **Starter**（$7/月），给服务挂一块**持久磁盘**（Disk → Add → 挂到 `/opt/render/project/src/data`），`.gitignore` 和 `render.yaml` 已经按这个路径配好了
- 或者先在本地把 `data/board.db` 里的东西导出备份

**（2）AI 小狼会显示「未连接」。** Render 上没有本地 Ollama。要用 AI，就在老师端「设置」里把 Ollama 地址改成一台**能被公网访问的** Ollama 服务器。不配也不影响其他功能。

### 上线第一件事

老师端 → 设置 → 把默认密码 `admin` 改掉。

---

## 二、本地开发

想在本地改代码、跑起来看效果：

```bash
cd ~/Desktop/weeee/robot-board-web
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
./.venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

然后开 http://127.0.0.1:8000/display.html 。按 `Control + C` 停。

---

## 三、打开网站

部署好之后，在**浏览器**（Chrome / Safari 都行）地址栏输入（把 `xxx` 换成 Render 给你的地址）：

| 页面 | 地址 | 谁用 |
|---|---|---|
| 屏幕端 | https://xxx.onrender.com/display.html | 给树莓派上的 HDMI 屏看 |
| 老师端 | https://xxx.onrender.com/admin.html | 老师改内容用 |
| API 文档 | https://xxx.onrender.com/api/docs | 想看有哪些接口 |

**老师端初始密码：`admin`**

登录后请到「设置」页改掉密码（填两遍新密码 → 保存）。

---

## 四、老师端能干什么

三个标签页：

### 竞赛与考试
- **新建活动**：中英标题、正文、地点、分类、封面图、循环规则、阶段、兴趣人群标签
- **分类配色**：文科紫 / 理科蓝 / 工科绿 / 商科橙 / 社科粉 / AP 考试金
- **循环规则**：不重复 / 每天 / 每周 / 每月几号 / 每月最后一天 / 每年几月几号 / 每年第 N 个星期几
- **阶段**（AP 考试要用）：一个活动可以拆成「报名截止」「交作品」「正式考试」等多个日期。用「相对天数」填，比如报名截止填 `-60` 天，正式考试填 `0` —— 以后改年份，这些日期会自己跟着走
- **兴趣人群标签**：拖分割线调比例，比如理科 70% / 工科 30%，日历上就显示成一条双色条
- 改完点「保存」，屏幕端 **8 秒内**自动更新

### 活动与照片
- 发公告：标题、正文、照片、发布日期、截止日期
- **截止日期**：填了之后，过了这天公告会变成灰色留在屏幕上（点开照样能看内容），不会被撤下。老师端仍然看得到，方便回溯
- 可以勾选「同时显示在日历上」，这样公告也会出现在日历格子里

### 设置
- 改密码
- 改 AI 模型名、Ollama 地址、上下文长度
- 改学校中英文名字
- 改学年起始月份（默认 8 月 1 日）

---

## 五、屏幕端

- **最上面一条**：校园公告横幅，整条横着滚。除了老师的公告，还会滚过老师勾了「在公告栏显示」的到期节点，右上角写明还有几项要到期
- 顶栏：实时日期时间、学校名、`日 / 周 / 月 / 学年` 切换、`白天 / 黑夜` 切换、`中 / EN` 切换、狼头头像
- 左边：月历格子，活动按分类色显示。点某天 → 右侧滑出详情（阶段时间线、标签比例条、倒计时、封面图）
- 日历上方一条**「即将到来」**：最近要到期的东西，一眼看到还有几天。点一下直接跳到那天
- 右下：小狼 AI 助手

**几个用起来顺手的设计：**

| 功能 | 怎么用 |
|---|---|
| 白天 / 黑夜 | 顶栏的太阳/月亮图标。选一次就记住了，下次打开还是这个模式 |
| 日 / 周 / 月 / 学年 | 顶栏切换。切到**日**或**周**会自动全屏，把右边的面板收起来，日历占满整个屏幕；切回**月**或**学年**面板又回来 |
| 收起侧边面板 | 顶栏的 [▤] 面板图标，屏幕再宽一点给日历。状态会记住 |
| 折叠 AI 聊天记录 | AI 面板标题右边的箭头，只留标题和输入框，聊天记录收起来 |
| 过期不消失 | 过了日期的活动、公告会变成**灰色**留在屏幕上，点开还能看到完整内容，不会被悄悄撤走 |

**屏幕端不需要登录**，老师改完自动同步过来。

---

## 六、AI 小狼（可选）

AI 用的是本地 Ollama，**不花钱、也不联网**。

1. 装 Ollama：https://ollama.com/download
2. 拉一个模型（推荐中文好的小模型）：
   ```bash
   ollama pull qwen2.5:1.5b-instruct
   ```
3. 老师端「设置」页确认 Ollama 地址是 `http://127.0.0.1:11434`

**Ollama 没装或没开也没关系** —— AI 面板会显示「暂不可用」，日历和公告照常工作。

---

## 七、目录结构

```
robot-board-web/
├── requirements.txt    依赖清单
├── render.yaml         Render 部署配置
├── .gitignore
├── README.md           本文件
├── backend/
│   ├── main.py         FastAPI 路由（所有接口）
│   ├── db.py           建表、连接、密码加密
│   ├── recurrence.py   循环规则展开（日期算法核心）
│   ├── ai.py           Ollama 对接 + 上下文注入
│   ├── uploads.py      图片压缩 + 去 EXIF（学校照片带 GPS，要剥掉）
│   ├── seed.py         示例数据
│   └── test_recurrence.py  循环规则自测
└── web/
    ├── display.html    屏幕端
    ├── admin.html      老师端
    ├── favicon.svg
    ├── css/            base / display / admin
    └── js/             api store i18n theme wolf tagbar display admin
```

运行时还会自动生成一个 `data/` 文件夹（数据库 + 上传的照片），**不会提交到 git**。

**备份 = 把 Render 上的 `data/` 拷下来，或者直接备份 `board.db`。**

---

## 八、常见问题

**页面打不开 / 显示「无法连接」**
Render 的服务没起来。看 Render 控制台 → 你的服务 → Logs 找报错。免费版服务空闲 15 分钟会休眠，第一次打开会慢几十秒。

**改了没生效**
老师端改完会立刻存。屏幕端每 8 秒同步一次，等一会儿。手动刷一下屏幕端页面也行。

**免费版重启后内容没了**
正常，硬盘是临时的。解决办法见第一节「免费版要注意的两件事」。

**要重来一遍（清空所有数据）**
Render 控制台 → 你的服务 → 菜单 → Restart，或者直接重新部署一次，会回到示例数据。

**跑自测（确认日期算法没问题）**
```bash
python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt
./.venv/bin/python -m backend.test_recurrence
```

---

## 九、树莓派那边

树莓派**不用装这个仓库里的任何东西**。它只需要一个全屏浏览器打开 Render 的网址。

步骤、脚本、常见问题都在另一个文件夹 `robot-board-pi/README-PI.md` 里。

---

## 十、密码

- 初始：`admin`
- 改法：老师端 → 设置 → 输两遍新密码 → 保存
- 忘了密码：在 Render 上把数据库删掉重来（会丢数据），或者直接改数据库里的 `settings` 表 `admin_password_hash` 字段
- 连续输错 10 次会锁 10 分钟（防止有人乱试密码）
