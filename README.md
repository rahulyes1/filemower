# File Mover

Move a file between your **Android, iPhone and PC** with a one-time 12-digit key.
Files are **encrypted in your browser** before they leave the device, and they're
**deleted 30 minutes after upload** (or right after they're downloaded).

**Live:** https://filemower.vercel.app

## How it works

1. **Send:** choose a file (up to 30 MB). You get a key like `4821-0937-5562`, a QR code and a link.
2. **Receive:** on the other device, open the site, tap **Receive** and type the key.
   It downloads, decrypts and is removed from the server. You can also scan the QR or open the link.

## Security

- The key is turned into 512 bits with **PBKDF2-SHA256** (600,000 rounds):
  the first half is the storage id, the second half is the **AES-256-GCM** key.
- The server only ever sees the storage id and encrypted bytes. Never the key, the file, its name or its type.
- Files are sent in 1 MB parts (short requests that survive slow mobile links, each retried on failure).
  Every part is authenticated with its position, so parts can't be swapped, reordered or dropped.
- Shared links put the key after `#`, which browsers never send to servers.
- Storage is a **private** Vercel Blob store. Files have no public URL.
- Files expire 30 minutes after upload. Expired files are refused and deleted on read,
  and a daily cron purges anything left over.

## Project layout

```
public/          static site (index.html, style.css, app.js)
public/crypto.mjs    key derivation + encryption (shared with tests)
public/transfer.mjs  upload/download engine (shared with tests)
public/qrcode.js     self-contained QR generator
api/             Vercel functions: part, meta, health, cleanup
lib/             shared server code: storage (Vercel Blob / local folder), HTTP helpers
scripts/dev.mjs  local server that runs the same api/ handlers
test/e2e.mjs     end-to-end tests against any deployment
```

## Run locally

```bash
npm install
npm run dev          # http://localhost:3000, files stored in your temp folder
npm test             # end-to-end tests against localhost
node test/e2e.mjs https://filemower.vercel.app   # tests against the live site
```

## Deploy (Vercel)

1. Import the repo in Vercel. `vercel.json` already sets the static output and the cleanup cron.
2. **Storage → Create → Blob** (private), and connect it to the project.
3. Redeploy. `GET /api/health` should return `{"ok":true,"storage":"blob"}`.

Optional: set `CRON_SECRET` so only Vercel's cron can call `/api/cleanup`.
