// KitchenAid Messenger Worker
// Environment variables (ตั้งใน Cloudflare Dashboard → Workers → Settings → Variables):
//   PAGE_ACCESS_TOKEN  — Facebook Page Access Token
//   VERIFY_TOKEN       — คำลับสำหรับยืนยัน webhook (ตั้งเองได้เลย เช่น "kitchenaid2025")
//   API_KEY            — รหัสสำหรับให้หน้า inbox เรียก API (ตั้งเองได้เลย)
// KV Namespace binding ชื่อ "KV" (สร้างใน KV → ผูกกับ Worker ชื่อ "KV")

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // Facebook webhook verification
    if (request.method === 'GET' && url.pathname === '/webhook') {
      const mode      = url.searchParams.get('hub.mode');
      const token     = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');
      if (mode === 'subscribe' && token === env.VERIFY_TOKEN) {
        return new Response(challenge, { status: 200 });
      }
      return new Response('Forbidden', { status: 403 });
    }

    // Facebook webhook — receive messages
    if (request.method === 'POST' && url.pathname === '/webhook') {
      const body = await request.json().catch(() => ({}));
      if (body.object === 'page') {
        for (const entry of (body.entry || [])) {
          for (const event of (entry.messaging || [])) {
            if (event.message && !event.message.is_echo) {
              await saveMessage(env, {
                senderId: event.sender.id,
                text: event.message.text || '[สื่อ/ไฟล์แนบ]',
                timestamp: event.timestamp,
                from: 'customer',
              });
            }
          }
        }
      }
      return new Response('EVENT_RECEIVED', { status: 200 });
    }

    // ---- API endpoints — ต้องใส่ X-API-Key header ----
    if (!checkApiKey(request, env)) {
      return json({ error: 'Unauthorized' }, 401);
    }

    // GET /conversations
    if (request.method === 'GET' && url.pathname === '/conversations') {
      const data = await env.KV.get('conversations', 'json') || [];
      return json(data);
    }

    // GET /messages/:senderId
    if (request.method === 'GET' && url.pathname.startsWith('/messages/')) {
      const senderId = url.pathname.split('/')[2];
      const msgs = await env.KV.get(`msg_${senderId}`, 'json') || [];
      // mark read
      const convs = await env.KV.get('conversations', 'json') || [];
      const ci = convs.findIndex(c => c.senderId === senderId);
      if (ci >= 0 && convs[ci].unread > 0) {
        convs[ci].unread = 0;
        await env.KV.put('conversations', JSON.stringify(convs));
      }
      return json(msgs);
    }

    // POST /reply  { senderId, text }
    if (request.method === 'POST' && url.pathname === '/reply') {
      const { senderId, text } = await request.json();
      if (!senderId || !text) return json({ error: 'missing senderId or text' }, 400);

      const res = await fetch(
        `https://graph.facebook.com/v19.0/me/messages?access_token=${env.PAGE_ACCESS_TOKEN}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recipient: { id: senderId }, message: { text } }),
        }
      );

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return json({ ok: false, error: err }, 500);
      }

      await saveMessage(env, { senderId, text, timestamp: Date.now(), from: 'shop' });
      return json({ ok: true });
    }

    // DELETE /conversations/:senderId
    if (request.method === 'DELETE' && url.pathname.startsWith('/conversations/')) {
      const senderId = url.pathname.split('/')[2];
      await env.KV.delete(`msg_${senderId}`);
      const convs = (await env.KV.get('conversations', 'json') || []).filter(c => c.senderId !== senderId);
      await env.KV.put('conversations', JSON.stringify(convs));
      return json({ ok: true });
    }

    // POST /image?partId=xxx&ext=jpg  body=binary  → upload to R2, return {key, url}
    if (request.method === 'POST' && url.pathname === '/image') {
      const partId = (url.searchParams.get('partId') || '').replace(/[^a-z0-9-]/gi, '').slice(0, 40);
      if (!partId) return json({ error: 'missing partId' }, 400);
      const ext = (url.searchParams.get('ext') || 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'jpg';
      const buf = await request.arrayBuffer();
      if (buf.byteLength === 0) return json({ error: 'empty body' }, 400);
      if (buf.byteLength > 2 * 1024 * 1024) return json({ error: 'too large (max 2MB)' }, 400);
      const uuid = crypto.randomUUID();
      const key = `parts/${partId}/${uuid}.${ext}`;
      const contentType = request.headers.get('Content-Type') || 'image/jpeg';
      await env.IMAGES.put(key, buf, { httpMetadata: { contentType } });
      return json({ ok: true, key, url: `${env.R2_PUBLIC_URL}/${key}` });
    }

    // DELETE /image?key=parts/xxx/yyy.jpg
    if (request.method === 'DELETE' && url.pathname === '/image') {
      const key = url.searchParams.get('key') || '';
      if (!key.startsWith('parts/')) return json({ error: 'invalid key' }, 400);
      await env.IMAGES.delete(key);
      return json({ ok: true });
    }

    // POST /stock  { parts: [...] }  — browser syncs stock snapshot to KV
    if (request.method === 'POST' && url.pathname === '/stock') {
      const { parts } = await request.json().catch(() => ({}));
      if (!Array.isArray(parts)) return json({ error: 'parts must be array' }, 400);
      await env.KV.put('stock_parts', JSON.stringify(parts));
      return json({ ok: true });
    }

    // GET /stock/low — items that are out of stock (always) OR at/below minStock (if minStock > 0)
    if (request.method === 'GET' && url.pathname === '/stock/low') {
      const parts = await env.KV.get('stock_parts', 'json') || [];
      const low = parts.filter(p => {
        const s = p.stock || 0, m = p.minStock || 0;
        return s === 0 || (m > 0 && s <= m);
      });
      return json(low);
    }

    // POST /migrate — ONE-TIME migration: combine 7 legacy keys → single `biz_all` key.
    // Reads the 7 original keys, writes them into `biz_all`. Does NOT delete the old
    // keys (kept as backup until verified). Safe to run multiple times (idempotent).
    // Run:  curl -X POST -H "X-API-Key: <API_KEY>" https://<worker>/migrate
    if (request.method === 'POST' && url.pathname === '/migrate') {
      const [quotations, invoices, repairs, parts, settings, sequences, lastModified] = await Promise.all([
        env.KV.get('biz_quotations',   'json'),
        env.KV.get('biz_invoices',     'json'),
        env.KV.get('biz_repairs',      'json'),
        env.KV.get('biz_parts',        'json'),
        env.KV.get('biz_settings',     'json'),
        env.KV.get('biz_sequences',    'json'),
        env.KV.get('biz_lastModified'),
      ]);
      const merged = {
        quotations:   quotations || [],
        invoices:     invoices   || [],
        repairs:      repairs    || [],
        parts:        parts      || [],
        settings:     settings   || {},
        sequences:    sequences  || {},
        lastModified: lastModified ? Number(lastModified) : Date.now(),
      };
      await env.KV.put('biz_all', JSON.stringify(merged));
      return json({
        ok: true,
        migrated: true,
        counts: {
          quotations: merged.quotations.length,
          invoices:   merged.invoices.length,
          repairs:    merged.repairs.length,
          parts:      merged.parts.length,
        },
        lastModified: merged.lastModified,
      });
    }

    // GET /export — all business data
    if (request.method === 'GET' && url.pathname === '/export') {
      const all = await readBizAll(env);
      return json({
        quotations:   all.quotations || [],
        invoices:     all.invoices   || [],
        repairs:      all.repairs    || [],
        parts:        all.parts      || [],
        settings:     all.settings   || {},
        sequences:    all.sequences  || {},
        lastModified: all.lastModified ? Number(all.lastModified) : 0,
      });
    }

    // POST /import — save all business data
    // Optional conflict detection: client may send `_lastModified` (timestamp from previous /export).
    // If KV has been updated since then, return 409 with current server state instead of overwriting.
    if (request.method === 'POST' && url.pathname === '/import') {
      const body = await request.json().catch(() => ({}));
      const clientLastModified = body._lastModified;

      // Read current combined state once (handles biz_all + legacy fallback).
      const current = await readBizAll(env);

      if (clientLastModified !== undefined) {
        const serverLastModified = current.lastModified ? Number(current.lastModified) : 0;
        if (serverLastModified > Number(clientLastModified)) {
          return json({
            ok: false,
            conflict: true,
            serverLastModified,
            clientLastModified: Number(clientLastModified),
            currentData: {
              quotations: current.quotations || [],
              invoices:   current.invoices   || [],
              repairs:    current.repairs    || [],
              parts:      current.parts      || [],
              settings:   current.settings   || {},
              sequences:  current.sequences  || {},
            },
          }, 409);
        }
      }

      // Merge incoming fields onto current state, then write ONE key (biz_all).
      const newLastModified = Date.now();
      const merged = {
        quotations:   body.quotations !== undefined ? body.quotations : (current.quotations || []),
        invoices:     body.invoices   !== undefined ? body.invoices   : (current.invoices   || []),
        repairs:      body.repairs    !== undefined ? body.repairs    : (current.repairs    || []),
        parts:        body.parts      !== undefined ? body.parts      : (current.parts      || []),
        settings:     body.settings   !== undefined ? body.settings   : (current.settings   || {}),
        sequences:    body.sequences  !== undefined ? body.sequences  : (current.sequences  || {}),
        lastModified: newLastModified,
      };
      await env.KV.put('biz_all', JSON.stringify(merged));
      return json({ ok: true, lastModified: newLastModified });
    }

    return new Response('Not Found', { status: 404 });
  },
};

// Read combined business data.
// Prefers the single `biz_all` key; falls back to the 7 legacy keys if `biz_all`
// does not exist yet (pre-migration), so no data is lost during rollout.
async function readBizAll(env) {
  const all = await env.KV.get('biz_all', 'json');
  if (all) return all;

  // Legacy fallback — read the 7 original keys.
  const [quotations, invoices, repairs, parts, settings, sequences, lastModified] = await Promise.all([
    env.KV.get('biz_quotations',   'json'),
    env.KV.get('biz_invoices',     'json'),
    env.KV.get('biz_repairs',      'json'),
    env.KV.get('biz_parts',        'json'),
    env.KV.get('biz_settings',     'json'),
    env.KV.get('biz_sequences',    'json'),
    env.KV.get('biz_lastModified'),
  ]);
  return {
    quotations:   quotations || [],
    invoices:     invoices   || [],
    repairs:      repairs    || [],
    parts:        parts      || [],
    settings:     settings   || {},
    sequences:    sequences  || {},
    lastModified: lastModified ? Number(lastModified) : 0,
  };
}

function checkApiKey(request, env) {
  return request.headers.get('X-API-Key') === env.API_KEY;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function saveMessage(env, { senderId, text, timestamp, from }) {
  // เก็บข้อความในเธรด (เก็บสูงสุด 300 ข้อความ)
  const key = `msg_${senderId}`;
  const msgs = await env.KV.get(key, 'json') || [];
  msgs.push({ text, timestamp, from });
  if (msgs.length > 300) msgs.splice(0, msgs.length - 300);
  await env.KV.put(key, JSON.stringify(msgs));

  // ดึงชื่อลูกค้าจาก Facebook
  let name = `ลูกค้า (${senderId.slice(-6)})`;
  try {
    const r = await fetch(
      `https://graph.facebook.com/${senderId}?fields=name&access_token=${env.PAGE_ACCESS_TOKEN}`
    );
    if (r.ok) {
      const d = await r.json();
      if (d.name) name = d.name;
    }
  } catch (_) {}

  // อัปเดต conversation list
  const convs = await env.KV.get('conversations', 'json') || [];
  const ci = convs.findIndex(c => c.senderId === senderId);
  const prev = ci >= 0 ? convs[ci] : {};
  const conv = {
    senderId,
    name,
    lastMessage: text,
    lastTime: timestamp,
    unread: from === 'customer' ? ((prev.unread || 0) + 1) : 0,
  };
  if (ci >= 0) convs[ci] = conv;
  else convs.unshift(conv);
  convs.sort((a, b) => b.lastTime - a.lastTime);
  await env.KV.put('conversations', JSON.stringify(convs));
}
