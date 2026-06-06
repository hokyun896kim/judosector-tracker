// 기기 간 동기화 — 동기화 코드(code)별로 JSON 묶음을 Netlify Blobs에 저장/조회.
// 로그인/가입 없이 PC·모바일에서 같은 code를 쓰면 같은 데이터를 공유한다.
//   GET  ?code=XXX            → 저장된 JSON 반환(없으면 {})
//   POST ?code=XXX  body=JSON → 저장
const { getStore } = require('@netlify/blobs');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// 코드 정규화: 영문/숫자/-/_ 만 허용, 4~128자
function keyFor(raw) {
  const c = String(raw || '').trim();
  if (c.length < 4) return null;
  const safe = c.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 128);
  return 'sync_' + safe;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors };

  const code = event.queryStringParameters && event.queryStringParameters.code;
  const key = keyFor(code);
  if (!key) return { statusCode: 400, headers: cors, body: '동기화 코드는 4자 이상이어야 합니다(영문·숫자·-·_).' };

  let store;
  try {
    store = getStore('judo-sync');
  } catch (e) {
    return { statusCode: 500, headers: cors, body: 'blob store init 실패: ' + e.message };
  }

  try {
    if (event.httpMethod === 'GET') {
      const data = await store.get(key, { type: 'text' });
      return {
        statusCode: 200,
        headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: data || '{}',
      };
    }
    if (event.httpMethod === 'POST') {
      const body = event.body || '{}';
      if (body.length > 4 * 1024 * 1024) return { statusCode: 413, headers: cors, body: '데이터가 너무 큽니다(4MB 초과).' };
      // 유효한 JSON인지만 가볍게 확인
      try { JSON.parse(body); } catch (e) { return { statusCode: 400, headers: cors, body: 'JSON 형식이 아닙니다.' }; }
      await store.set(key, body);
      return {
        statusCode: 200,
        headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true, at: Date.now() }),
      };
    }
    return { statusCode: 405, headers: cors, body: 'method not allowed' };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: 'sync error: ' + e.message };
  }
};
