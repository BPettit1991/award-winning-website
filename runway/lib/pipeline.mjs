import { readFile } from 'node:fs/promises';
import { gidNumber, sha8, todayIn } from './util.mjs';
import { REQUIRED_SCOPES } from './shopify.mjs';

const collectionOf = (drop) => ({
  handle: drop.manifest.collection.handle ?? drop.slug,
  title: drop.manifest.collection.title,
  descriptionHtml: drop.manifest.collection.description ? `<p>${drop.manifest.collection.description}</p>` : '',
  tag: `drop:${drop.slug}`,
});

/** How many of a product's variants Printful has imported and linked to a print file. */
function printfulState(syncProduct, expected) {
  if (!syncProduct) return { imported: 0, linked: 0, expected, ready: false };
  const variants = syncProduct.sync_variants ?? [];
  const linked = variants.filter((v) => v.synced).length;
  return { imported: variants.length, linked, expected, ready: linked === expected && variants.length === expected };
}

/**
 * Brings one design up to "ready to release": Shopify draft product, Printful link, mockups.
 * Every step checks live state first, so re-running is safe and picks up where the last run stopped.
 */
export async function syncDesign(item, { shopify, printful, config, log = () => {}, relink = false }) {
  // Local art is part of the fingerprint, so replacing a PNG re-sends it even if the manifest is untouched.
  const spec = item.spec.artPath ? { ...item.spec, hash: sha8(item.spec.hash + sha8(await readFile(item.spec.artPath))) } : item.spec;
  const out = { handle: spec.handle };

  let product = await shopify.findProduct(spec.handle);
  if (product && !product.tags.includes(config.ownerTag)) {
    throw new Error(`"${spec.handle}" already exists in Shopify and was not created by this pipeline. Give the design a different title or handle.`);
  }
  const changed = !product || !product.tags.includes(`rw-spec-${spec.hash}`);
  if (changed) {
    out.shopify = product ? 'updated' : 'created as draft';
    product = await shopify.upsertProduct(spec, { create: !product });
  } else {
    out.shopify = 'unchanged';
  }
  out.status = product.status;

  let artUrl;
  const art = async () => (artUrl ??= spec.artIsUrl ? spec.art : await shopify.uploadArt(spec.artPath, `rw-art-${spec.handle}-${spec.hash}.png`));

  // Printful imports new Shopify products on its own schedule (seconds to hours). Until then there is nothing to link.
  const syncProduct = await printful.getSyncProduct(gidNumber(product.id));
  if (!syncProduct) {
    out.printful = 'waiting for Printful to import the product';
  } else {
    const byShopifyId = new Map(product.variants.nodes.map((v) => [gidNumber(v.id), v]));
    let linkedNow = 0;
    for (const sv of syncProduct.sync_variants ?? []) {
      if (sv.synced && !changed && !relink) continue;
      const shopVariant = byShopifyId.get(String(sv.external_id)) ?? product.variants.nodes.find((v) => v.sku && v.sku === sv.sku);
      const variant = shopVariant && spec.variants.find((v) => v.sku === shopVariant.sku);
      if (!variant) { log(`  ! ${spec.handle}: Printful variant ${sv.id} (${sv.name}) matches no variant in the drop`); continue; }
      await printful.linkVariant(sv.id, { variantId: variant.printfulVariantId, placement: spec.placement, artUrl: await art() });
      sv.synced = true;
      linkedNow++;
    }
    const state = printfulState(syncProduct, spec.variants.length);
    out.printful = `${state.linked}/${state.expected} variants linked${linkedNow ? ` (${linkedNow} this run)` : ''}${state.imported < state.expected ? `, ${state.expected - state.imported} not imported yet` : ''}`;
    out.printfulReady = state.ready;
  }

  if (product.media.nodes.length) {
    out.mockups = `${product.media.nodes.length} images already on the product`;
  } else {
    const blank = config.blanks[spec.blank];
    const variantIds = spec.colors.map((c) => blank.printful[c][config.mockups.sampleSize] ?? Object.values(blank.printful[c])[0]);
    const mockups = await printful.mockups({
      catalogProductId: await printful.catalogProductId(variantIds[0]),
      variantIds,
      placement: spec.placement,
      artUrl: await art(),
      format: config.mockups.format,
      width: config.mockups.width,
    });
    const picked = mockups.slice(0, config.mockups.max);
    if (picked.length) await shopify.addMedia(product.id, picked.map((m) => ({ url: m.url, alt: `${spec.title}, ${String(m.title).toLowerCase()} view` })));
    out.mockups = `${picked.length} added`;
  }
  return out;
}

export async function syncDrop(drop, specs, ctx) {
  const collection = await ctx.shopify.ensureCollection(collectionOf(drop));
  ctx.log?.(`${drop.slug}: collection "${drop.manifest.collection.title}" ${collection.created ? 'created (hidden until release)' : 'exists'}`);
  const results = [];
  for (const item of specs) {
    try {
      results.push(await syncDesign(item, ctx));
    } catch (err) {
      results.push({ handle: item.spec.handle, error: err.message });
    }
  }
  return results;
}

/** A drop is due when its release date has arrived in the store's timezone. */
export const isDue = (drop, config, now = new Date()) => Boolean(drop.manifest.release) && drop.manifest.release <= todayIn(config.timezone, now);

/** Publishes every design in the drop that is fully ready. Returns per-design outcomes; nothing half-ready goes live. */
export async function releaseDrop(drop, specs, { shopify, printful, config }) {
  const publicationId = await shopify.onlineStorePublicationId();
  const results = [];
  for (const { spec } of specs) {
    const product = await shopify.findProduct(spec.handle);
    const blocked = (reason) => results.push({ handle: spec.handle, blocked: reason });
    if (!product) { blocked('not in Shopify yet (run sync first)'); continue; }
    if (!product.tags.includes(config.ownerTag)) { blocked('exists in Shopify but is not managed by this pipeline'); continue; }
    if (product.status === 'ACTIVE') { results.push({ handle: spec.handle, live: true }); continue; }
    const state = printfulState(await printful.getSyncProduct(gidNumber(product.id)), spec.variants.length);
    if (!state.ready) { blocked(`Printful has ${state.linked}/${state.expected} variants linked, so orders would not fulfil`); continue; }
    if (!product.media.nodes.length) { blocked('no product images yet'); continue; }
    await shopify.publish(product.id, publicationId);
    await shopify.setStatus(product.id, 'ACTIVE');
    results.push({ handle: spec.handle, released: true });
  }
  if (results.some((r) => r.released || r.live)) {
    const collection = await shopify.ensureCollection(collectionOf(drop));
    await shopify.publish(collection.id, publicationId);
  }
  return results;
}

/** Checks both connections and that every Shopify product has a fulfillable Printful counterpart. */
export async function doctor({ shopify, printful, config }) {
  const lines = [];
  let ok = true;
  const fail = (msg) => { ok = false; lines.push(`FAIL  ${msg}`); };
  const pass = (msg) => lines.push(`ok    ${msg}`);

  try {
    const shop = await shopify.shopInfo();
    pass(`Shopify: ${shop.name} (${shop.myshopifyDomain}, ${shop.primaryDomain.host}), ${shop.productsCount} products, ${shop.currencyCode}`);
    const missing = REQUIRED_SCOPES.filter((s) => !shop.scopes.includes(s));
    if (missing.length) fail(`Shopify app is missing scopes: ${missing.join(', ')}`); else pass('Shopify scopes cover products, files and publications');
    await shopify.onlineStorePublicationId();
    pass('Shopify Online Store channel found');
  } catch (err) { fail(`Shopify: ${err.message}`); }

  try {
    const stores = await printful.stores();
    pass(`Printful stores on this token: ${stores.map((s) => `${s.name} [${s.id}, ${s.type}]`).join('; ')}`);
    if (stores.length > 1 && !config.printfulStoreId && !process.env.PRINTFUL_STORE_ID) fail('Token sees several Printful stores: set PRINTFUL_STORE_ID');
    const all = await printful.listSyncProducts('all');
    const unsynced = all.filter((p) => !p.is_ignored && p.synced < p.variants);
    pass(`Printful has ${all.length} imported products`);
    if (unsynced.length) fail(`Not fully linked in Printful (orders for these will not fulfil): ${unsynced.map((p) => `${p.name} ${p.synced}/${p.variants}`).join('; ')}`);
    else pass('Every imported Printful product is fully linked');
    for (const [key, blank] of Object.entries(config.blanks)) {
      const variantId = Object.values(Object.values(blank.printful)[0])[0];
      try { pass(`Blank "${key}" resolves to Printful catalogue product ${await printful.catalogProductId(variantId)}`); }
      catch (err) { fail(`Blank "${key}": variant ${variantId} not found in the Printful catalogue (${err.message})`); }
    }
  } catch (err) { fail(`Printful: ${err.message}`); }

  return { ok, lines };
}

/** Storefront hygiene check on the public product feed. Needs no credentials. */
export function auditCatalogue(products, collections = []) {
  const findings = [];
  const list = (items) => `${items.length}: ${items.slice(0, 6).map((p) => p.handle).join(', ')}${items.length > 6 ? ', ...' : ''}`;
  const add = (title, items) => { if (items.length) findings.push(`${title} (${list(items)})`); };
  add('Products with no tags, so tag-based collections and filters cannot find them', products.filter((p) => !p.tags?.length));
  add('Product type looks like a Printful default rather than a customer-facing type', products.filter((p) => /^[A-Z\- ]+$/.test(p.product_type ?? '')));
  add('Product type does not match the title', products.filter((p) => /hoodie/i.test(p.title) && !/hoodie/i.test(p.product_type ?? '')));
  add('Images with no alt text (accessibility and SEO)', products.filter((p) => p.images?.some((i) => !i.alt)));
  add('Products with no images', products.filter((p) => !p.images?.length));
  add('Variants with no SKU', products.filter((p) => p.variants?.some((v) => !v.sku)));
  add('Short descriptions (under 200 characters)', products.filter((p) => (p.body_html ?? '').replace(/<[^>]+>/g, '').length < 200));
  const real = collections.filter((c) => c.handle !== 'frontpage');
  if (collections.length && real.length < 2) findings.push(`Only ${real.length} collection besides the home page: everything sits in one list, with no way to browse by theme or product type`);
  for (const c of collections.filter((c) => /-\d+$/.test(c.handle))) findings.push(`Collection handle "${c.handle}" has a numeric suffix (left over from duplicates); a clean handle makes a better URL`);
  return findings;
}

const VIEW = /-(front|back|left|right)(?:-|\.)/;

/**
 * Plans metadata fixes for products made by hand in Printful's design maker (not by this pipeline):
 * a real product type, browsable tags, and alt text on every image. Prices, variants and print files are never touched.
 */
export function planTidy(products, config) {
  const plan = [];
  for (const p of products) {
    if (p.tags.includes(config.ownerTag)) continue;
    const kind = /hoodie/i.test(p.title) ? 'Hoodie' : /\b(cap|hat)\b/i.test(p.title) ? 'Hat' : /\btee\b|t-shirt/i.test(p.title) ? 'T-Shirt' : null;
    const wanted = [...(config.defaultTags ?? []), ...(kind ? [kind.toLowerCase()] : [])];
    const change = {
      id: p.id,
      handle: p.handle,
      productType: kind && p.productType !== kind ? kind : null,
      addTags: wanted.filter((t) => !p.tags.includes(t)),
      alts: p.media.nodes
        .filter((m) => !m.alt && m.image?.url)
        .map((m) => ({ id: m.id, alt: `${p.title}${VIEW.test(m.image.url) ? `, ${m.image.url.match(VIEW)[1]} view` : ''}` })),
    };
    if (change.productType || change.addTags.length || change.alts.length) plan.push(change);
  }
  return plan;
}

export async function applyTidy(plan, shopify) {
  for (const c of plan) {
    if (c.productType) await shopify.setProductType(c.id, c.productType);
    if (c.addTags.length) await shopify.addTags(c.id, c.addTags);
    if (c.alts.length) await shopify.setAltText(c.alts);
  }
}
