import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../../../..');
const iosRoot = join(repoRoot, 'clients/ios');

const FORBIDDEN_WEB_CHECKOUT = [
  /Or subscribe on Congress\.Trade/,
  /subscribe on the website/i,
  /Open Congress\.Trade pricing/,
  /var upgradeURL/,
  /\/billing\/checkout/,
  /start_checkout/,
];

function listSwiftFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSwiftFiles(path));
      continue;
    }
    if (entry.name.endsWith('.swift')) out.push(path);
  }
  return out;
}

describe('iOS digital-goods checkout (Guideline 3.1.1)', () => {
  const swiftFiles = listSwiftFiles(iosRoot);

  it('has no in-app Stripe / web checkout path for Premium', () => {
    const hits: string[] = [];
    for (const file of swiftFiles) {
      const source = readFileSync(file, 'utf8');
      for (const pattern of FORBIDDEN_WEB_CHECKOUT) {
        if (pattern.test(source)) {
          hits.push(`${relative(repoRoot, file)} matches ${pattern}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('keeps StoreKit restore and Apple redeem, and forbids web checkout', () => {
    const api = readFileSync(join(iosRoot, 'CongressTrade/APIClient.swift'), 'utf8');
    const premium = readFileSync(join(iosRoot, 'CongressTrade/Views/Status/PremiumSheet.swift'), 'utf8');
    const delivery = readFileSync(join(iosRoot, 'CongressTrade/Views/Delivery/DeliveryView.swift'), 'utf8');
    const tests = readFileSync(join(iosRoot, 'CongressTradeTests/CongressTradeTests.swift'), 'utf8');

    expect(api).toContain('enum DigitalGoodsCheckout');
    expect(api).toContain('static let allowsWebCheckout = false');
    expect(api).toContain('func redeemApplePurchase');
    expect(api).toContain('func billingPortalURL');

    expect(premium).toContain('PremiumPricing.emptyCatalogMessage');
    expect(premium).toContain('restoreButton');
    expect(premium).toContain('product.purchase()');
    expect(premium).not.toContain('Link(');

    expect(delivery).toContain('PremiumPricing.deliveryUpgradeMessage');
    expect(delivery).toContain('Subscribe with Apple');
    expect(delivery).not.toContain('systemImage: "safari"');

    expect(tests).toContain('testIOSNeverOffersWebCheckoutForDigitalGoods');
  });

  it('never Safari-opens /pricing from the legal footer', () => {
    const components = readFileSync(
      join(iosRoot, 'CongressTrade/Views/Components/Components.swift'),
      'utf8',
    );
    expect(components).toContain('static func opensSafari');
    expect(components).toContain('destination.id != "pricing"');
    expect(components).toContain('canOpenInAppPurchase');
    expect(components).toContain('Never fall through to Safari /pricing');
  });
});
