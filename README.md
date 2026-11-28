# Crop

**Crop is a local-first drawing reference library** built for illustrators and artists. Tag whole images or specific cropped regions (hands, faces, hatching, textures…), then search a tag to pull up every matching detail instantly.

Live at [crop.notgalerie.com](https://crop.notgalerie.com).

- **100% local & unlimited without an account**: drawings, thumbnails, folders, and tags live in IndexedDB for instant offline use.
- **Optional cloud sync**: sign in with a passwordless email link to sync across devices via Cloudflare D1 + R2 (**100 MB free**, or **Crop Pro 5 GB** at €2.50/month or €15/year via Polar with 1-click cancel/resume).
- **5 languages**: English, Français, Español, 日本語, and 中文 (auto-detected from the browser, switchable anytime).
- **No ads, no tracking, no AI training.**

## Try Crop locally

```bash
npm install
npm run dev
```

Open the address shown in the terminal (usually `http://localhost:5173`).

## Features

- **Import & paste**: drag PNG, JPG, WebP, or AVIF images onto the page, click **Add images**, or paste from the clipboard. Files the browser cannot decode are reported individually.
- **Try immediately with samples**: load 4 curated ink artworks with pre-tagged regions (`face`, `hands`, `hatching`, `object`) in one click, kept local-only and removable anytime.
- **Region & whole-image tagging**: drag a rectangle over any detail to tag that crop, or tag the whole drawing. Resize boxes, group duplicate tag names, rename/merge tags globally via the Tag Manager, and filter by multiple tags (`ALL` / `ANY`).
- **Crisp previews & optional compression**: 960 px high-quality thumbnails with background upgrade for older imports, plus optional WebP compression (automatic high-quality JPEG fallback on Safari/iOS).
- **Folders & manual ordering**: create, rename, and delete folders; select multiple drawings to move them; drag to reorder on desktop or use arrow controls on touch screens.
- **Local ZIP backup & restore**: streaming ZIP export and validated merge restore (up to 600 MB compressed / 512 MB expanded), fully offline.
- **2× HD reference sheets (download or copy)**: export or 1-click copy a 2000 px high-resolution editorial PNG contact sheet (light or `#212121` dark theme matching the app, numbered tiles with cropped tag regions and captions, exports only selected drawings when in selection mode).
- **Offline PWA & themes**: installable offline app with persistent storage request, `#212121` monochrome light & dark themes, and 8-second undo on deletions.

## Data, privacy & cloud sync

Without an account, nothing leaves your browser: all images and tags stay in IndexedDB on your device. Signing out only stops cloud sync and keeps all local drawings intact.

When signed in, folders, drawings, tags, and blobs sync to Cloudflare D1 and R2 (100 MB free quota, or 5 GB with Crop Pro; 20 MB max per image). You can delete your account and all cloud data anytime from the Account modal. Keep original files and export ZIP backups regularly.

## Feedback

Use the **Feedback** link in Crop or [open the feedback form](https://github.com/NOT16180/crop/issues/new?template=feedback.yml). Feedback creates a public GitHub issue; do not include personal information or private artwork.

## Deploy to Cloudflare

Crop is served by a Cloudflare Worker with static assets (`dist`), a D1 database (`crop-auth`), and an R2 bucket (`crop-blobs`):

1. Configure `wrangler.jsonc` with your D1 `database_id`, R2 `bucket_name`, and custom domain route.
2. Apply all D1 migrations (`0001_accounts.sql` through `0004_billing.sql`):
   ```bash
   npx wrangler d1 migrations apply crop-auth --remote
   ```
3. Set plain-text vars in `wrangler.jsonc` or Cloudflare Dashboard:
   - `AUTH_URL`: exact public HTTPS origin (e.g. `https://crop.notgalerie.com`)
   - `AUTH_EMAIL_FROM`: verified Resend sender (e.g. `Crop <login@mail.notgalerie.com>`)
   - `POLAR_PRODUCT_MONTHLY_ID` and `POLAR_PRODUCT_ANNUAL_ID`: Polar product IDs for Crop Pro 5 GB
4. Set encrypted Worker secrets via Wrangler CLI (never commit them):
   - `BETTER_AUTH_SECRET`
   - `RESEND_API_KEY`
   - `POLAR_ACCESS_TOKEN`
   - `POLAR_WEBHOOK_SECRET`
5. Build and deploy:
   ```bash
   npm run build && npx wrangler deploy
   ```

Sign-in links expire after 10 minutes with hashed tokens and D1 IP rate limiting. Polar webhooks are verified with Standard Webhooks HMAC-SHA256 signatures and replay protection.

For local Worker testing, put those secrets in an ignored `.dev.vars` file, run `npx wrangler d1 migrations apply crop-auth --local`, then `npm run build && npx wrangler dev`.

## Design language & Open Graph

Crop shares the visual language of [notgalerie.com](https://notgalerie.com): **Inconsolata** self-hosted monospace, `#212121` charcoal ink on `#ffffff` paper (and `#212121` dark gallery mode), crisp 1 px borders, square corners, and uppercase chrome.

To regenerate the `1200×630` Open Graph card (`public/og-crop.jpg`) after editing text or artwork in `scripts/generate-og.py`:

```bash
python3 scripts/generate-og.py
```

## Development & checks

Built with Vite, Svelte 5, TypeScript, Dexie (IndexedDB), `fflate`, and Better Auth.

- `npm run check` — Svelte + TypeScript checks
- `npm run build` — production client bundle
- `npm test` — unit, sync, auth, Polar billing, i18n parity, and security test suite (40 tests)
