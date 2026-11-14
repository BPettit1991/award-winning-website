import { sleep } from './util.mjs';

/** Minimal Printful API v1 client for a store connected through the Shopify integration. */
export function createPrintful({ token, storeId, fetch = globalThis.fetch, pollMs = 5000 }) {
  if (!token) throw new Error('PRINTFUL_TOKEN is not set');

  async function api(method, path, body, attempt = 0) {
    const res = await fetch(`https://api.printful.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(storeId ? { 'X-PF-Store-Id': String(storeId) } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 429 && attempt < 6) {
      await sleep((Number(res.headers.get('retry-after')) || 30) * 1000 + 500);
      return api(method, path, body, attempt + 1);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`Printful ${method} ${path} -> ${res.status}: ${json.error?.message ?? json.result ?? res.statusText}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  return {
    api,

    async stores() {
      return (await api('GET', '/stores')).result;
    },

    async syncCount(status) {
      return (await api('GET', `/sync/products?status=${status}&limit=1`)).paging?.total ?? 0;
    },

    async listSyncProducts(status = 'all') {
      const all = [];
      for (let offset = 0; ; offset += 100) {
        const page = await api('GET', `/sync/products?status=${status}&limit=100&offset=${offset}`);
        all.push(...page.result);
        if (all.length >= (page.paging?.total ?? 0) || !page.result.length) return all;
      }
    },

    /** The sync product Printful imported for a Shopify product ID, or null if it has not been imported yet. */
    async getSyncProduct(shopifyProductId) {
      try {
        return (await api('GET', `/sync/products/@${shopifyProductId}`)).result;
      } catch (err) {
        if (err.status === 404) return null;
        throw err;
      }
    },

    /** Connects one imported variant to a catalogue variant and its print file. This is what makes it fulfillable. */
    async linkVariant(syncVariantId, { variantId, placement, artUrl }) {
      const type = placement === 'front' ? 'default' : placement;
      return (await api('PUT', `/sync/variant/${syncVariantId}`, { variant_id: variantId, files: [{ type, url: artUrl }] })).result;
    },

    async catalogProductId(variantId) {
      const { result } = await api('GET', `/products/variant/${variantId}`);
      return result.product?.id ?? result.variant?.product_id;
    },

    /** Generates mockups and returns [{ url, placement, variantIds, title }], print side first. */
    async mockups({ catalogProductId, variantIds, placement, artUrl, format, width }) {
      const { result: task } = await api('POST', `/mockup-generator/create-task/${catalogProductId}`, {
        variant_ids: variantIds,
        format,
        width,
        files: [{ placement, image_url: artUrl }],
      });
      for (let i = 0; i < 60; i++) {
        await sleep(pollMs);
        const { result } = await api('GET', `/mockup-generator/task?task_key=${encodeURIComponent(task.task_key)}`);
        if (result.status === 'failed') throw new Error(`Printful mockup task failed: ${result.error}`);
        if (result.status !== 'completed') continue;
        const out = [];
        for (const m of result.mockups ?? []) {
          if (m.mockup_url) out.push({ url: m.mockup_url, placement: m.placement, variantIds: m.variant_ids, title: m.placement });
          for (const x of m.extra ?? []) out.push({ url: x.url, placement: m.placement, variantIds: m.variant_ids, title: x.title ?? x.option });
        }
        return out.sort((a, b) => (b.placement === placement) - (a.placement === placement));
      }
      throw new Error('Timed out waiting for Printful mockups');
    },
  };
}
