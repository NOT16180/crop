# Crop

**Crop is an early version of a personal drawing library.** It helps you organize images with manually assigned tags and find drawings or specific areas within them. Images and tags stay in IndexedDB in the browser. Email account sign-in is implemented as the first step toward cloud sync; signing in does not upload the library. It requires the Cloudflare and email settings below before it can be used on the deployed site.

## Try Crop locally

To run the app on your computer:

```bash
npm install
npm run dev
```

Open the address shown in the terminal (usually http://localhost:5173).

## Features

- Import PNG, JPG, WebP, or AVIF images by dragging them onto the page or clicking **Add**. You can also paste an image from the clipboard. Files the browser cannot decode are reported individually.
- Create, rename, delete, and switch folders. Deleting a folder leaves its drawings in the unfiled collection.
- Select several drawings to move them together. Use **Arrange drawings** and the arrow buttons to reorder them on touch screens; drag cards to swap their positions on desktop.
- Open a drawing and drag a rectangle to tag a specific area, or leave the image unselected to tag the whole drawing.
- Choose which tags appear on a drawing from its **Tags** menu. Tags with the same name are grouped and can be toggled together.
- Search for a tag or choose one from the **Tags** menu to find matching drawings and regions.
- Download a local ZIP archive of drawings, folders, and tags with **Backup**. **Restore** validates and merges an archive into the current library. Restores are limited to 600 MB compressed and 512 MB expanded. The archive is not uploaded or synced.
- Export the images currently shown as a single PNG sheet with **Export sheet**: tagged areas are cropped, tag names are written under each tile, and the app address is printed at the bottom. Pick how many images the sheet holds with the **Sheet** menu, or *All images* for every result.
- Install Crop from the browser menu (*Install*, or *Add to Home screen*) to keep it working with no network: the app shell is cached, and installing is what makes browser storage persistent.
- Undo single and bulk drawing deletions for eight seconds.
- Tell duplicate filenames apart by their import date and a short ID.
- Switch between light and dark mode with the theme button.

## Data and privacy

Drawings and tags are stored in IndexedDB in your browser. The selected theme is stored in local storage. Accounts currently provide sign-in only and do not upload or sync drawings, so each browser still has its own library. Clearing this site's browser data may erase the library. Keep the original image files too, and make backups regularly.

Crop asks the browser for persistent storage when it starts and again after the first import, and shows how much room the library takes. Browsers grant persistence to apps they trust, so installing Crop is the reliable way to keep a library out of reach of automatic cleanup.

## Feedback

Use the **Feedback** link in Crop or [open the feedback form](https://github.com/NOT16180/crop/issues/new?template=feedback.yml) to share what worked or what could be better. Feedback is submitted as a public GitHub issue; do not include personal information or private artwork.

## Promoting the first version

You can describe Crop as an early version or beta and invite people who draw to try it. For example:

> I'm sharing the first version of Crop, a personal library for organizing drawings with tags and finding details in images. Files stay in your browser. I'm looking for people who draw to try the app and share their feedback.

Include a short demo or a few screenshots with your post, then share it in communities where potential users spend time. Ask which tasks feel easy, where they get stuck, and what is missing.

## Deploy to Cloudflare

Crop is served as static assets by a Cloudflare Worker. The Worker also provides the account API and connects to a D1 database:

1. Create a Worker connected to this Git repository in **Workers & Pages**.
2. Set the build command to `npm run build` and the deploy command to `npx wrangler deploy --keep-vars` so dashboard variables are preserved.
3. Create the D1 database with `npx wrangler d1 create crop-auth` and put the returned database ID in `wrangler.jsonc`.
4. Set the Worker variables and secrets described below, then apply the account schema with `npx wrangler d1 migrations apply crop-auth --remote`.
5. Deploy. `wrangler.jsonc` points Wrangler to `dist`, and the `public/_headers` file is copied into that directory to set response headers.

In Cloudflare, open **Workers & Pages → crop → Settings → Variables and Secrets**. Add these as plain text variables (they are configuration, not credentials):

- `AUTH_URL`: the exact public origin, such as `https://crop.example.com` (HTTPS, no path).
- `AUTH_EMAIL_FROM`: a sender on the verified email domain, such as `Crop <login@example.com>`.

In Resend, verify the sending domain by adding its requested DNS records, then create an API key with **Sending access** restricted to that domain. In your local terminal, set both values as Worker secrets:

- `BETTER_AUTH_SECRET`: generate it locally with `npx auth@latest secret`, then run `npx wrangler secret put BETTER_AUTH_SECRET` and paste it into Wrangler's hidden prompt.
- `RESEND_API_KEY`: run `npx wrangler secret put RESEND_API_KEY` and paste the restricted Resend key into Wrangler's hidden prompt.

Never put either secret in `wrangler.jsonc`, source code, a commit, or a chat. Wrangler stores secrets encrypted; its `secret put` command prompts for the value and deploys a Worker version. Keep dashboard variables on later CLI deployments by using `--keep-vars`.

Sign-in links expire after 10 minutes; their tokens are hashed in D1. Requests for links are limited to three per IP per minute, with persistent rate-limit counters in D1. The Worker only trusts the configured HTTPS origin and uses Cloudflare's client IP header for rate limiting.

For local Worker development, create an ignored `.dev.vars` file with those four values. Use a separate local D1 database with `npx wrangler d1 migrations apply crop-auth --local`. Run `npm run build` and then `npx wrangler dev` to use the Worker locally. `npm run dev` starts Vite's static development server and does not provide the account API.

For a manual deployment, run `npm install`, `npm run build`, then `npx wrangler deploy --keep-vars`. Pages-only deployment is no longer sufficient for the account API; the site must run through the configured Worker.

## Design language

Crop follows the same visual language as [notgalerie.com](https://notgalerie.com): **Inconsolata** monospace, black on white, 1px borders, square corners, and uppercase chrome. The font is served by the app itself (no Google Fonts request, and it keeps working offline). Buttons, section titles and labels are uppercase like the site; user text — file names, tags, help copy — keeps its own case so it stays readable.

The app icon is a black outline square on a white background.

## Technology

Vite, Svelte, TypeScript, and Dexie/IndexedDB, with a service worker that caches the app shell for offline use. Build with `npm run build`; check types and Svelte components with `npm run check`; run the unit tests with `npm test`.
