// Gemini API 호출(브라우저에서 REST 직접). 유튜브 링크를 영상으로 넣어 레시피 정리.
// 프롬프트는 prompts/레시피_정리_프롬프트.md에서 읽음.

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const START = '--- 프롬프트 시작 ---';
const END = '--- 프롬프트 끝 ---';
const PROMPT_VARS = ['source_list', 'title', 'duration', 'description', 'author_comments', 'memo'];

export const PROMPT_URL = new URL('../prompts/레시피_정리_프롬프트.md', import.meta.url).href;

async function call(path, { key, method = 'GET', body, signal }) {
  let res;
  try {
    res = await fetch(`${BASE}/${path}`, {
      method,
      signal,
      headers: { 'x-goog-api-key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    const err = new Error('네트워크 오류 또는 브라우저 차단(CORS)');
    err.reason = 'network';
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const info = (Array.isArray(data) ? data[0] : data)?.error || {};
    const err = new Error(info.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.reason = info.status || '';
    throw err;
  }
  return data;
}

/** generateContent를 쓸 수 있는 Gemini 모델 목록(최신 버전·상위 모델 먼저) */
export async function listModels(key, signal) {
  const data = await call('models?pageSize=1000', { key, signal });
  const skip = /embedding|tts|image|aqa|live|audio|robotics|computer-use|learnlm|gemma/i;
  const rank = (n) => (/pro/.test(n) ? 0 : /flash-lite/.test(n) ? 2 : /flash/.test(n) ? 1 : 3);
  const ver = (n) => Number((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
  return (data.models || [])
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name }))
    .filter((m) => m.id.startsWith('gemini') && !skip.test(m.id))
    .sort((a, b) => ver(b.id) - ver(a.id) || rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

/** 프롬프트 파일에서 시작~끝 표시 사이 글만 꺼냄 */
export async function loadPrompt(url = PROMPT_URL) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`프롬프트 파일을 못 읽었어요(HTTP ${res.status})`);
  // 표시는 줄 전체가 그 글자인 곳만 인정(설명 문장 속 표시는 무시)
  const lines = (await res.text()).replace(/\r\n?/g, '\n').split('\n');
  const a = lines.findIndex((l) => l.trim() === START);
  const b = lines.findIndex((l, i) => i > a && l.trim() === END);
  if (a < 0 || b < 0) throw new Error('프롬프트 파일에 시작·끝 표시가 없어요');
  return lines.slice(a + 1, b).join('\n').trim();
}

/** {변수} 자리 채우기. 정해진 변수만 바꿔서 JSON 예시의 중괄호는 건드리지 않음 */
export function fillPrompt(template, vars) {
  let out = template;
  for (const k of PROMPT_VARS) out = out.split(`{${k}}`).join(vars[k] ?? '');
  return out;
}

/** 자료 종류 문장 만들기 */
export function sourceList({ video = true, description, authorComments = 0, memo }) {
  const list = [];
  if (video) list.push('유튜브 영상(화면과 소리)');
  if (description) list.push('영상 설명란');
  if (authorComments) list.push(`채널 주인 댓글 ${authorComments}개`);
  if (memo) list.push('사용자 메모');
  return list.join(', ') || '사용자 메모';
}

/** 응답 글 → JSON. 코드 블록(```json)으로 감싸 와도 읽음 */
function parseJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error('JSON이 아님');
  }
}

/** 시각 → 초. 숫자(초), "분:초", "시:분:초" 모두 받음. 못 읽으면 null */
export function parseTime(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return isFinite(v) ? Math.max(0, Math.round(v)) : null;
  const t = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t));
  const m = t.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:\.\d+)?$/);
  if (!m) return null;
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}
const str = (v) => (v == null ? '' : String(v).trim());

const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/**
 * 형식 검사 + 정리. 큰 문제는 errors, 고칠 수 있는 건 고치고 warnings에 적음.
 * durationSec(영상 길이)을 알면 그보다 뒤인 시각은 있을 수 없으므로 비우고 unsure 표시.
 */
export function validateResult(obj, { durationSec = null } = {}) {
  const tooLate = (s) => durationSec != null && s != null && s > durationSec + 1;
  const errors = [];
  const warnings = [];
  const recipes = Array.isArray(obj?.recipes) ? obj.recipes : null;
  if (!recipes || !recipes.length) return { ok: false, errors: ['recipes가 비어 있음'], warnings, recipes: [] };
  const out = recipes.map((r, i) => {
    const name = `레시피 ${i + 1}`;
    if (!str(r.title)) errors.push(`${name}: 이름 없음`);
    if (!Array.isArray(r.ingredients)) errors.push(`${name}: ingredients 없음`);
    if (!Array.isArray(r.steps) || !r.steps.length) errors.push(`${name}: steps 없음`);
    const steps = (r.steps || []).map((s, k) => {
      let sec = parseTime(s.at ?? s.sec);
      let unsure = !!s.unsure;
      if (tooLate(sec)) {
        warnings.push(`${name} ${k + 1}단계: 시각 ${mmss(sec)}가 영상 길이 ${mmss(durationSec)}보다 뒤 → 비움`);
        sec = null;
        unsure = true;
      }
      return {
        text: str(s.text),
        sec,
        tip: str(s.tip),
        missing: Array.isArray(s.missing) ? s.missing.map(str).filter(Boolean) : [],
        unsure,
      };
    });
    let coverSec = parseTime(r.coverAt ?? r.coverSec);
    if (tooLate(coverSec)) {
      warnings.push(`${name}: 완성 장면 ${mmss(coverSec)}가 영상 길이보다 뒤 → 비움`);
      coverSec = null;
    }
    const secs = steps.map((s) => s.sec).filter((s) => s != null);
    if (secs.length < steps.length) warnings.push(`${name}: 시각 없는 단계 ${steps.length - secs.length}개`);
    if (secs.some((s, k) => k && s < secs[k - 1])) warnings.push(`${name}: 단계 시각이 거꾸로 된 곳 있음`);
    return {
      title: str(r.title),
      category: str(r.category) || '기타',
      summary: str(r.summary),
      servings: str(r.servings),
      time: str(r.time),
      tags: Array.isArray(r.tags) ? r.tags.map(str).filter(Boolean) : [],
      ingredients: (r.ingredients || []).map((g) => ({
        group: str(g.group) || '재료',
        name: str(g.name),
        amount: str(g.amount),
        unsure: !!g.unsure,
      })),
      steps,
      coverSec,
    };
  });
  return { ok: errors.length === 0, errors, warnings, recipes: out };
}

// 서버 과부하·일시 오류(503 등)는 잠깐 기다렸다 다시 요청. 대기 시간(초)
const BUSY_WAITS = [10, 30, 60];
const isBusy = (e) => [429, 500, 502, 503, 504].includes(e.status);

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('중단', 'AbortError'));
    }, { once: true });
  });
}

/**
 * 유튜브 영상 + 프롬프트로 정리 요청. 형식이 깨지면 1회 다시 요청.
 * 과부하(503 등)면 10·30·60초 기다렸다 다시 요청하고 onBusy(몇 번째, 대기 초, 오류 글)로 알림.
 * 돌려줌: { recipes, warnings, usage, finishReason, attempts, busyRetries, rawText, ms }
 */
export async function summarizeVideo({ key, model, videoUrl, prompt, mediaResolution, durationSec = null, signal, onBusy }) {
  const parts = [];
  if (videoUrl) parts.push({ fileData: { fileUri: videoUrl } });
  parts.push({ text: prompt });
  const generationConfig = { responseMimeType: 'application/json' };
  if (mediaResolution) generationConfig.mediaResolution = mediaResolution;
  const body = { contents: [{ role: 'user', parts }], generationConfig };

  const t0 = performance.now();
  const usages = [];
  let lastErr = null;
  let rawText = '';
  let finishReason = '';
  let busyRetries = 0;
  const request = async () => {
    for (;;) {
      try {
        return await call(`models/${encodeURIComponent(model)}:generateContent`, { key, method: 'POST', body, signal });
      } catch (e) {
        if (!isBusy(e) || busyRetries >= BUSY_WAITS.length) throw e;
        const wait = BUSY_WAITS[busyRetries++];
        onBusy?.(busyRetries, wait, e.message);
        await sleep(wait * 1000, signal);
      }
    }
  };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const data = await request();
    if (data.usageMetadata) usages.push(data.usageMetadata);
    const cand = data.candidates?.[0];
    finishReason = cand?.finishReason || data.promptFeedback?.blockReason || '';
    rawText = (cand?.content?.parts || []).filter((p) => !p.thought && p.text).map((p) => p.text).join('');
    if (!rawText) {
      lastErr = new Error(`빈 응답(${finishReason || '이유 모름'})`);
      continue;
    }
    try {
      const v = validateResult(parseJson(rawText), { durationSec });
      if (!v.ok) throw new Error(v.errors.join(', '));
      return { recipes: v.recipes, warnings: v.warnings, usage: sumUsage(usages), finishReason, attempts: attempt, busyRetries, rawText, ms: performance.now() - t0 };
    } catch (e) {
      lastErr = new Error(`형식 오류: ${e.message}`);
    }
  }
  lastErr.rawText = rawText;
  lastErr.usage = sumUsage(usages);
  throw lastErr;
}

/** 여러 번 요청했으면 토큰 합치기. 입력 토큰은 종류(영상·소리·글)별로도 */
function sumUsage(list) {
  const u = { input: 0, output: 0, thoughts: 0, total: 0, byModality: {} };
  for (const m of list) {
    u.input += m.promptTokenCount || 0;
    u.output += m.candidatesTokenCount || 0;
    u.thoughts += m.thoughtsTokenCount || 0;
    u.total += m.totalTokenCount || 0;
    for (const d of m.promptTokensDetails || []) u.byModality[d.modality] = (u.byModality[d.modality] || 0) + (d.tokenCount || 0);
  }
  return u;
}

// ---------- 백그라운드 실행(Interactions API) ----------
// 요청을 구글 서버에 맡기고 작업 번호(id)만 받아 둠. 휴대폰 화면이 꺼져 연결이 끊겨도
// 다시 켜졌을 때 id로 결과를 받아 올 수 있음. 저장된 작업은 유료 기준 55일 보관(문서).

/** 작업 맡기기. 과부하면 기다렸다 다시. 돌려줌: 작업 id */
export async function startInteraction({ key, model, videoUrl, prompt, lowRes, signal, onBusy }) {
  const input = [];
  if (videoUrl) input.push({ type: 'video', uri: videoUrl, ...(lowRes ? { resolution: 'low' } : {}) });
  input.push({ type: 'text', text: prompt });
  const body = { model, input, background: true };
  let busy = 0;
  for (;;) {
    try {
      const it = await call('interactions', { key, method: 'POST', body, signal });
      if (!it.id) throw new Error('작업 번호를 받지 못했어요');
      return { id: it.id, busyRetries: busy };
    } catch (e) {
      if (!isBusy(e) || busy >= BUSY_WAITS.length) throw e;
      const wait = BUSY_WAITS[busy++];
      onBusy?.(busy, wait, e.message);
      await sleep(wait * 1000, signal);
    }
  }
}

export const getInteraction = (key, id, signal) => call(`interactions/${encodeURIComponent(id)}`, { key, signal });

/** 화면이 다시 켜지면 기다리던 확인을 바로 하도록 깨우는 대기 */
function napUntilVisible(ms, signal) {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(t);
      document.removeEventListener('visibilitychange', onVis);
      resolve();
    };
    const onVis = () => document.visibilityState === 'visible' && done();
    const t = setTimeout(done, ms);
    document.addEventListener('visibilitychange', onVis);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      document.removeEventListener('visibilitychange', onVis);
      reject(new DOMException('중단', 'AbortError'));
    }, { once: true });
  });
}

/**
 * 작업이 끝날 때까지 몇 초마다 확인. 연결이 끊기면(화면 꺼짐 등) 포기하지 않고 계속 확인.
 * onTick({ status, offline, checks })로 진행 알림. 끝난 작업 객체를 돌려줌.
 */
export async function waitInteraction({ key, id, signal, onTick, interval = 4000 }) {
  let checks = 0;
  for (;;) {
    let it = null;
    try {
      it = await getInteraction(key, id, signal);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      if (e.reason !== 'network' && !isBusy(e)) throw e; // 키 오류·작업 없음 등은 바로 실패
      onTick?.({ status: 'offline', offline: true, checks });
    }
    if (it) {
      checks++;
      if (it.status !== 'in_progress') return it;
      onTick?.({ status: it.status, offline: false, checks });
    }
    await napUntilVisible(interval, signal);
  }
}

/** 끝난 작업에서 답 글 꺼내기 */
export function interactionText(it) {
  return (it.steps || [])
    .filter((st) => st.type === 'model_output')
    .flatMap((st) => st.content || [])
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text)
    .join('');
}

/** 작업의 토큰 기록 → generateContent와 같은 모양 */
export function interactionUsage(it) {
  const u = it.usage || {};
  const byModality = {};
  const add = (list) => {
    if (Array.isArray(list)) {
      for (const x of list) {
        const n = x.tokens ?? x.token_count ?? x.tokenCount ?? x.count ?? 0;
        if (x.modality) byModality[String(x.modality).toUpperCase()] = (byModality[String(x.modality).toUpperCase()] || 0) + n;
      }
    } else if (list && typeof list === 'object') {
      for (const [k, v] of Object.entries(list)) byModality[k.toUpperCase()] = (byModality[k.toUpperCase()] || 0) + (Number(v) || 0);
    }
  };
  add(u.input_tokens_by_modality);
  return {
    input: u.total_input_tokens || 0,
    output: u.total_output_tokens || 0,
    thoughts: u.total_thought_tokens || 0,
    total: u.total_tokens || 0,
    byModality,
  };
}

/** 끝난 작업 → 레시피 결과(형식 검사 포함). 형식이 깨졌으면 오류 */
export function readInteraction(it, { durationSec = null } = {}) {
  if (it.status !== 'completed') {
    const e = new Error(`작업이 끝나지 못했어요(${it.status}${it.error?.message ? `: ${it.error.message}` : ''})`);
    e.status = it.status;
    throw e;
  }
  const rawText = interactionText(it);
  const usage = interactionUsage(it);
  if (!rawText) {
    const e = new Error('빈 응답');
    e.usage = usage;
    throw e;
  }
  let v;
  try {
    v = validateResult(parseJson(rawText), { durationSec });
  } catch (err) {
    v = { ok: false, errors: [err.message] };
  }
  if (!v.ok) {
    const e = new Error(`형식 오류: ${v.errors.join(', ')}`);
    e.rawText = rawText;
    e.usage = usage;
    e.formatError = true;
    throw e;
  }
  return { recipes: v.recipes, warnings: v.warnings, usage, rawText, finishReason: it.status };
}
