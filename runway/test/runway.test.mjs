import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPngInfo } from '../lib/png.mjs';
import { loadConfig, loadDrops, expandDesign, validateDrops } from '../lib/manifest.mjs';
import { createShopify } from '../lib/shopify.mjs';
import { createPrintful } from '../lib/printful.mjs';
import { syncDesign, releaseDrop, isDue, auditCatalogue, planTidy } from '../lib/pipeline.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = await loadConfig(ROOT);

/** A header-only PNG: enough for the validator, which never decodes pixels. */
function pngHeader(width, height, colorType = 6) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[24] = 8;
  b[25] = colorType;
  return b;
}

async function makeDrop(manifest, art = { 'art/a.png': pngHeader(3600, 4800) }) {
  const root = await mkdtemp(join(tmpdir(), 'runway-'));
  const path = join(root, 'drops', 'world-tour');
  await mkdir(join(path, 'art'), { recursive: true });
  await writeFile(join(path, 'drop.json'), JSON.stringify(manifest));
  for (const [name, bytes] of Object.entries(art)) await writeFile(join(path, name), bytes);
  return (await loadDrops(root))[0];
}

const design = { title: 'Rainbow Connection Encore Tee', blank: 'heavy-tee', color: 'Black', art: 'art/a.png', description: 'Encore.' };
const manifest = (designs = [design], extra = {}) => ({ collection: { title: 'World Tour' }, release: '2026-11-20', designs, ...extra });

test('png header is read without decoding', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'png-'));
  await writeFile(join(dir, 'a.png'), pngHeader(3600, 4800));
  await writeFile(join(dir, 'b.png'), pngHeader(100, 100, 2));
  await writeFile(join(dir, 'c.png'), 'not a png at all, just some text padding to 33+ bytes');
  assert.deepEqual(await readPngInfo(join(dir, 'a.png')), { width: 3600, height: 4800, hasAlpha: true, bytes: 33 });
  assert.equal((await readPngInfo(join(dir, 'b.png'))).hasAlpha, false);
  await assert.rejects(readPngInfo(join(dir, 'c.png')), /not a PNG/);
});

test('a design expands to the same shape as the existing store products', async () => {
  const drop = await makeDrop(manifest());
  const spec = expandDesign(design, drop, config);
  assert.equal(spec.handle, 'rainbow-connection-encore-tee');
  assert.deepEqual(spec.options, [{ name: 'Size', values: ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL'] }]);
  // IDs and weights as used by the live Comfort Colors 1717 black tees.
  assert.deepEqual(spec.variants[0], { color: 'Black', size: 'S', price: '39.00', sku: 'RW-RAINBOW-CONNECTION-ENCORE-TEE-S', grams: 159, printfulVariantId: 15114 });
  assert.equal(spec.variants.at(-1).printfulVariantId, 17500);
  assert.equal(spec.placement, 'back');
  assert.ok(spec.tags.includes('runway-pipeline') && spec.tags.includes('drop:world-tour'));
  assert.match(spec.descriptionHtml, /^<p>Encore\.<\/p><p>Built on Comfort Colors/);
});

test('several colours add a Color option and unique SKUs', async () => {
  const drop = await makeDrop(manifest());
  const spec = expandDesign({ ...design, blank: 'hoodie', colors: ['Black', 'Sport Grey'] }, drop, config);
  assert.deepEqual(spec.options.map((o) => o.name), ['Color', 'Size']);
  assert.equal(spec.variants.length, 16);
  assert.equal(new Set(spec.variants.map((v) => v.sku)).size, 16);
  assert.equal(spec.variants.find((v) => v.color === 'Sport Grey' && v.size === 'M').printfulVariantId, 5611);
});

test('validation catches the mistakes people actually make', async () => {
  const drop = await makeDrop(
    manifest(
      [
        design,
        { ...design, title: 'Rainbow Connection Encore Tee' },
        { ...design, title: 'B', blank: 'mug' },
        { ...design, title: 'C', color: 'Teal' },
        { ...design, title: 'D', art: 'art/missing.png' },
        { ...design, title: 'E', art: 'art/small.png' },
        { title: 'F', blank: 'heavy-tee' },
      ],
      { release: 'next friday' },
    ),
    { 'art/a.png': pngHeader(3600, 4800), 'art/small.png': pngHeader(900, 1200, 2) },
  );
  const { errors, warnings, specs } = await validateDrops([drop], config);
  const has = (list, re) => assert.ok(list.some((m) => re.test(m)), `expected ${re} in:\n${list.join('\n')}`);
  has(errors, /release "next friday"/);
  has(errors, /handle "rainbow-connection-encore-tee" is already used/);
  has(errors, /unknown blank "mug"/);
  has(errors, /no colour "Teal"/);
  has(errors, /missing\.png": file not found/);
  has(errors, /900px wide, minimum is 1800px/);
  has(errors, /"F" needs art/);
  has(warnings, /no alpha channel/);
  assert.equal(specs.length, 4);
});

test('the shipped template is valid apart from its placeholder art', async () => {
  const path = join(ROOT, 'drops', '_template');
  const drop = { slug: 'template', path, manifest: JSON.parse(await readFile(join(path, 'drop.json'), 'utf8')) };
  const { errors } = await validateDrops([drop], config, { checkArt: false });
  assert.deepEqual(errors, []);
});

test('release dates are judged in the store timezone', () => {
  const drop = { manifest: { release: '2026-11-20' } };
  // 19 Nov 14:00 UTC is already 20 Nov 01:00 in Sydney.
  assert.equal(isDue(drop, config, new Date('2026-11-19T14:00:00Z')), true);
  assert.equal(isDue(drop, config, new Date('2026-11-19T12:00:00Z')), false);
  assert.equal(isDue({ manifest: {} }, config), false);
});

test('shopify client exchanges credentials once and sends a productSet that cannot oversell or go live', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/admin/oauth/access_token')) return Response.json({ access_token: 'tok', scope: 'write_products', expires_in: 86399 });
    return Response.json({ data: { productSet: { product: { id: 'gid://shopify/Product/1' }, userErrors: [] } } });
  };
  const shopify = createShopify({ shop: 'example.myshopify.com', clientId: 'id', clientSecret: 'secret', apiVersion: '2026-10', fetch });
  const spec = expandDesign(design, await makeDrop(manifest()), config);
  await shopify.upsertProduct(spec, { create: true });
  await shopify.upsertProduct(spec, { create: false });

  assert.equal(calls.filter((c) => c.url.includes('oauth')).length, 1);
  assert.equal(String(calls[0].init.body), 'grant_type=client_credentials&client_id=id&client_secret=secret');
  assert.equal(calls[1].url, 'https://example.myshopify.com/admin/api/2026-10/graphql.json');
  assert.equal(calls[1].init.headers['X-Shopify-Access-Token'], 'tok');
  const { variables } = JSON.parse(calls[1].init.body);
  assert.deepEqual(variables.identifier, { handle: spec.handle });
  assert.equal(variables.input.status, 'DRAFT');
  assert.deepEqual(variables.input.variants[0], {
    optionValues: [{ optionName: 'Size', name: 'S' }],
    price: '39.00',
    sku: 'RW-RAINBOW-CONNECTION-ENCORE-TEE-S',
    taxable: true,
    inventoryPolicy: 'CONTINUE',
    inventoryItem: { tracked: false, requiresShipping: true, measurement: { weight: { value: 159, unit: 'GRAMS' } } },
  });
  assert.ok(!('files' in variables.input) && !('collections' in variables.input), 'list fields we do not manage must be left out');
  // Updates never touch status, so a live product stays live and a draft stays draft.
  assert.ok(!('status' in JSON.parse(calls[2].init.body).variables.input));
});

test('shopify userErrors and GraphQL errors surface as exceptions', async () => {
  const mk = (body) => createShopify({ shop: 'x', token: 't', apiVersion: '2026-10', fetch: async () => Response.json(body) });
  const spec = expandDesign(design, await makeDrop(manifest()), config);
  await assert.rejects(mk({ data: { productSet: { product: null, userErrors: [{ field: ['input', 'handle'], message: 'taken' }] } } }).upsertProduct(spec, { create: true }), /input\.handle taken/);
  await assert.rejects(mk({ errors: [{ message: 'Access denied' }] }).findProduct('x'), /Access denied/);
});

test('printful client: not-yet-imported is null, link body matches the sync API', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/sync/products/@')) return Response.json({ code: 404, error: { message: 'Not found' } }, { status: 404 });
    return Response.json({ code: 200, result: { id: 9, synced: true } });
  };
  const printful = createPrintful({ token: 'pf', storeId: 18833363, fetch });
  assert.equal(await printful.getSyncProduct('123'), null);
  await printful.linkVariant(9, { variantId: 15115, placement: 'back', artUrl: 'https://cdn/a.png' });
  await printful.linkVariant(10, { variantId: 4012, placement: 'front', artUrl: 'https://cdn/b.png' });
  assert.equal(calls[1].url, 'https://api.printful.com/sync/variant/9');
  assert.equal(calls[1].init.method, 'PUT');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer pf');
  assert.equal(calls[1].init.headers['X-PF-Store-Id'], '18833363');
  assert.deepEqual(JSON.parse(calls[1].init.body), { variant_id: 15115, files: [{ type: 'back', url: 'https://cdn/a.png' }] });
  assert.equal(JSON.parse(calls[2].init.body).files[0].type, 'default');
});

test('printful mockups are polled and returned print side first', async () => {
  let polls = 0;
  const fetch = async (url) => {
    if (url.includes('create-task/586')) return Response.json({ result: { task_key: 'k', status: 'pending' } });
    polls++;
    if (polls < 2) return Response.json({ result: { task_key: 'k', status: 'pending' } });
    return Response.json({
      result: {
        status: 'completed',
        mockups: [
          { placement: 'front', variant_ids: [15115], mockup_url: 'https://m/front.jpg' },
          { placement: 'back', variant_ids: [15115], mockup_url: 'https://m/back.jpg', extra: [{ title: 'Back 2', url: 'https://m/back2.jpg' }] },
        ],
      },
    });
  };
  const printful = createPrintful({ token: 'pf', fetch, pollMs: 1 });
  const out = await printful.mockups({ catalogProductId: 586, variantIds: [15115], placement: 'back', artUrl: 'https://cdn/a.png', format: 'jpg', width: 2000 });
  assert.deepEqual(out.map((m) => m.url), ['https://m/back.jpg', 'https://m/back2.jpg', 'https://m/front.jpg']);
});

/** In-memory stand-ins for both services, enough to exercise the pipeline's decisions. */
function fakes({ imported = true } = {}) {
  const state = { products: new Map(), sync: new Map(), links: [], media: [], published: [], uploads: 0, nextId: 100 };
  const shopify = {
    findProduct: async (handle) => state.products.get(handle) ?? null,
    upsertProduct: async (spec, { create }) => {
      const prev = state.products.get(spec.handle);
      const id = prev?.id ?? `gid://shopify/Product/${state.nextId++}`;
      const product = {
        id,
        handle: spec.handle,
        status: create ? 'DRAFT' : prev.status,
        tags: [...spec.tags, `rw-spec-${spec.hash}`],
        media: prev?.media ?? { nodes: [] },
        variants: { nodes: spec.variants.map((v, i) => ({ id: `gid://shopify/ProductVariant/${id.split('/').pop()}${i}`, sku: v.sku })) },
      };
      state.products.set(spec.handle, product);
      if (imported) {
        state.sync.set(id.split('/').pop(), {
          sync_variants: product.variants.nodes.map((v, i) => ({ id: 5000 + i, external_id: v.id.split('/').pop(), sku: v.sku, synced: false })),
        });
      }
      return product;
    },
    uploadArt: async () => { state.uploads++; return 'https://cdn.shopify.com/art.png'; },
    addMedia: async (id, media) => {
      state.media.push(...media);
      [...state.products.values()].find((p) => p.id === id).media.nodes.push(...media.map((m, i) => ({ id: `m${i}`, alt: m.alt })));
    },
    setStatus: async (id, status) => { [...state.products.values()].find((p) => p.id === id).status = status; },
    onlineStorePublicationId: async () => 'gid://shopify/Publication/1',
    publish: async (id) => { state.published.push(id); },
    ensureCollection: async () => ({ id: 'gid://shopify/Collection/7', created: false }),
  };
  const printful = {
    getSyncProduct: async (id) => state.sync.get(String(id)) ?? null,
    linkVariant: async (id, body) => { state.links.push({ id, ...body }); },
    catalogProductId: async () => 586,
    mockups: async () => [{ url: 'https://m/back.jpg', title: 'back' }, { url: 'https://m/front.jpg', title: 'Front' }],
  };
  return { state, ctx: { shopify, printful, config } };
}

async function oneSpec() {
  const drop = await makeDrop(manifest());
  const { specs } = await validateDrops([drop], config);
  return { drop, specs };
}

test('sync creates a draft, links every variant, adds mockups, and is a no-op the second time', async () => {
  const { drop, specs } = await oneSpec();
  const { state, ctx } = fakes();
  const first = await syncDesign(specs[0], ctx);
  assert.equal(first.shopify, 'created as draft');
  assert.equal(first.status, 'DRAFT');
  assert.equal(first.printfulReady, true);
  assert.equal(state.links.length, 7);
  assert.deepEqual(state.links[0], { id: 5000, variantId: 15114, placement: 'back', artUrl: 'https://cdn.shopify.com/art.png' });
  assert.equal(state.uploads, 1, 'art is uploaded once and reused for every variant and the mockups');
  assert.deepEqual(state.media.map((m) => m.alt), ['Rainbow Connection Encore Tee, back view', 'Rainbow Connection Encore Tee, front view']);

  const second = await syncDesign(specs[0], ctx);
  assert.equal(second.shopify, 'unchanged');
  assert.equal(state.links.length, 7);
  assert.equal(state.media.length, 2);
  assert.ok(drop);
});

test('sync waits when Printful has not imported the product, and release refuses to publish it', async () => {
  const { drop, specs } = await oneSpec();
  const { state, ctx } = fakes({ imported: false });
  const r = await syncDesign(specs[0], ctx);
  assert.match(r.printful, /waiting for Printful/);
  assert.ok(!r.printfulReady);
  const released = await releaseDrop(drop, specs, ctx);
  assert.match(released[0].blocked, /0\/7 variants linked/);
  assert.equal(state.products.get(specs[0].spec.handle).status, 'DRAFT');
  assert.deepEqual(state.published, []);
});

test('sync never overwrites a product it did not create', async () => {
  const { specs } = await oneSpec();
  const { state, ctx } = fakes();
  state.products.set(specs[0].spec.handle, { id: 'gid://shopify/Product/1', tags: [], status: 'ACTIVE', media: { nodes: [] }, variants: { nodes: [] } });
  await assert.rejects(syncDesign(specs[0], ctx), /was not created by this pipeline/);
  assert.equal(state.links.length, 0);
});

test('release publishes a ready design and its collection, once', async () => {
  const { drop, specs } = await oneSpec();
  const { state, ctx } = fakes();
  await syncDesign(specs[0], ctx);
  assert.deepEqual(await releaseDrop(drop, specs, ctx), [{ handle: specs[0].spec.handle, released: true }]);
  assert.equal(state.products.get(specs[0].spec.handle).status, 'ACTIVE');
  assert.deepEqual(state.published, ['gid://shopify/Product/100', 'gid://shopify/Collection/7']);
  assert.deepEqual(await releaseDrop(drop, specs, ctx), [{ handle: specs[0].spec.handle, live: true }]);
});

test('audit flags the gaps found on the live catalogue', () => {
  const findings = auditCatalogue(
    [
      { handle: 'riley-the-rainbow-hoodie', title: 'Riley the Rainbow Hoodie', product_type: 'T-SHIRT', tags: [], images: [{ alt: null }], variants: [{ sku: 'x' }], body_html: 'x'.repeat(300) },
      { handle: 'fine', title: 'Fine Tee', product_type: 'T-Shirt', tags: ['a'], images: [{ alt: 'Fine tee, back view' }], variants: [{ sku: 'y' }], body_html: 'x'.repeat(300) },
    ],
    [{ handle: 'frontpage' }, { handle: 'the-rainbow-crew-4' }],
  );
  assert.equal(findings.length, 6);
  assert.ok(findings.every((f) => !f.includes('fine')));
});

test('tidy plans metadata-only fixes and leaves pipeline products alone', () => {
  const img = (view, alt = null) => ({ id: `gid://shopify/MediaImage/${view}`, alt, image: { url: `https://cdn/files/unisex-heavy-blend-hoodie-white-${view}-6ac6.jpg?v=1` } });
  const plan = planTidy(
    [
      { id: 'p1', handle: 'riley-the-rainbow-hoodie', title: 'Riley the Rainbow Hoodie', productType: 'T-SHIRT', tags: [], media: { nodes: [img('front'), img('back', 'kept')] } },
      { id: 'p2', handle: 'ours', title: 'Ours Tee', productType: 'T-SHIRT', tags: ['runway-pipeline'], media: { nodes: [img('front')] } },
      { id: 'p3', handle: 'done', title: 'Done Tee', productType: 'T-Shirt', tags: ['rainbow-connections', 't-shirt'], media: { nodes: [img('front', 'x')] } },
    ],
    config,
  );
  assert.deepEqual(plan, [
    {
      id: 'p1',
      handle: 'riley-the-rainbow-hoodie',
      productType: 'Hoodie',
      addTags: ['rainbow-connections', 'hoodie'],
      alts: [{ id: 'gid://shopify/MediaImage/front', alt: 'Riley the Rainbow Hoodie, front view' }],
    },
  ]);
});
