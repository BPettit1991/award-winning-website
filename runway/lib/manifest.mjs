import { readFile, readdir, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readPngInfo } from './png.mjs';
import { slugify, sha8 } from './util.mjs';

const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'];
const isUrl = (s) => /^https:\/\//.test(s);

export async function loadConfig(root) {
  return JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
}

/** Loads every drop under drops/ (folders starting with "_" are templates and are skipped). */
export async function loadDrops(root, only) {
  const dir = join(root, 'drops');
  const entries = await readdir(dir, { withFileTypes: true });
  const drops = [];
  for (const e of entries.filter((e) => e.isDirectory() && !e.name.startsWith('_')).sort((a, b) => a.name.localeCompare(b.name))) {
    if (only && e.name !== only) continue;
    const path = join(dir, e.name);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(path, 'drop.json'), 'utf8'));
    } catch (err) {
      manifest = { __error: `drop.json: ${err.message}` };
    }
    drops.push({ slug: e.name, path, manifest });
  }
  if (only && !drops.length) throw new Error(`No drop named "${only}" in ${dir}`);
  return drops;
}

/** Turns one design entry into the full product spec the pipeline pushes to Shopify and Printful. */
export function expandDesign(design, drop, config) {
  const blank = config.blanks[design.blank];
  if (!blank) throw new Error(`unknown blank "${design.blank}" (have: ${Object.keys(config.blanks).join(', ')})`);
  const colors = design.colors ?? (design.color ? [design.color] : Object.keys(blank.printful).slice(0, 1));
  for (const c of colors) if (!blank.printful[c]) throw new Error(`blank "${design.blank}" has no colour "${c}" (have: ${Object.keys(blank.printful).join(', ')})`);
  const handle = design.handle ?? slugify(design.title);
  const price = design.price ?? blank.price;
  const multi = colors.length > 1;
  const variants = [];
  for (const color of colors) {
    const sizes = Object.keys(blank.printful[color]).sort((a, b) => SIZE_ORDER.indexOf(a) - SIZE_ORDER.indexOf(b));
    for (const size of design.sizes ? sizes.filter((s) => design.sizes.includes(s)) : sizes) {
      variants.push({
        color,
        size,
        price,
        sku: `RW-${handle}-${multi ? slugify(color) + '-' : ''}${size}`.toUpperCase(),
        grams: blank.grams[size],
        printfulVariantId: blank.printful[color][size],
      });
    }
  }
  const options = [
    ...(multi ? [{ name: 'Color', values: colors }] : []),
    { name: 'Size', values: [...new Set(variants.map((v) => v.size))] },
  ];
  const description = design.description ?? '';
  const descriptionHtml = `${/^\s*</.test(description) ? description : `<p>${description}</p>`}${blank.blurbHtml ?? ''}`;
  const spec = {
    handle,
    title: design.title,
    descriptionHtml,
    vendor: config.vendor,
    productType: blank.productType,
    tags: [...new Set([config.ownerTag, `drop:${drop.slug}`, ...(config.defaultTags ?? []), ...(design.tags ?? [])])],
    seo: design.seo,
    options,
    variants,
    colors,
    multiColor: multi,
    blank: design.blank,
    placement: design.placement ?? blank.placement,
    art: design.art,
    artIsUrl: isUrl(design.art ?? ''),
    artPath: design.art && !isUrl(design.art) ? resolve(drop.path, design.art) : null,
  };
  // Changes to anything customer-facing or print-affecting change the hash, which triggers an update.
  spec.hash = sha8(JSON.stringify([spec.title, descriptionHtml, spec.tags, spec.seo, variants, spec.placement, spec.art, design.artVersion]));
  return spec;
}

/** Offline checks. Returns { errors, warnings, specs }. Errors block the pipeline, warnings do not. */
export async function validateDrops(drops, config, { checkArt = true } = {}) {
  const errors = [];
  const warnings = [];
  const specs = [];
  const seen = new Map();
  for (const drop of drops) {
    const at = (msg) => `${drop.slug}: ${msg}`;
    const m = drop.manifest;
    if (m.__error) { errors.push(at(m.__error)); continue; }
    if (drop.slug !== slugify(drop.slug)) errors.push(at('folder name must be lowercase letters, numbers and hyphens'));
    if (m.release && !/^\d{4}-\d{2}-\d{2}$/.test(m.release)) errors.push(at(`release "${m.release}" must be YYYY-MM-DD`));
    if (!m.collection?.title) errors.push(at('collection.title is required'));
    if (!Array.isArray(m.designs) || !m.designs.length) { errors.push(at('designs must be a non-empty list')); continue; }
    for (const [i, design] of m.designs.entries()) {
      const where = (msg) => at(`designs[${i}] ${design.title ? `"${design.title}" ` : ''}${msg}`);
      if (!design.title) { errors.push(where('needs a title')); continue; }
      if (!design.art) { errors.push(where('needs art (a PNG path inside the drop folder, or an https URL)')); continue; }
      if (!design.description) warnings.push(where('has no description'));
      let spec;
      try { spec = expandDesign(design, drop, config); } catch (err) { errors.push(where(err.message)); continue; }
      if (!spec.variants.length) { errors.push(where('produces no variants')); continue; }
      if (seen.has(spec.handle)) errors.push(where(`handle "${spec.handle}" is already used by ${seen.get(spec.handle)}`));
      seen.set(spec.handle, `${drop.slug} "${design.title}"`);
      if (spec.artPath && checkArt) {
        try {
          await access(spec.artPath);
          const png = await readPngInfo(spec.artPath);
          const a = config.art;
          if (png.width < a.minWidth) errors.push(where(`art is ${png.width}px wide, minimum is ${a.minWidth}px`));
          else if (png.width < a.idealWidth) warnings.push(where(`art is ${png.width}px wide; ${a.idealWidth}px or more prints sharper`));
          if (!png.hasAlpha) warnings.push(where('art has no alpha channel, so the background will print as a solid box'));
          if (Math.abs(png.width / png.height - a.aspect) > a.aspectTolerance) warnings.push(where(`art is ${png.width}x${png.height}; the print area is ${a.aspect.toFixed(2)} wide:tall, so Printful will letterbox it`));
          if (png.bytes > a.maxBytes) errors.push(where(`art is ${(png.bytes / 1e6).toFixed(1)}MB, over the ${a.maxBytes / 1e6}MB upload limit`));
        } catch (err) {
          errors.push(where(`art "${design.art}": ${err.code === 'ENOENT' ? 'file not found' : err.message}`));
        }
      }
      specs.push({ drop, design, spec });
    }
  }
  return { errors, warnings, specs };
}
