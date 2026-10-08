# sociabuzz-roblox

Cloudflare Worker + D1: bridge donasi SociaBuzz ke Roblox (multi-player).

Alur: game server Roblox connect via `/api/connect` pakai `x-api-key`,
dapat webhook URL unik → SociaBuzz POST donasi ke webhook → game server
poll via `/api/pull` lalu ack via `/api/ack`. Ada leaderboard `/api/top`
dan endpoint admin `/admin/*`.

## Deploy sendiri (butuh akun Cloudflare + wrangler)

```bash
npm install
npx wrangler login

# 1. Bikin database D1
npx wrangler d1 create sociabuzz-roblox
# -> salin "database_id" yang muncul ke wrangler.toml
#    (ganti database_id lama yang masih contoh)

# 2. Jalankan schema (database BARU pakai schema_fresh_v2.sql)
npx wrangler d1 execute sociabuzz-roblox --remote --file=./schema_fresh_v2.sql

# 3. Set secret (JANGAN taruh di wrangler.toml / git)
npx wrangler secret put ROBLOX_API_KEY      # harus SAMA dengan key di game server Roblox
npx wrangler secret put ADMIN_KEY           # untuk endpoint /admin/*
npx wrangler secret put TOKEN_HASH_PEPPER   # random string panjang, internal saja

# 4. Deploy
npx wrangler deploy
```

Worker akan live di `https://sociabuzz-roblox.<akun>.workers.dev`.

## Tes cepat

```bash
curl https://sociabuzz-roblox.<akun>.workers.dev/
# -> {"ok":true,"service":"GenSociaBuzz Multi-Player","version":2}

curl -s -H "x-admin-key: <ADMIN_KEY>" \
  https://sociabuzz-roblox.<akun>.workers.dev/admin/status
```

## Endpoint

| Method | Path | Auth | Fungsi |
|---|---|---|---|
| POST | /api/connect | x-api-key | daftar userId + token SociaBuzz, dapat webhook URL |
| POST | /api/connection/status | x-api-key | status koneksi |
| POST | /api/disconnect | x-api-key | hapus koneksi |
| POST | /api/pull | x-api-key | ambil donasi queued (lease 45 dtk) |
| POST | /api/ack | x-api-key | tandai done / kembalikan ke queue |
| GET | /api/top?limit=10 | x-api-key | leaderboard donatur |
| POST | /webhook/sociabuzz/:connId/:secret | token SociaBuzz | webhook donasi masuk |
| GET | /admin/status | x-admin-key | statistik queue |
| POST | /admin/test | x-admin-key | inject donasi percobaan |

Catatan: `SOCIA_VERIFY_MODE` di wrangler.toml default `TOKEN` (strict).
Jangan pakai `URL_ONLY` kecuali paham risikonya (webhook tanpa verifikasi token).
