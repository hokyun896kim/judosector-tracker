// 기기 간 동기화 — 동기화 코드(code)별로 JSON 묶음을 Netlify Blobs에 저장/조회.
// 로그인/가입 없이 PC·모바일에서 같은 code를 쓰면 같은 데이터를 공유한다.
//   GET  ?code=XXX            → 저장된 JSON 반환(없으면 {})
//   POST ?code=XXX  body=JSON → 저장
// ※ Netlify Functions v2(ESM) 형식 — Blobs가 런타임에서 자동 구성됨.
import { getStore } from '@netlify/blobs';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// 코드 정규화: 영문/숫자/-/_ 만 허용, 4~128자
function keyFor(raw) {
  const c = String(raw || '').trim();
  if (c.length < 4) return null;
  return 'sync_' + c.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 128);
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const url = new URL(req.url);
  const key = keyFor(url.searchParams.get('code'));
  if (!key) {
    return new Response('동기화 코드는 4자 이상이어야 합니다(영문·숫자·-·_).', { status: 400, headers: cors });
  }

  let store;
  try {
    store = getStore('judo-sync');
  } catch (e) {
    return new Response('blob store init 실패: ' + e.message, { status: 500, headers: cors });
  }

  try {
    if (req.method === 'GET') {
      const data = await store.get(key, { type: 'text' });
      return new Response(data || '{}', {
        status: 200,
        headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    if (req.method === 'POST') {
      const body = await req.text();
      if (body.length > 4 * 1024 * 1024) {
        return new Response('데이터가 너무 큽니다(4MB 초과).', { status: 413, headers: cors });
      }
      try { JSON.parse(body); } catch (e) {
        return new Response('JSON 형식이 아닙니다.', { status: 400, headers: cors });
      }
      await store.set(key, body);
      return new Response(JSON.stringify({ ok: true, at: Date.now() }), {
        status: 200,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    return new Response('method not allowed', { status: 405, headers: cors });
  } catch (e) {
    return new Response('sync error: ' + e.message, { status: 500, headers: cors });
  }
};
