import type { CheckResult, StockConfidence } from '../adapters/types.js';
import type { Watch, Retailer } from '../db/types.js';
import type { MarketPrice } from '../market/marketPrice.js';

/**
 * Discord embed renderer (PRD §14). Turns a normalized CheckResult into a
 * webhook payload: an embed plus a link-button row (View product / Add to cart /
 * Market listings). Link buttons need no interaction handling.
 */

const COLOR = {
  underThreshold: 0x2ecc71, // green
  aboveThreshold: 0xf1c40f, // amber
  queue: 0x3498db, // blue
  degraded: 0x95a5a6, // grey
} as const;

// Discord component constants.
const ACTION_ROW = 1;
const BUTTON = 2;
const LINK_STYLE = 5;

export interface WebhookPayload {
  embeds: unknown[];
  components?: unknown[];
}

function confidenceBadge(c: StockConfidence): string {
  switch (c) {
    case 'exact':
      return 'Exact';
    case 'inferred':
      return 'Inferred';
    case 'queue_gated':
      return 'Queue-gated';
    default:
      return 'Unknown';
  }
}

function money(n: number, currency = 'USD'): string {
  const symbol = currency === 'USD' ? '$' : '';
  return `${symbol}${n.toFixed(2)}`;
}

function linkButton(label: string, url: string) {
  return { type: BUTTON, style: LINK_STYLE, label, url };
}

function ebayMarketSearchUrl(query: string): string {
  return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}`;
}

/** Standard restock alert embed. */
export function buildRestockEmbed(
  watch: Watch,
  retailer: Retailer,
  result: CheckResult,
  market: MarketPrice | null,
): WebhookPayload {
  const name = result.name || watch.display_name || 'Item';
  const underThreshold =
    watch.threshold === null ||
    result.price === null ||
    result.price <= watch.threshold;

  const color = underThreshold ? COLOR.underThreshold : COLOR.aboveThreshold;

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];

  // Price.
  if (result.price !== null) {
    const tag = underThreshold ? '✅ under threshold' : '⚠️ above threshold';
    fields.push({ name: 'Price', value: `${money(result.price, result.currency)} (${tag})`, inline: true });
  } else {
    fields.push({ name: 'Price', value: 'unknown', inline: true });
  }

  // Stock.
  let stockText: string;
  if (result.confidence === 'exact' && result.stockQty !== null) {
    stockText = `${result.stockQty} in stock`;
  } else if (result.queue?.active) {
    stockText = 'Queue active';
  } else {
    stockText = result.inStock ? 'Available' : 'Out';
  }
  fields.push({ name: 'Stock', value: stockText, inline: true });

  // Confidence badge.
  fields.push({ name: 'Confidence', value: confidenceBadge(result.confidence), inline: true });

  // Market price + delta vs retail.
  if (market) {
    let value = `${money(market.value, market.currency)} (${market.source})`;
    if (result.price !== null) {
      const delta = market.value - result.price;
      const sign = delta >= 0 ? '+' : '−';
      value += `\nDelta vs retail: ${sign}${money(Math.abs(delta), market.currency)}`;
    }
    fields.push({ name: 'Market', value, inline: false });
  } else if (watch.tcg_sku) {
    fields.push({ name: 'Market', value: 'market price unavailable', inline: false });
  }

  // Retailer stamp (channel-implied, but stamped for cross-posting).
  fields.push({ name: 'Retailer', value: retailer.name, inline: true });

  const embed: Record<string, unknown> = {
    title: name.slice(0, 256),
    url: result.url,
    color,
    fields,
    timestamp: new Date().toISOString(),
    footer: { text: footerText(retailer, result) },
  };
  if (result.image) embed.thumbnail = { url: result.image };

  // Link-button row.
  const buttons = [linkButton('View product', result.url)];
  if (result.addToCartUrl) buttons.push(linkButton('Add to cart', result.addToCartUrl));
  const marketQuery = watch.tcg_sku ?? name;
  buttons.push(linkButton('Market listings', ebayMarketSearchUrl(marketQuery)));

  return {
    embeds: [embed],
    components: [{ type: ACTION_ROW, components: buttons }],
  };
}

/** Pokémon Center queue-live situational-awareness alert (PRD §14). */
export function buildQueueEmbed(
  watch: Watch,
  retailer: Retailer,
  result: CheckResult,
): WebhookPayload {
  const name = result.name || watch.display_name || 'Pokémon Center item';
  const position = result.queue?.position;
  const lines = [
    'A drop is happening. **Get in line manually** — the system does not enter the queue for you.',
  ];
  if (position !== undefined) lines.push(`Your reported queue position: **${position}**`);

  const embed: Record<string, unknown> = {
    title: '🔵 Pokémon Center queue is LIVE',
    description: lines.join('\n\n'),
    url: result.url,
    color: COLOR.queue,
    fields: [
      { name: 'Item', value: name.slice(0, 256), inline: false },
      { name: 'Retailer', value: retailer.name, inline: true },
      { name: 'Confidence', value: confidenceBadge(result.confidence), inline: true },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'Situational awareness — no auto-checkout, no queue bypass.' },
  };
  if (result.image) embed.thumbnail = { url: result.image };

  // No add-to-cart link; you must go through the queue yourself.
  return {
    embeds: [embed],
    components: [
      { type: ACTION_ROW, components: [linkButton('Open Pokémon Center', result.url)] },
    ],
  };
}

function footerText(retailer: Retailer, result: CheckResult): string {
  let text = `${retailer.name} • Sentinel`;
  if (result.error) text += ' • adapter degraded';
  return text;
}
