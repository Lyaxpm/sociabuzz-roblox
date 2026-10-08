const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function clampInt(value, min, max, fallback = min) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function cleanText(value, fallback = "", max = 250) {
  const s = String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (s || fallback).slice(0, max);
}

function parseAmount(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }

  let raw = String(value ?? "").trim();
  if (!raw) return 0;
  raw = raw.replace(/[^0-9.,-]/g, "");
  if (!raw) return 0;

  const lastDot = raw.lastIndexOf(".");
  const lastComma = raw.lastIndexOf(",");
  const lastSep = Math.max(lastDot, lastComma);

  // Handle decimal forms such as 10000.00 or 10.000,00.
  // A single separator followed by exactly 3 digits is treated as a thousands separator.
  if (lastSep >= 0) {
    const fractionLength = raw.length - lastSep - 1;
    const hasBoth = lastDot >= 0 && lastComma >= 0;
    const singleThousandsPattern = /^-?\d{1,3}([.,]\d{3})+$/;

    if (fractionLength > 0 && fractionLength <= 2 && (hasBoth || !singleThousandsPattern.test(raw))) {
      const integerPart = raw.slice(0, lastSep).replace(/[.,]/g, "");
      const fractionPart = raw.slice(lastSep + 1).replace(/[.,]/g, "");
      const parsed = Number(`${integerPart}.${fractionPart}`);
      if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed));
    }
  }

  const digits = raw.replace(/[^0-9]/g, "");
  return digits ? Math.max(0, Number.parseInt(digits, 10) || 0) : 0;
}

function candidates(body) {
  // SociaBuzz may wrap webhook fields in a nested object. Walk a few levels
  // so the bridge does not depend on one exact wrapper name.
  const out = [];
  const visited = new Set();

  function walk(value, depth) {
    if (!value || typeof value !== "object" || depth > 4 || visited.has(value)) return;
    visited.add(value);

    if (!Array.isArray(value)) out.push(value);

    for (const child of Object.values(value)) {
      if (child && typeof child === "object") walk(child, depth + 1);
    }
  }

  walk(body, 0);
  return out;
}

function firstValue(objects, keys) {
  for (const obj of objects) {
    for (const key of keys) {
      if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") {
        return obj[key];
      }
    }
  }
  return undefined;
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function normalizeSociaBuzz(rawText, body) {
  const list = candidates(body);

  const externalId = firstValue(list, [
    "transaction_id", "transactionId", "trx_id", "trxId", "reference_id",
    "referenceId", "order_id", "orderId", "payment_id", "paymentId", "id",
  ]);

  const username = cleanText(firstValue(list, [
    "supporter_name", "supporterName", "donor_name", "donorName", "donator_name",
    "donatorName", "sender_name", "senderName", "customer_name", "customerName",
    "payer_name", "payerName", "name", "from",
  ]), "Anonymous", 60);

  let amount = parseAmount(firstValue(list, [
    "amount", "nominal", "total", "total_amount", "totalAmount", "support_amount",
    "supportAmount", "gross_amount", "grossAmount", "nominal_price", "nominalPrice",
    "price", "value",
  ]));

  if (amount <= 0) {
    const unitCount = parseAmount(firstValue(list, ["unit_count", "unitCount", "qty", "quantity"]));
    const unitPrice = parseAmount(firstValue(list, ["unit_price", "unitPrice", "nominal_price", "nominalPrice"]));
    if (unitCount > 0 && unitPrice > 0) amount = unitCount * unitPrice;
  }

  const message = cleanText(firstValue(list, [
    "support_message", "supportMessage", "message", "note", "comment", "text",
  ]), "", 500);

  const currency = cleanText(firstValue(list, [
    "currency", "currency_code", "currencyCode", "support_currency", "supportCurrency",
  ]), "IDR", 8).toUpperCase();
  const createdRaw = firstValue(list, [
    "created_at", "createdAt", "paid_at", "paidAt", "timestamp", "time", "date",
    "support_created_at", "supportCreatedAt",
  ]);

  let createdAt = Date.now();
  if (createdRaw) {
    const parsed = Date.parse(String(createdRaw));
    if (Number.isFinite(parsed)) createdAt = parsed;
  }

  const hash = await sha256Hex(rawText);
  const idBase = externalId ? cleanText(externalId, hash.slice(0, 32), 120) : hash.slice(0, 48);

  return {
    id: `sb_${idBase}`,
    source: "sociabuzz",
    username,
    amount,
    message,
    currency,
    createdAt,
    createdAtIso: new Date(createdAt).toISOString(),
    rawHash: hash,
  };
}

function apiKeyOk(request, env) {
  const given = request.headers.get("x-api-key") || "";
  return Boolean(env.ROBLOX_API_KEY) && given === env.ROBLOX_API_KEY;
}

function adminKeyOk(request, env) {
  const url = new URL(request.url);
  const given = request.headers.get("x-admin-key") || url.searchParams.get("key") || "";
  return Boolean(env.ADMIN_KEY) && given === env.ADMIN_KEY;
}

async function readJson(request) {
  const text = await request.text();
  if (!text) return { text: "{}", body: {} };

  try {
    return { text, body: JSON.parse(text) };
  } catch {
    // Fallback for providers that POST application/x-www-form-urlencoded.
    try {
      const params = new URLSearchParams(text);
      const body = {};
      let count = 0;
      for (const [key, value] of params.entries()) {
        body[key] = value;
        count++;
      }
      if (count > 0) return { text, body };
    } catch {
      // ignore
    }
    return { text, body: null };
  }
}


// GenSociaBuzz Multi Player — API version 2.
// Token dari SociaBuzz hanya dipakai untuk autentikasi bila penyedia benar-benar
// mengirimnya pada request. Jangan aktifkan mode URL_ONLY untuk leaderboard publik.
function safeEqual(a, b) {
  a = String(a || ""); b = String(b || "");
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let i = 0; i < length; i++) difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return difference === 0;
}

function requireApi(request, env) {
  return Boolean(env.ROBLOX_API_KEY) && safeEqual(request.headers.get("x-api-key") || "", env.ROBLOX_API_KEY);
}

function hexRandom(bytes = 20) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function digestSecret(value, env) {
  if (!env.TOKEN_HASH_PEPPER) throw new Error("TOKEN_HASH_PEPPER is not configured");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.TOKEN_HASH_PEPPER),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(value)));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function publicConnection(row, request) {
  if (!row) return { connected: false, status: "disconnected" };
  const origin = new URL(request.url).origin;
  return {
    connected: row.status === "connected",
    connectionId: row.connection_id,
    tokenLast4: row.token_last4,
    status: row.status,
    webhookUrl: `${origin}/webhook/sociabuzz/${row.connection_id}/${row.webhook_secret}`,
    connectedAt: Number(row.verified_at || 0),
    lastWebhookAt: Number(row.last_webhook_at || 0),
    verification: row.verification || "none",
  };
}

function validUserId(input) {
  const num = Number(input);
  return Number.isSafeInteger(num) && num > 0 && num <= 999999999999999 ? num : 0;
}

async function connectionByUser(db, userId) {
  return db.prepare("SELECT * FROM connections WHERE user_id = ?")
    .bind(userId).first();
}

async function handleConnect(request, env) {
  if (!requireApi(request, env)) return json({ok:false,error:"unauthorized"},401);
  const {body} = await readJson(request);
  const userId = validUserId(body?.userId);
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!userId || token.length < 8 || token.length > 300 || /[\r\n\x00-\x1f]/.test(token))
    return json({ok:false,error:"invalid_user_or_token"},400);
  const now = Date.now();
  const hash = await digestSecret(token, env);
  const existing = await connectionByUser(env.DB, userId);
  if (existing && safeEqual(existing.token_hash, hash))
    return json({ok:true,connection:publicConnection(existing,request)});
  const collision = await env.DB.prepare("SELECT user_id FROM connections WHERE token_hash = ?")
    .bind(hash).first();
  if (collision && Number(collision.user_id) !== userId)
    return json({ok:false,error:"token_already_claimed"},409);
  const connectionId = `c_${hexRandom(12)}`;
  const webhookSecret = hexRandom(24);
  // Transaksi lama tetap tersimpan pada donations; hanya koneksi aktif yang dirotasi.
  await env.DB.prepare(`
    INSERT INTO connections
      (user_id,connection_id,token_hash,token_last4,webhook_secret,status,created_at,updated_at)
    VALUES (?,?,?,?,?,'pending',?,?)
    ON CONFLICT(user_id) DO UPDATE SET
      connection_id=excluded.connection_id,token_hash=excluded.token_hash,
      token_last4=excluded.token_last4,webhook_secret=excluded.webhook_secret,
      status='pending',verified_at=NULL,last_webhook_at=NULL,verification=NULL,
      updated_at=excluded.updated_at
  `).bind(userId,connectionId,hash,token.slice(-4),webhookSecret,now,now).run();
  return json({ok:true,connection:publicConnection(await connectionByUser(env.DB,userId),request)});
}

async function handleConnectionStatus(request, env) {
  if (!requireApi(request, env)) return json({ok:false,error:"unauthorized"},401);
  const {body} = await readJson(request);
  const userId = validUserId(body?.userId);
  if (!userId) return json({ok:false,error:"invalid_user"},400);
  const row = await connectionByUser(env.DB, userId);
  return json({ok:true,connection:publicConnection(row,request)});
}

async function handleDisconnect(request, env) {
  if (!requireApi(request, env)) return json({ok:false,error:"unauthorized"},401);
  const {body} = await readJson(request);
  const userId = validUserId(body?.userId);
  if (!userId) return json({ok:false,error:"invalid_user"},400);
  await env.DB.prepare("DELETE FROM connections WHERE user_id = ?").bind(userId).run();
  return json({ok:true,connection:{connected:false,status:"disconnected"}});
}

function providedToken(request, body) {
  const auth = request.headers.get("authorization") || "";
  const candidate = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  // Nama header/field ini hanya kandidat; harus dikonfirmasi dari delivery SociaBuzz asli.
  return request.headers.get("x-sociabuzz-token") ||
    request.headers.get("x-webhook-token") ||
    candidate || firstValue(candidates(body), ["webhook_token", "webhookToken", "sociabuzz_token", "token"]) || "";
}

function isPaymentEvent(body) {
  const status = firstValue(candidates(body), ["payment_status", "paymentStatus", "transaction_status", "transactionStatus", "status"]);
  if (status == null || status === "") return true;
  return ["success","successful","paid","completed","complete","settlement","settled"].includes(String(status).toLowerCase());
}

async function handleWebhook(request, env, connectionId, urlSecret) {
  if (Number(request.headers.get("content-length") || 0) > 65536)
    return json({ok:false,error:"payload_too_large"},413);
  const row = await env.DB.prepare("SELECT * FROM connections WHERE connection_id=?")
    .bind(connectionId).first();
  if (!row || !safeEqual(urlSecret, row.webhook_secret))
    return json({ok:false,error:"unknown_connection"},404);
  const {text,body} = await readJson(request);
  if (text.length > 65536) return json({ok:false,error:"payload_too_large"},413);
  if (!body || typeof body !== "object" || Array.isArray(body))
    return json({ok:false,error:"invalid_body"},400);

  const token = String(providedToken(request, body));
  const validToken = token.length >= 8 && safeEqual(await digestSecret(token,env),row.token_hash);
  // Strict by default. URL_ONLY is an explicitly insecure compatibility mode.
  const urlOnly = env.SOCIA_VERIFY_MODE === "URL_ONLY";
  if (!validToken && !urlOnly) {
    return json({ok:false,error:"provider_token_missing_or_invalid"},401);
  }
  const now = Date.now();
  await env.DB.prepare(`UPDATE connections SET status=?,verified_at=COALESCE(verified_at,?),
    last_webhook_at=?,verification=?,updated_at=? WHERE user_id=? AND connection_id=?`)
    .bind(validToken ? "connected" : "unverified",validToken ? now : null,
      now,validToken ? "token" : "url_only",now,row.user_id,row.connection_id).run();
  if (!isPaymentEvent(body)) return json({ok:true,ignored:"not_a_paid_event"});
  const donation = await normalizeSociaBuzz(text, body);
  if (donation.amount <= 0 || donation.amount > 1e12)
    return json({ok:true,ignored:"not_a_donation"});
  // Scope id by connection, so two creators' transaction IDs never collide.
  const scopedId = `sb_${row.connection_id}_${(await sha256Hex(donation.id)).slice(0,32)}`;
  const result = await env.DB.prepare(`
    INSERT OR IGNORE INTO donations
      (id,source,username,amount,message,currency,created_at,created_at_iso,raw_hash,state,attempts,recipient_user_id,connection_id,verified,verification)
    VALUES (?, 'sociabuzz', ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)
  `).bind(scopedId,donation.username,donation.amount,donation.message,donation.currency,
    donation.createdAt,donation.createdAtIso,donation.rawHash,row.user_id,row.connection_id,
    validToken ? 1 : 0,validToken ? "token" : "url_only").run();
  const inserted = (result.meta?.changes || 0) > 0;
  return json({ok:true,queued:inserted,duplicate:!inserted,id:scopedId});
}

async function handlePull(request, env) {
  if (!requireApi(request, env)) return json({ok:false,error:"unauthorized"},401);
  const {body} = await readJson(request);
  const serverId = cleanText(body?.serverId,"unknown-server",120);
  const limit = clampInt(body?.limit,1,20,5);
  const now = Date.now();
  const leaseToken = hexRandom(20);
  await env.DB.prepare(`UPDATE donations SET state='dead',lease_token=NULL,lease_until=NULL,leased_by=NULL
    WHERE state IN ('queued','leased') AND attempts>=8`).run();
  const leased = await env.DB.prepare(`UPDATE donations SET state='leased',lease_token=?,lease_until=?,
    leased_by=?,attempts=attempts+1 WHERE id IN (
      SELECT id FROM donations WHERE recipient_user_id IS NOT NULL AND recipient_user_id > 0
      AND attempts < 8 AND (state='queued' OR (state='leased' AND COALESCE(lease_until,0)<?))
      ORDER BY created_at ASC LIMIT ?
    ) RETURNING id,source,username,amount,message,currency,created_at_iso,lease_token,recipient_user_id`
  ).bind(leaseToken,now+45000,serverId,now,limit).all();
  return json({ok:true,items:(leased.results||[]).map(row=>({
    id:row.id,source:row.source,username:row.username,amount:Number(row.amount)||0,
    message:row.message||"",currency:row.currency||"IDR",createdAt:row.created_at_iso,
    leaseToken:row.lease_token,recipientUserId:Number(row.recipient_user_id)
  }))});
}

async function handleAck(request,env) {
  if (!requireApi(request,env)) return json({ok:false,error:"unauthorized"},401);
  const {body} = await readJson(request);
  if (!Array.isArray(body?.items)) return json({ok:false,error:"invalid_items"},400);
  const stmts=[];
  for (const item of body.items.slice(0,50)) {
    if (typeof item?.id !== "string" || typeof item?.leaseToken !== "string") continue;
    if (item.status === "done") {
      stmts.push(env.DB.prepare(`UPDATE donations SET state='done',done_at=?,lease_token=NULL,
        lease_until=NULL,leased_by=NULL WHERE id=? AND lease_token=? AND state='leased'`)
        .bind(Date.now(),item.id,item.leaseToken));
    } else {
      stmts.push(env.DB.prepare(`UPDATE donations SET state=CASE WHEN attempts>=8 THEN 'dead' ELSE 'queued' END,
        lease_token=NULL,lease_until=NULL,leased_by=NULL WHERE id=? AND lease_token=? AND state='leased'`)
        .bind(item.id,item.leaseToken));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ok:true,acknowledged:stmts.length});
}

async function handleTop(request,env) {
  if (!requireApi(request,env)) return json({ok:false,error:"unauthorized"},401);
  const limit=clampInt(new URL(request.url).searchParams.get("limit"),1,50,10);
  const rows=await env.DB.prepare(`SELECT recipient_user_id AS userId, SUM(amount) AS total, COUNT(*) AS count
    FROM donations WHERE recipient_user_id IS NOT NULL AND state='done' AND source='sociabuzz'
    GROUP BY recipient_user_id ORDER BY total DESC LIMIT ?`).bind(limit).all();
  return json({ok:true,items:rows.results||[]});
}

async function handleAdminStatus(request,env) {
  if (!adminKeyOk(request,env)) return json({ok:false,error:"unauthorized"},401);
  const counts=await env.DB.prepare("SELECT state,COUNT(*) AS count FROM donations GROUP BY state").all();
  const connectionCounts=await env.DB.prepare("SELECT status,COUNT(*) AS count FROM connections GROUP BY status").all();
  return json({ok:true,counts:counts.results||[],connections:connectionCounts.results||[]});
}

async function handleAdminTest(request,env) {
  if (!adminKeyOk(request,env)) return json({ok:false,error:"unauthorized"},401);
  const {body}=await readJson(request);
  const userId=validUserId(body?.recipientUserId);
  if (!userId) return json({ok:false,error:"recipientUserId_required"},400);
  const id=`test_${hexRandom(16)}`,now=Date.now();
  await env.DB.prepare(`INSERT INTO donations
    (id,source,username,amount,message,currency,created_at,created_at_iso,raw_hash,state,attempts,recipient_user_id,verified,verification)
    VALUES(?,'test',?,?,?,'IDR',?,?,?,'queued',0,?,0,'admin_test')`)
    .bind(id,cleanText(body.username,"TestUser",60),clampInt(body.amount,1,1e10,5000),
    cleanText(body.message,"Test donation",250),now,new Date(now).toISOString(),id,userId).run();
  return json({ok:true,id});
}

export default {
  async fetch(request,env) {
    try {
      const url=new URL(request.url),method=request.method,path=url.pathname;
      if (method==="GET" && path==="/") return json({ok:true,service:"GenSociaBuzz Multi-Player",version:2});
      if (method==="POST" && path==="/api/connect") return handleConnect(request,env);
      if (method==="POST" && path==="/api/connection/status") return handleConnectionStatus(request,env);
      if (method==="POST" && path==="/api/disconnect") return handleDisconnect(request,env);
      if (method==="POST" && path==="/api/pull") return handlePull(request,env);
      if (method==="POST" && path==="/api/ack") return handleAck(request,env);
      if (method==="GET" && path==="/api/top") return handleTop(request,env);
      if (method==="GET" && path==="/admin/status") return handleAdminStatus(request,env);
      if (method==="POST" && path==="/admin/test") return handleAdminTest(request,env);
      const match=/^\/webhook\/sociabuzz\/(c_[a-f0-9]{24})\/([a-f0-9]{48})$/.exec(path);
      if (method==="POST" && match) return handleWebhook(request,env,match[1],match[2]);
      return json({ok:false,error:"not_found"},404);
    } catch(error) {
      console.error("GenSociaBuzz Worker",error?.stack || String(error));
      return json({ok:false,error:"internal_error"},500);
    }
  }
};
