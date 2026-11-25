# Crop

**Crop is an early version of a personal drawing library.** It helps you organize images with manually assigned tags and find drawings or specific areas within them. No AI or application server is involved: drawings and tags stay in IndexedDB in your browser.

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

Drawings and tags are stored in IndexedDB in your browser. The selected theme is stored in local storage. There are no accounts, backend, or synchronization, so each browser has its own library. Clearing this site's browser data may erase the library. Keep the original image files too, and make backups regularly.

Crop asks the browser for persistent storage when it starts and again after the first import, and shows how much room the library takes. Browsers grant persistence to apps they trust, so installing Crop is the reliable way to keep a library out of reach of automatic cleanup.

## Feedback

Use the **Feedback** link in Crop or [open the feedback form](https://github.com/NOT16180/crop/issues/new?template=feedback.yml) to share what worked or what could be better. Feedback is submitted as a public GitHub issue; do not include personal information or private artwork.

## Promoting the first version

You can describe Crop as an early version or beta and invite people who draw to try it. For example:

> I'm sharing the first version of Crop, a personal library for organizing drawings with tags and finding details in images. Files stay in your browser. I'm looking for people who draw to try the app and share their feedback.

Include a short demo or a few screenshots with your post, then share it in communities where potential users spend time. Ask which tasks feel easy, where they get stuck, and what is missing.

## Deploy to Cloudflare

Crop is a static site and can be deployed to Cloudflare Workers as static assets, without a backend:

1. Create a Worker connected to this Git repository in **Workers & Pages**.
2. Set the build command to `npm run build` and the deploy command to `npx wrangler deploy`.
3. Deploy. `wrangler.jsonc` points Wrangler to `dist`, and the `public/_headers` file is copied into that directory to set response headers.

For a manual deployment, run `npm install`, `npm run build`, then `npx wrangler deploy`. Cloudflare also offers Pages: if you choose Pages, configure its build command as `npm run build` and output directory as `dist`, then deploy through the Pages integration or with `npx wrangler pages deploy dist`.

The app uses browser storage only, so no Cloudflare database, Worker, or environment variables are required. Each visitor's library remains in that visitor's browser.

## Design language

Crop follows the same visual language as [notgalerie.com](https://notgalerie.com): **Inconsolata** monospace, black on white, 1px borders, square corners, and uppercase chrome. The font is served by the app itself (no Google Fonts request, and it keeps working offline). Buttons, section titles and labels are uppercase like the site; user text — file names, tags, help copy — keeps its own case so it stays readable.

The app icon is a black outline square on a white background.

## Technology

Vite, Svelte, TypeScript, and Dexie/IndexedDB, with a service worker that caches the app shell for offline use. Build with `npm run build`; check types and Svelte components with `npm run check`; run the unit tests with `npm test`.
