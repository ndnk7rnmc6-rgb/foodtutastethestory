// Backend đánh giá dùng chung cho TẤT CẢ người dùng (Netlify Functions + Netlify Blobs).
// GET  /api/reviews  -> { reviews: [...] }   (ai cũng xem được)
// POST /api/reviews  -> { ok: true }         (gửi đánh giá mới)
// KHÔNG lưu ảnh: ảnh người dùng không bao giờ được gửi lên server.
import { createHash, randomBytes } from 'node:crypto';
import SEED from './reviews-seed.mjs';

const STOPS = 6;            // số điểm dừng (1..6)
const MAX_RETURN = 400;     // số đánh giá mới nhất trả về
const COOLDOWN_MS = 30000;
const TAGS = ['tasty', 'value', 'service', 'vibe', 'salty', 'pricey']; // thẻ "điều nổi bật" được phép  // 1 người chỉ gửi 1 đánh giá / điểm / 30 giây

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const clip = (v, n) =>
  String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, n);

export function makeHandler(getStore, seed = []) {
  return async (req, context = {}) => {
    const store = getStore();

    if (req.method === 'GET') {
      const { blobs } = await store.list({ prefix: 'r:' });
      const keys = blobs.map((b) => b.key).sort().reverse().slice(0, MAX_RETURN);
      const items = await Promise.all(keys.map((k) => store.get(k, { type: 'json' }).catch(() => null)));
      const all = items.filter(Boolean).concat(seed).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, MAX_RETURN);
      return json({ reviews: all });
    }

    if (req.method === 'POST') {
      const raw = await req.text();
      if (raw.length > 4096) return json({ ok: false, error: 'too_large' }, 413);
      let b;
      try { b = JSON.parse(raw); } catch { return json({ ok: false, error: 'bad_json' }, 400); }
      if (!b || typeof b !== 'object') return json({ ok: false, error: 'bad_body' }, 400);

      if (b.website) return json({ ok: true }); // bẫy bot: bỏ qua im lặng

      const stop = Math.round(Number(b.stop));
      const stars = Math.round(Number(b.stars));
      if (!(stop >= 1 && stop <= STOPS) || !(stars >= 1 && stars <= 5)) {
        return json({ ok: false, error: 'invalid' }, 400);
      }
      const tags = Array.isArray(b.tags) ? [...new Set(b.tags.filter((x) => TAGS.includes(x)))].slice(0, 3) : [];
      const key = 'r:' + String(Date.now()).padStart(13, '0') + '-' + randomBytes(4).toString('hex');
      const review = { id: key, stop, stars, name: clip(b.name, 40), text: clip(b.text, 300), at: new Date().toISOString() };
      if (tags.length) review.tags = tags;

      // giới hạn tần suất (IP được băm, không lưu IP thật)
      const ip = (context && context.ip) || req.headers.get('x-nf-client-connection-ip') || 'unknown';
      const rlKey = 'rl:' + createHash('sha256').update(ip + ':' + stop).digest('hex').slice(0, 24);
      const last = await store.get(rlKey, { type: 'json' }).catch(() => null);
      if (last && Date.now() - last.t < COOLDOWN_MS) return json({ ok: false, error: 'slow_down' }, 429);
      await store.setJSON(rlKey, { t: Date.now() });

      await store.setJSON(key, review);
      return json({ ok: true, review });
    }

    return json({ ok: false, error: 'method_not_allowed' }, 405);
  };
}

export default async (req, context) => {
  const { getStore } = await import('@netlify/blobs');
  return makeHandler(() => getStore({ name: 'reviews', consistency: 'strong' }), SEED)(req, context);
};

export const config = { path: '/api/reviews' };
