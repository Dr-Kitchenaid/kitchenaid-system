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

    // POST /stock  { parts: [...] }  — browser syncs stock snapshot to KV
    if (request.method === 'POST' && url.pathname === '/stock') {
      const { parts } = await request.json().catch(() => ({}));
      if (!Array.isArray(parts)) return json({ error: 'parts must be array' }, 400);
      await env.KV.put('stock_parts', JSON.stringify(parts));
      return json({ ok: true });
    }

    // GET /stock/low — items where stock <= minStock (and minStock > 0)
    if (request.method === 'GET' && url.pathname === '/stock/low') {
      const parts = await env.KV.get('stock_parts', 'json') || [];
      const low = parts.filter(p => (p.minStock || 0) > 0 && (p.stock || 0) <= (p.minStock || 0));
      return json(low);
    }

    // GET /export — all business data
    if (request.method === 'GET' && url.pathname === '/export') {
      const [quotations, invoices, repairs, parts, settings, sequences] = await Promise.all([
        env.KV.get('biz_quotations', 'json'),
        env.KV.get('biz_invoices',   'json'),
        env.KV.get('biz_repairs',    'json'),
        env.KV.get('biz_parts',      'json'),
        env.KV.get('biz_settings',   'json'),
        env.KV.get('biz_sequences',  'json'),
      ]);
      return json({
        quotations: quotations || [],
        invoices:   invoices   || [],
        repairs:    repairs    || [],
        parts:      parts      || [],
        settings:   settings   || {},
        sequences:  sequences  || {},
      });
    }

    // POST /import — save all business data
    if (request.method === 'POST' && url.pathname === '/import') {
      const body = await request.json().catch(() => ({}));
      const ops = [];
      if (body.quotations !== undefined) ops.push(env.KV.put('biz_quotations', JSON.stringify(body.quotations)));
      if (body.invoices   !== undefined) ops.push(env.KV.put('biz_invoices',   JSON.stringify(body.invoices)));
      if (body.repairs    !== undefined) ops.push(env.KV.put('biz_repairs',    JSON.stringify(body.repairs)));
      if (body.parts      !== undefined) ops.push(env.KV.put('biz_parts',      JSON.stringify(body.parts)));
      if (body.settings   !== undefined) ops.push(env.KV.put('biz_settings',   JSON.stringify(body.settings)));
      if (body.sequences  !== undefined) ops.push(env.KV.put('biz_sequences',  JSON.stringify(body.sequences)));
      await Promise.all(ops);
      return json({ ok: true });
    }

    return new Response('Not Found', { status: 404 });
  },
};

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
