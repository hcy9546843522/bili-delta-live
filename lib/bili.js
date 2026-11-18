'use strict';

/**
 * B 站直播接口封装（纯 HTTP，无 Cookie / 无浏览器 / 无签名）
 *
 * 只封装两个已验证无 gaia 风控的老接口：
 *   1. room/v1/area/getRoomList          —— 按分区翻页，发现房间
 *   2. room/v1/Room/get_status_info_by_uids —— 按 UID 批量查状态（含 live_time）
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const REFERER = 'https://live.bilibili.com/';

const AREA_LIST = 'https://api.live.bilibili.com/room/v1/area/getRoomList';
const STATUS_BY_UIDS = 'https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids';
const ROOM_INFO = 'https://api.live.bilibili.com/room/v1/Room/get_info';

/** 实测 200 个 UID 可用（URL ~3.8KB），400 个因 URL 过长失败。留足余量。 */
const BATCH_LIMIT = 150;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

async function requestJson(url, { timeout = 20000 } = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: REFERER,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    signal: AbortSignal.timeout(timeout),
  });

  if (res.status === 412 || res.status === 429) {
    const err = new Error(`HTTP ${res.status}（请求被限流）`);
    err.rateLimited = true;
    throw err;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // B 站被风控时会返回 HTML 验证页
    throw new Error(`返回内容不是 JSON（可能是风控页面）：${text.slice(0, 80)}`);
  }
  if (json.code !== 0) {
    // 带上 B 站自己的答复码：调用方需要区分「B 站明确说没有」和「网络压根没通」，
    // 两者对用户的意义完全不同（前者不用重试，后者值得重试）。
    const err = new Error(`接口返回 ${json.code}（${json.message || '未知'}）`);
    err.biliCode = json.code;
    err.biliMessage = json.message || '';
    throw err;
  }
  return json;
}

/**
 * 取某分区一页房间。page 从 1 开始，空数组代表翻到尽头。
 *
 * sortType 的两种取值有本质区别（均已实测）：
 *   online    —— 按人气排，discover 用它扫全分区。有效页数随人气分布变化，
 *                晚高峰能翻到 80 页以上，凌晨十几页就空。
 *   live_time —— 按开播时间倒序，**严格**单调（实测 45 对相邻项 0 违反）。
 *                第 1 页就是「最近几分钟刚开播的人」，radar 用它。
 *
 * pageSize 实测上限是 50：传 100 只会返回 20 条（参数被截断后按默认值走），
 * 所以 radar 固定用 50，别指望靠加大页容量减少请求数。
 *
 * 注意：榜单记录里**没有 live_time 字段**，只有 online 和房间基本信息。
 * 想知道某人几点开播必须再查 get_status_info_by_uids。这是 radar 需要
 * 两段式（先扫榜求交、再按 uid 补状态）的原因。
 */
async function fetchAreaPage({
  parentAreaId = 2,
  areaId = 878,
  page = 1,
  pageSize = 30,
  sortType = 'online',
}) {
  const sort = sortType === 'live_time' ? 'live_time' : 'online';
  const url =
    `${AREA_LIST}?parent_area_id=${parentAreaId}&area_id=${areaId}` +
    `&sort_type=${sort}&page=${page}&page_size=${pageSize}&platform=web`;
  const json = await requestJson(url);
  const list = Array.isArray(json.data) ? json.data : [];
  return list.map((r) => ({
    roomid: Number(r.roomid) || 0,
    uid: Number(r.uid) || 0,
    uname: r.uname || '',
    title: r.title || '',
    online: Number(r.online) || 0,
    area_id: Number(r.area_v2_id ?? r.area_id) || 0,
    area_name: r.area_v2_name || r.area_name || '',
    face: r.face || '',
  }));
}

/**
 * 批量查主播状态。
 * 返回 Map<uid, {live_status, live_time, online, uname, title, area_id, area_name, face}>
 *
 * 注意：不在播的主播也会返回，live_status=0、live_time=0。
 * 这正是出勤追踪能成立的前提。
 */
async function fetchStatusByUids(uids, { timeout = 25000 } = {}) {
  const out = new Map();
  const clean = [...new Set(uids.map(Number).filter((n) => n > 0))];

  for (let i = 0; i < clean.length; i += BATCH_LIMIT) {
    const chunk = clean.slice(i, i + BATCH_LIMIT);
    const qs = chunk.map((u) => `uids[]=${u}`).join('&');
    const json = await requestJson(`${STATUS_BY_UIDS}?${qs}`, { timeout });

    const data = json.data || {};
    for (const [uidStr, v] of Object.entries(data)) {
      out.set(Number(uidStr), {
        live_status: Number(v.live_status) || 0,
        live_time: Number(v.live_time) || 0,
        online: Number(v.online) || 0,
        uname: v.uname || '',
        title: v.title || '',
        area_id: Number(v.area_v2_id ?? v.area) || 0,
        area_name: v.area_v2_name || v.area_name || '',
        face: v.face || '',
        // 直播间地址必须用 room_id，不能用 uid：
        // https://live.bilibili.com/<uid> 对绝大多数主播是 404，
        // 只有 https://live.bilibili.com/<room_id> 才是真实直播间。
        roomid: Number(v.room_id) || 0,
        short_id: Number(v.short_id) || 0,
        // 直播封面。接口本来就返回，之前只是没取，所以补上它不需要额外请求：
        //   cover_from_user —— 主播自己设置的封面，构图稳定、不带播放器 UI
        //   keyframe        —— 当前画面的截图，更"实时"，但可能是黑屏或加载占位图
        // 优先用 cover_from_user，缺了再退回 keyframe。
        cover: v.cover_from_user || v.keyframe || '',
      });
    }
  }
  return out;
}

/**
 * 按直播间号查房间信息，用来把「直播间链接里的数字」换算成 uid。
 *
 * 为什么要它：用户粘贴的 https://live.bilibili.com/12345 里那个数字是 room_id，
 * 不是 uid。绝大多数主播两者不相等，直接当 uid 存进去会得到一个搜不到的幽灵记录。
 *
 * 注意这个接口的三个坑（都已实测确认）：
 *   1. 不返回 uname —— 昵称要另外调 get_status_info_by_uids 才拿得到
 *   2. live_time 是 "2026-11-16 01:23:45" 这种字符串，不是 unix 秒
 *   3. user_cover 是直播间封面图，不是主播头像，当 face 存会显示错图
 * 所以 face 一律留空，交给按 uid 查状态那一步补。
 */
async function fetchRoomInfo(roomId, { timeout = 20000 } = {}) {
  const json = await requestJson(`${ROOM_INFO}?room_id=${Number(roomId)}`, { timeout });
  const d = json.data || {};
  return {
    uid: Number(d.uid) || 0,
    roomid: Number(d.room_id) || 0,
    short_id: Number(d.short_id) || 0,
    uname: '',
    title: d.title || '',
    face: '',
    live_status: Number(d.live_status) || 0,
    live_time: parseLiveTimeString(d.live_time),
    online: Number(d.online) || 0,
    area_id: Number(d.area_id) || 0,
    area_name: d.area_name || '',
  };
}

/**
 * 把 get_info 里的 "2026-11-16 01:23:45" 转成 unix 秒。
 *
 * 未开播时该字段是 "0000-00-00 00:00:00"，必须返回 0 而不是一个离谱的时间戳，
 * 否则 recordLive 会给主播记下一场发生在公元 0 年的直播。
 */
function parseLiveTimeString(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return 0;
  const [, Y, Mo, D, H, Mi, S] = m.map(Number);
  if (!Y || !Mo || !D) return 0; // 0000-00-00 这种占位值
  // 该接口给的是东八区墙钟时间，减 8 小时才是 UTC
  const ms = Date.UTC(Y, Mo - 1, D, H, Mi, S) - 8 * 3600 * 1000;
  const sec = Math.floor(ms / 1000);
  return sec > 0 ? sec : 0;
}

module.exports = {
  BATCH_LIMIT,
  sleep,
  randomBetween,
  fetchAreaPage,
  fetchStatusByUids,
  fetchRoomInfo,
};