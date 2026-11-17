# bili-delta-live · 三角洲行动专区在播主播采集

采集 B 站直播「网游 → 三角洲行动」（`area_id=878`）当前正在直播的房间，输出主播昵称、标题、人气、房间号、UID，并提供一个本地网页看板做分析。

四个部分，按需取用：

| 部分 | 文件 | 环境要求 | 数量 |
| --- | --- | --- | --- |
| **纯 HTTP 采集（服务器用）** | `collect-http.js` | 只要 Node 18+，无任何依赖 | 全量 ~2000 个 |
| **主播出勤追踪（长期记录）** | `collect-track.js` + `lib/` | Node 22.5+（内置 sqlite） | 池 ~2000 个 |
| **网页看板（分析用）** | `web/` | 只要 Node 18+，无任何依赖 | — |
| 浏览器版采集（本机可选） | `collect.js` | Chrome + opencli 浏览器桥 + Cookie | 热门前 ~710 个 |

---

## 一、纯 HTTP 版采集（服务器用）

```bash
node collect-http.js                 # 全量采集
node collect-http.js --max-pages 3   # 只采前 3 页
node collect-http.js --delay 3000    # 每页间隔 3 秒
node collect-http.js --out ./data    # 输出目录
node collect-http.js --json          # stdout 只输出 JSON（便于管道/jq）
node collect-http.js --quiet         # 只写文件不打印表格
node collect-http.js --min-online 100  # 只保留人气 ≥ 100
```

**零依赖、无需 Cookie、无需浏览器**，Node 18+ 直接跑。

### 为什么它不需要过风控

它走的不是新版 `xlive/web-interface/v1/second/getList`，而是老版接口：

```
GET https://api.live.bilibili.com/room/v1/area/getRoomList
    ?parent_area_id=2&area_id=878&sort_type=online&page=N&page_size=30&platform=web
```

这个接口**没有 gaia 风控、不校验 `w_webid`、不需要 wbi 签名、不需要登录**。
实测翻到 74 页后返回空数组，即边界。

### 数量差异说明（重要）

同一个时间点：

- 老接口：**~2000 个**（含大量人气 ≤10 的极小房间）
- 网页版：**~710 个**（只包含热度较高的）

抽样用 `room/v1/Room/get_info` 逐个核实过：老接口独有的房间全部 `live_status=1`，**确实在播**。
所以差异不是脏数据，而是**网页版接口本身做了热度过滤**。

---

## 二、网页看板（本地分析用）

零依赖，Node 内置模块起一个只监听 `127.0.0.1` 的本地服务。

```bash
node web/serve.js              # 打开 http://127.0.0.1:7788
node web/serve.js --port 8080  # 换端口
```

启动后终端会列出识别到的数据源：

```
  三角洲行动 · 直播数据看板
  http://127.0.0.1:7788

  · data       709 条 / 人气 1,148,012         2 个快照  2026/11/15 15:19:37
  · data-http  2044 条 / 人气 1,471,404        3 个快照  2026/11/15 16:31:49
```

### 页面功能

| 区块 | 说明 |
| --- | --- |
| 概览卡 | 在播数、合计人气、人气中位数、最高人气、Top10 占比、≥100 房间数 |
| 人气 Top 20 | 横向条形图，前 3 名高亮，悬停看完整信息 |
| 人气分布 | 13 档对数式分桶的柱状图，悬停显示占比 |
| 历史趋势 | 来自 `snapshots/`，可切换「在播房间数 / 合计人气」 |
| 标题高频词 | 自动提取中文 2~4 字关键词，点词筛选，可切换按房间数 / 覆盖人气排序 |
| 房间明细 | 可排序表格，支持搜索、人气阈值、无限滚动加载、导出 CSV |

顶部可切换**数据源**（`data` / `data-http` 等）和**快照**（回看任意历史时点）。

### 数据源怎么被发现

服务会扫描项目根目录下所有匹配 `data*` 的文件夹，每个文件夹只要有 `latest.json` 就能看。
所以你可以：

```bash
node collect-http.js --out ./data          # 网页版口径
node collect-http.js --out ./data-full     # 想开几个就开几个
```

刷新页面即可在「数据源」下拉里看到。

### 安全说明

- 只监听 `127.0.0.1`，不对外网暴露。
- 所有路径参数都做了白名单校验（数据源名、快照文件名），拒绝 `..` 穿越。
- 前端无任何 CDN 依赖，完全离线可用。

---

## 三、浏览器版采集（本机，可选）

如果你需要与网页版「完全一致的口径」（即 B 站分区页面上显示的那些房间），用这个。

### 为什么要浏览器

新版接口 `second/getList` 有 gaia 风控，必须带网页 JS 现场生成的 `w_webid`（绑定浏览器指纹）。
纯 HTTP 直连（即使带登录 Cookie + wbi 签名）一律返回 `-352`。

程序做法：用 `opencli` 驱动本机真实 Chrome 打开分区页 → 取出 `w_webid` → Node 做 wbi 签名 → 请求在页面上下文发出。

### 前提

| 依赖 | 检查方式 |
| --- | --- |
| Chrome | — |
| opencli 浏览器桥 | `opencli doctor` 显示 `Extension: connected` |
| 登录 Cookie | `cookie.txt` 中存在 `SESSDATA=` |

`cookie.txt` 获取：Chrome 登录 <https://live.bilibili.com/> → `F12` → **Application** → Cookies → `https://live.bilibili.com` → 复制 `SESSDATA` 的值（HttpOnly，`document.cookie` 取不到），再拼上其余 Cookie 写成一行。

```bash
node collect.js                  # 全量
node collect.js --max-pages 2    # 前 2 页
node collect.js --keep-tab       # 采完保留标签页
node collect.js --include-others # 保留混入推荐位的其他分区房间（默认排除）
```

---

## 四、主播出勤追踪（长期记录）

`collect-http.js` 只是「此刻拍一张照」，不留历史。如果想回答「**某个主播哪天播了、播了多久**」，需要这一节。

### 思路

存**场次**，不存采样点。

B 站 `get_status_info_by_uids` 返回的 `live_time` 是这一场的开播时刻（Unix 秒），**同一场直播里它恒定不变**。所以：

- `live_time` 不变 → 还是同一场，只更新最后观测时间和峰值人气
- `live_time` 变了 → 主播下播重开，新建一场
- `live_status=0` → 收尾这场，时长 = 最后观测 − `live_time`

好处：**开播时刻精确到秒**，与采集频率无关；采集间隔只影响「结束时刻」的精度（每小时采一次，误差 ≤ 1 小时）。

### 用法

```bash
node collect-track.js --mode auto        # 首次：建池 + 记录（约 3 分钟）
node collect-track.js --mode track       # 日常：只刷新状态（约 20 秒）
node collect-track.js --mode discover    # 只扫新人，补进池子
node collect-track.js --import ./data-http/latest.json   # 复用已有结果建池，不发请求
node collect-track.js --mode track --dry-run             # 只看统计，不写库
```

常用参数：

| 参数 | 说明 |
| --- | --- |
| `--db FILE` | 数据库路径，默认 `./data/live.sqlite` |
| `--batch-delay MS` | 每批请求间隔，默认 1500 |
| `--delay MS` | discover 翻页间隔，默认 2000~3500 随机 |
| `--quiet` | 安静模式，只输出一行 JSON 汇总 |

### 请求量（重要）

这是能长期每小时跑的关键——**不需要每小时翻 75 页**：

| 模式 | 请求数 | 建议频率 |
| --- | --- | --- |
| `discover` | ~75 次（全量翻页） | 每天 1 次 |
| `track` | ~14 次（2092 人 ÷ 150/批） | 每小时 |

`get_status_info_by_uids` 实测 200 个 UID 可行，400 个因 URL 过长失败；代码取 **150** 留余量。

### 定时任务

```bash
crontab -e

# 每小时整点追踪一次
0 * * * * cd /opt/bili-live && /usr/bin/node collect-track.js --mode track --quiet >> /var/log/bili-track.log 2>&1

# 每天凌晨 3:30 扫一遍新人
30 3 * * * cd /opt/bili-live && /usr/bin/node collect-track.js --mode discover --quiet >> /var/log/bili-track.log 2>&1
```

一天 24 次 × 14 请求 + 1 次 discover ≈ **410 请求/天**，比每小时全量翻页（1800 请求/天）低得多。

### 数据库结构

`data/live.sqlite`（Node 内置 `node:sqlite`，无需安装任何东西）：

| 表 | 内容 |
| --- | --- |
| `streamers` | 主播池：`uid` / `uname` / `face` / `roomid` / 首次收录时间 |
| `sessions` | 场次：`uid` / `live_time` / `title` / 峰值人气 / 最后观测 / 是否结束 |
| `streamer_names` | 历史昵称：`uid` / `uname` / 该昵称的起止时间 |
| `collect_runs` | 每次采集的运行记录，便于排查漏采 |

`(uid, live_time)` 唯一约束，重复运行不会产生重复场次（已实测幂等）。

### 昵称与身份（重要）

**B 站允许用户随意改昵称，但 UID 终身不变。** 因此身份判定**只用 `uid`**，昵称仅用于显示和搜索：

- `streamers.uid` 是主键，改名不会新建一条主播记录
- `sessions` 的唯一键是 `UNIQUE(uid, live_time)`，与昵称无关
- 前端跳转、接口查询、场次归属全部走 `uid`
- 直播间链接用 `roomid`（不是 `uid`，用 uid 拼会 404）

改名带来的唯一实际问题是「用旧昵称搜不到人」。为此额外维护 `streamer_names` 表：

- 每次采集发现昵称变化时归档旧昵称，并记录这段昵称的使用时间
- 搜索同时匹配当前昵称与历史昵称，命中历史名时返回 `matched_alias`
- 老库升级时自动回填一次已有昵称（`meta` 表的 `names_backfilled` 标记，只跑一次）

实测：同一 `uid` 先后以「老名字」「新名字」入库，`streamers` 始终 1 行、场次不被拆成两条人，搜「老名字」仍能命中。

### 数据边界（务必了解）

只能记录**从开始追踪之后**的行为，之前的历史拿不到。另外：

- 主播如果在两次采集之间播完一场（< 1 小时），这一场会漏掉
- 时长误差 ≤ 采集间隔，因此「播了 3 小时」实际可能是 2~4 小时
- 只追踪在三角洲分区出现过的直播；主播去别的分区开播，这段时间记为未开播

### 手动执行与进度

不想等定时任务，随时可以手动跑一次。两种方式：

```bash
node collect-track.js --mode track        # 命令行直接跑
node collect-track.js --mode track --progress   # 每批输出一行进度（供程序解析）
```

`--progress` 会往 stdout 写形如下面这样的行，方便外部程序实时读取：

```
##PROGRESS## {"t":1794734349,"kind":"track","phase":"start","done":0,"total":18,"pool":2628,...}
##PROGRESS## {"t":1794734355,"kind":"track","phase":"batch","done":6,"total":18,"live":614,...}
##PROGRESS## {"t":1794734377,"kind":"track","phase":"done","done":18,"total":18,"live":1765,...}
```

不加 `--progress` 时只有最后那行 JSON 汇总，不会有多余输出。

**网页里点按钮更方便**：打开 <http://127.0.0.1:7788/schedule.html> 点「立即 track 一次」，
页面会实时显示进度条（当前批次 / 总批次 / 百分比）以及池大小、在播人数、新场次数，
跑完变成绿色并给出汇总。手动执行不受「自动采集开关」影响——开关关着也能点。

进度只存在内存里，**服务重启即清空**；它表示「此刻跑到哪」，不是历史数据。
历史运行记录在 `collect_runs` 表里，设置页的「上次 track」就是从那里读的。

---

## 五、输出

两个采集版本的输出格式一致：

| 文件 | 内容 |
| --- | --- |
| `data/latest.json` | 最新结果（含全部房间明细） |
| `data/latest.csv` | 最新结果（Excel 直接打开，带 BOM） |
| `data/snapshots/<时间>.json` | 每次运行的历史快照（看板趋势图的数据源） |
| `data/history.csv` | 汇总：时间 / 在播数 / 合计人气 / 页数 / 状态 |

字段：`roomid` `uid` `uname` `title` `area_name` `online` `url` `user_url` `cover`

---

## 六、服务器部署

两种方式任选其一，**不要同时启用**，否则请求量翻倍。

### 方式 A：1Panel 容器部署（推荐，本项目当前采用）

程序打包在 Node 官方镜像里跑，宿主机不需要装 Node，也不污染系统环境。

目录约定：

```
/opt/bili-delta-live/app/        ← 程序本体（挂载进容器 /app）
/opt/bili-delta-live/compose/    ← 编排文件
    docker-compose.yml
```

`docker-compose.yml` 全文：

```yaml
services:
  bili-delta-live:
    container_name: bili-delta-live
    image: node:24-alpine
    restart: unless-stopped
    # 解压后的文件属主是宿主机的 Windows UID，容器内 node 用户写不进数据库。
    # 用 root 运行最省事，数据目录只在本机内网，风险可控。
    user: "0:0"
    working_dir: /app
    # 必须传 --host 0.0.0.0：默认只监听 127.0.0.1，宿主机映射不进容器
    command: ["node", "web/serve.js", "--host", "0.0.0.0", "--port", "7788"]
    environment:
      - TZ=Asia/Shanghai
    volumes:
      - /opt/bili-delta-live/app:/app
    ports:
      - '7788:7788'
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:7788/api/attendance/stats"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
```

部署步骤：

```bash
# 1. 拉镜像（只需一次）
docker pull node:24-alpine

# 2. 拷程序到 app 目录（不含 data/ 则从零开始采）
rsync -av ./ user@server:/opt/bili-delta-live/app/

# 3. 起容器
cd /opt/bili-delta-live/compose
docker compose up -d

# 4. 看日志 / 健康状态
docker logs -f bili-delta-live
docker ps --filter name=bili-delta-live
```

`user: "0:0"` 和 `--host 0.0.0.0` 这两项是必须的，缺任一项容器都跑不起来：前者解决挂载目录的写权限，后者解决端口映射收不到流量。

启动日志会如实报告自动采集的状态：

```
  自动采集：未开启（如需自动跑，打开 /schedule.html 开启）
[调度] 已启动（每 30 秒检查一次是否到点）
```

开启后变成：

```
  自动采集：已开启（track 每 1 小时 / discover 每 23 小时）
  下次 track：2026/11/15 17:41:29　下次 discover：2026/11/16 06:43:52
```

> 如果日志出现「自动采集：无法启动 —— …」，说明数据库读不到，此时调度器会**跳过而不是瞎跑**，不会发出任何请求。

### 方式 B：宿主机直接跑 + crontab

```bash
# 1. 装 Node
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs
# 或 apt install nodejs（Debian/Ubuntu 自带 18+ 即可，需 22.5+ 才有 node:sqlite）

# 2. 拷程序
scp -r ./ user@server:/opt/bili-live/

# 3. 手动跑一次
cd /opt/bili-live && node collect-http.js

# 4. 每日定时
crontab -e
# 每天 9:00 采集，日志留档
0 9 * * * cd /opt/bili-live && /usr/bin/node collect-http.js --quiet >> /var/log/bili-live.log 2>&1
```

用 crontab 时请把网页里的自动采集开关**保持关闭**。

### 在服务器上看数据

容器起来后，内网直接访问：

```
http://<server-ip>:7788/                 ← 直播看板
http://<server-ip>:7788/attendance.html  ← 主播出勤
http://<server-ip>:7788/pool.html        ← 主播池（分层结构）
http://<server-ip>:7788/analyze.html     ← 数据分析
http://<server-ip>:7788/schedule.html    ← 自动采集设置
```

若只想在自己电脑上看，也可以把数据同步回本地：

```bash
rsync -av user@server:/opt/bili-delta-live/app/data/ ./data-server/
node web/serve.js        # 刷新页面，下拉里选 data-server
```

> 安全提醒：`--host 0.0.0.0` 会让服务监听所有网卡，仅限可信内网使用。
> 若服务器有公网 IP，请用防火墙只放行内网网段，或改回默认 `127.0.0.1` 走 SSH 隧道：
> `ssh -L 7788:127.0.0.1:7788 user@server`

---

## 七、风控说明

无论哪个版本：

- 每页随机等待，默认 2~3.5 秒（浏览器版 3~5 秒）。
- 单页失败按 2s / 4s / 8s 退避重试，最多 3 次。
- 连续 3 页失败即停止，已取到的数据照常落盘并标记 `partial`。
- 建议一天只跑 1~2 次。全量约 75 页、3 分钟。

看板只读本地文件，不发起任何对 B 站的请求，不影响风控。

---

## 八、接口备注

| 接口 | 风控 | 数量 | 用途 |
| --- | --- | --- | --- |
| `room/v1/area/getRoomList` | 无 | ~2000 | **服务器方案**、建主播池 |
| `room/v1/Room/get_status_info_by_uids` | 无 | 150/批 | **出勤追踪**（带 `live_time`） |
| `xlive/web-interface/v1/second/getList` | gaia（需 `w_webid`） | ~710 | 网页版口径 |
| `room/v1/Room/get_info?room_id=N` | 无 | 单个 | 核实单房间状态 |
| `room/v1/Room/getRoomBaseInfo` | 无 | 批量 | 按房间号批量查（需 `req_biz=web_room`） |
| `search/type?search_type=live` | 轻 | 受限 | 备用（易被限流，不推荐） |

- `getRoomList` 的翻页参数是 **`page`**（`page_no` 会被忽略，导致每页重复）。
- `getRoomList` 无 `live_status` 字段，接口只返回在播房间。
- 每页 30 条。**翻到空数组不能立即当作到底**：实测第 25 页可能偶发返空，紧接着第 26 页仍有 30 条，真实边界在第 80 页左右。脚本用「连续 3 页空/无新增」(`EMPTY_TOLERANCE`) 才认定结束 —— 早先一遇空页就 break，导致 2092 条只采到 707 条。
- `get_status_info_by_uids` 的 `uids[]` 参数**上限约 200**，400 个会因 URL 过长（~7.5KB）直接失败。
- `get_status_info_by_uids` 对未开播的主播也会返回，`live_status=0`、`live_time=0`——这是出勤追踪能判断「下播」的前提。
- `live_time` 是 **Unix 秒**（不是毫秒），同一场直播内恒定，可直接作为场次主键。