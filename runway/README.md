# Runway drops

New designs for therunway.linkhaus.com.au go in as a folder of art plus one small JSON file. The pipeline turns that into draft Shopify products, links every variant to its print file in Printful, adds mockups, and publishes on the release date. Nothing goes live unless Printful can fulfil it.

This site code (the Vite app at the repo root) is unrelated. Everything here is plain Node 20.12+ with no dependencies.

## Adding a drop

```bash
node bin/runway.mjs new world-tour-2
```

1. Put transparent PNGs in `drops/world-tour-2/art/`. Aim for 3600px wide or more, 3:4 portrait (the back print area). 1800px wide is the hard minimum.
2. Edit `drops/world-tour-2/drop.json`:

```json
{
  "collection": { "title": "World Tour II", "description": "One or two sentences for the collection page." },
  "release": "2026-12-04",
  "designs": [
    {
      "title": "Rainbow Connection Encore Tee",
      "blank": "heavy-tee",
      "color": "Black",
      "art": "art/encore.png",
      "description": "Two or three sentences in the store's voice.",
      "tags": ["nostalgia"]
    }
  ]
}
```

3. `node bin/runway.mjs validate` checks the file and the art. `node bin/runway.mjs plan` shows every product, variant count and Printful variant range it will create.
4. Open a pull request. CI runs the tests, validate and plan. On merge to `main`, the pipeline creates the drafts and links them.
5. At 08:17 Sydney each day, due drops are published, and anything not ready is held back and retried the next day.

Fields per design: `title` and `art` and `description` are needed; `blank` is `heavy-tee` (Comfort Colors 1717, back print, black or ivory), `staple-tee` (Bella+Canvas 3001, front print, white) or `hoodie` (Gildan 18500, front print, five colours). Optional: `color` or `colors` (a list, for several colours in one product), `sizes`, `price`, `handle`, `tags`, `seo`, `artVersion` (bump to force a re-send after editing art).

New blanks (mugs, posters, caps) are added in `config.json` with the Printful variant IDs, copied from an existing product's SKUs (`5933342_9526` means variant `9526`).

## One-off setup

Both connections are account steps that need you, not code.

**Shopify** (the Admin API no longer hands out tokens from the store admin):
1. In the Shopify Dev Dashboard, create an app in the same organisation as the store.
2. Release a version with scopes `read_products,write_products,read_files,write_files,read_publications,write_publications` and install it on the store.
3. Copy the Client ID and Client secret from the app's Settings page.

If the store belongs to a different organisation than the app, Shopify answers `shop_not_permitted`. Create the app from the store owner's Dev Dashboard instead.

**Printful** (already connected to the store, per the live products):
1. In the Printful developer portal create a private token with scopes `sync_products` and `webhooks` for the store.
2. The store ID is `18833363` per the earlier notes. Confirm it with `doctor`.

**Secrets**, in GitHub repo Settings, Secrets and variables, Actions:

| Name | Kind | Value |
|---|---|---|
| `SHOPIFY_SHOP` | secret | `your-store` (the `myshopify.com` subdomain only) |
| `SHOPIFY_CLIENT_ID` | secret | from the Dev Dashboard |
| `SHOPIFY_CLIENT_SECRET` | secret | from the Dev Dashboard |
| `PRINTFUL_TOKEN` | secret | the private token |
| `PRINTFUL_STORE_ID` | variable | `18833363` |

For local runs, put the same names in `runway/.env` (it is git-ignored) and use `node bin/runway.mjs doctor`.

## Commands

| Command | What it does |
|---|---|
| `new <name>` | Scaffold a drop |
| `validate`, `plan` | Offline checks, safe anywhere |
| `sync` | Create or update drafts, link Printful, add mockups |
| `release` | Publish due drops (`release <drop> --now` for early) |
| `doctor` | Checks both connections, scopes, and that every Printful product is fully linked |
| `tidy` | Fixes product type, tags and image alt text on the hand-made products (lists first, `--apply` to write) |
| `audit` | Storefront hygiene check from the public feed, no credentials |

## How it stays safe

- New products are always created as drafts. Updates never change status.
- It only touches products tagged `runway-pipeline`. A product with the same handle that it did not create stops the run.
- Printful imports Shopify products on its own schedule (seconds to hours) and the API cannot create them. Until a product is imported and every variant has a print file, `release` holds it back.
- Re-running is safe. A fingerprint tag on each product means unchanged designs are skipped, and edited art or text triggers an update.
- Variants never sell out (print on demand) and carry weights, matching the existing products.

## Printful gotchas

- Mockup generation is limited to 2 requests a minute on newer stores. Big drops take a while.
- Printful downloads print files from a URL. The pipeline uploads art to Shopify Files first and sends that CDN link.
- Press "Refresh data" on the store in Printful to speed up an import that has not arrived.
