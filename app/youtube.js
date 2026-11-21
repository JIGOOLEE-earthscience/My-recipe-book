// 유튜브 관련 기능: 링크 → 영상 ID, YouTube Data API(정보·설명란·채널 주인 댓글), IFrame 플레이어 구간 재생.
// 시험 페이지와 실제 앱이 함께 씀.

const DATA_API = 'https://www.googleapis.com/youtube/v3';
const ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** 여러 형식의 유튜브 링크에서 영상 ID(11자)를 뽑음. 못 찾으면 null. */
export function parseVideoId(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (ID_RE.test(s)) return s;
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') {
    id = u.pathname.split('/')[1];
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.searchParams.get('v')) id = u.searchParams.get('v');
    else {
      const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([^/?#]+)/);
      if (m) id = m[2];
    }
  }
  return id && ID_RE.test(id) ? id : null;
}

export const watchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;
export const thumbUrl = (id, size = 'hqdefault') => `https://i.ytimg.com/vi/${id}/${size}.jpg`;
export const timeLink = (id, sec) => `https://youtu.be/${id}${sec ? `?t=${Math.floor(sec)}` : ''}`;

/** ISO 8601 길이(PT1H2M3S) → 초 */
export function parseDuration(iso) {
  const m = String(iso || '').match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const [, d, h, mi, s] = m.map((v) => Number(v || 0));
  return d * 86400 + h * 3600 + mi * 60 + s;
}

async function dataApi(path, params, key, signal) {
  const q = new URLSearchParams({ ...params, key });
  let res;
  try {
    res = await fetch(`${DATA_API}/${path}?${q}`, { signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw apiError('네트워크 오류 또는 브라우저 차단(CORS)', 0, 'network');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = body.error || {};
    const reason = err.errors?.[0]?.reason || err.status || '';
    throw apiError(err.message || `HTTP ${res.status}`, res.status, reason);
  }
  return body;
}

function apiError(message, status, reason) {
  const e = new Error(message);
  e.status = status;
  e.reason = reason;
  return e;
}

/** 영상 정보: 제목, 채널, 설명란, 길이 */
export async function fetchVideoInfo(id, key, signal) {
  const body = await dataApi('videos', { part: 'snippet,contentDetails,status', id }, key, signal);
  const v = body.items?.[0];
  if (!v) throw apiError('영상을 찾지 못했어요(삭제·비공개일 수 있음)', 404, 'notFound');
  return {
    title: v.snippet.title,
    channel: v.snippet.channelTitle,
    channelId: v.snippet.channelId,
    description: v.snippet.description || '',
    durationSec: parseDuration(v.contentDetails?.duration),
    privacy: v.status?.privacyStatus,
    embeddable: v.status?.embeddable,
  };
}

/** 채널 주인이 쓴 최상위 댓글(관련도 순 상위 20개 중 최대 max개) */
export async function fetchAuthorComments(id, channelId, key, { max = 2, signal } = {}) {
  const body = await dataApi(
    'commentThreads',
    { part: 'snippet', videoId: id, order: 'relevance', maxResults: '20', textFormat: 'plainText' },
    key,
    signal,
  );
  return (body.items || [])
    .map((t) => t.snippet?.topLevelComment?.snippet)
    .filter((c) => c && c.authorChannelId?.value === channelId)
    .slice(0, max)
    .map((c) => c.textDisplay || c.textOriginal || '');
}

// ---------- IFrame 플레이어 구간 재생 ----------

let apiPromise = null;
function loadIframeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve(window.YT);
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => {
      apiPromise = null;
      reject(new Error('유튜브 플레이어를 불러오지 못했어요'));
    };
    document.head.appendChild(s);
  });
  return apiPromise;
}

const PLAYER_ERRORS = {
  2: '잘못된 영상 ID',
  5: 'HTML5 플레이어 오류',
  100: '영상이 없거나 비공개',
  101: '영상 주인이 다른 사이트 재생을 막음',
  150: '영상 주인이 다른 사이트 재생을 막음',
  153: '페이지 주소 정보(referrer)가 없어 재생 거부',
};

/** el 자리에 플레이어를 만들고, play(start, end)로 구간 재생 */
export class SegmentPlayer {
  constructor(el, videoId, { onError } = {}) {
    this.timer = null;
    this.ready = loadIframeApi().then(
      (YT) =>
        new Promise((resolve) => {
          this.player = new YT.Player(el, {
            videoId,
            width: '100%',
            height: '100%',
            playerVars: { playsinline: 1, rel: 0 },
            events: {
              onReady: () => resolve(this.player),
              onError: (e) => onError?.(e.data, PLAYER_ERRORS[e.data] || `오류 ${e.data}`),
            },
          });
        }),
    );
  }

  async play(start, end = null) {
    const p = await this.ready;
    this.stopWatch();
    p.seekTo(Math.max(0, start || 0), true);
    p.playVideo();
    if (end != null && end > start) {
      this.timer = setInterval(() => {
        if (p.getCurrentTime() >= end) {
          p.pauseVideo();
          this.stopWatch();
        }
      }, 200);
    }
  }

  stopWatch() {
    clearInterval(this.timer);
    this.timer = null;
  }

  destroy() {
    this.stopWatch();
    this.player?.destroy?.();
  }
}
