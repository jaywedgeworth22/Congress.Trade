import React from 'react';

const EFFECTIVE_DATE = 'June 22, 2026';
const ENTITY = 'Jay Wedgeworth, LLC d/b/a Congress.Trade';
const CONTACT = 'congress.trade@jays.services';

export default function TermsOfService() {
  return (
    <main style={{ maxWidth: '820px', margin: '0 auto', padding: '32px 22px 64px' }}>
      <h1 style={{ fontSize: '26px', margin: '0 0 4px' }}>Terms of Service</h1>
      <p style={{ color: 'var(--muted)', fontSize: '13px', margin: '0 0 28px' }}>Effective {EFFECTIVE_DATE}</p>

      <p>These Terms of Service ("Terms") are a binding agreement between you and {ENTITY} ("Congress.Trade," "we," "us"), governing your access to and use of the Congress.Trade website, API, data feeds, and related services (the "Service"). By creating an account, subscribing, or otherwise using the Service, you agree to these Terms. If you do not agree, do not use the Service.</p>

      <h2 style={{ fontSize: '17px', margin: '30px 0 8px', borderTop: '1px solid var(--border)', paddingTop: '22px' }}>1. What the Service is</h2>
      <p>Congress.Trade aggregates and presents <strong>public financial-disclosure data</strong> filed by politicians serving in the U.S. Congress under the STOCK Act (2012), and provides tools to explore, analyze, and receive that data (including webhook and SSE delivery). It is an <strong>informational and educational</strong> product.</p>

      <div style={{ border: '1px solid color-mix(in srgb, var(--buy) 45%, transparent)', background: 'color-mix(in srgb, var(--buy) 9%, transparent)', borderRadius: '10px', padding: '14px 16px', margin: '18px 0' }}>
        <strong style={{ color: 'var(--buy)' }}>Not financial advice.</strong> The Service is for informational and educational purposes only. Nothing on Congress.Trade is investment, financial, legal, or tax advice, a recommendation, an offer or solicitation to buy or sell any security, or a "trading signal." We are not a broker-dealer, investment adviser, or fiduciary, and no advisory relationship is created by your use of the Service. Disclosure data is sourced from third parties and public filings, may be delayed, incomplete, or inaccurate, and <strong>dollar amounts are estimates derived from the disclosed value brackets</strong>. Always do your own research and consult a licensed professional before making any financial decision. You are solely responsible for your decisions and any resulting gains or losses.
      </div>

      <h2 style={{ fontSize: '17px', margin: '30px 0 8px', borderTop: '1px solid var(--border)', paddingTop: '22px' }}>2. Eligibility &amp; accounts</h2>
      <ul style={{ paddingLeft: '20px' }}>
        <li style={{ margin: '5px 0' }}>You must be at least 18 years old and able to form a binding contract.</li>
        <li style={{ margin: '5px 0' }}>You are responsible for the accuracy of your account information and for safeguarding your sign-in. Notify us promptly at <a href={`mailto:${CONTACT}`} style={{ color: 'var(--accent)', textDecoration: 'none' }}>{CONTACT}</a> of any unauthorized use.</li>
        <li style={{ margin: '5px 0' }}>You are responsible for all activity under your account.</li>
      </ul>

      <h2 style={{ fontSize: '17px', margin: '30px 0 8px', borderTop: '1px solid var(--border)', paddingTop: '22px' }}>3. Subscriptions, billing &amp; trials</h2>
      <ul style={{ paddingLeft: '20px' }}>
        <li style={{ margin: '5px 0' }}>Premium is offered as an auto-renewing subscription: <strong>$15.00 / month</strong> or <strong>$140.00 / year</strong> (USD), plus any applicable taxes.</li>
        <li style={{ margin: '5px 0' }}>New subscriptions may include a free trial (currently 7 days). If you do not cancel before the trial ends, the subscription renews and your payment method is charged.</li>
        <li style={{ margin: '5px 0' }}>Subscriptions <strong>automatically renew</strong> at the end of each billing period until canceled. You authorize recurring charges to your payment method.</li>
        <li style={{ margin: '5px 0' }}>We may change prices or plan features; changes apply to the next billing period after reasonable notice. Continued use after a price change constitutes acceptance.</li>
      </ul>

      <h2 style={{ fontSize: '17px', margin: '30px 0 8px', borderTop: '1px solid var(--border)', paddingTop: '22px' }}>4. Cancellation &amp; refunds</h2>
      <ul style={{ paddingLeft: '20px' }}>
        <li style={{ margin: '5px 0' }}>You may cancel at any time from your account / billing portal. Cancellation stops future renewals; you retain access through the end of the current paid period.</li>
        <li style={{ margin: '5px 0' }}>Because the Service is a <strong>digital product delivered immediately</strong>, payments are generally <strong>non-refundable</strong> except where required by law or as expressly granted by us or the payment processor.</li>
        <li style={{ margin: '5px 0' }}>Where Stripe acts as merchant of record (see §5), Stripe may issue refunds within its own policy windows (e.g., to resolve disputes).</li>
      </ul>

      <h2 style={{ fontSize: '17px', margin: '30px 0 8px', borderTop: '1px solid var(--border)', paddingTop: '22px' }}>5. Payments &amp; merchant of record</h2>
      <p>Payments are processed by <strong>Stripe</strong>. We do not collect or store full payment-card details. Where <strong>Stripe Managed Payments</strong> is enabled, Stripe (via its Link entity) acts as the <strong>merchant of record</strong> for your purchase and is responsible for charging, billing receipts, applicable sales tax/VAT, and certain transaction support. Your purchase is also subject to Stripe's applicable terms.</p>

      <h2 style={{ fontSize: '17px', margin: '30px 0 8px', borderTop: '1px solid var(--border)', paddingTop: '22px' }}>6. Acceptable use</h2>
      <p>You agree not to: (a) scrape, crawl, or bulk-extract the Service except through interfaces we provide; (b) resell, sublicense, or publicly redistribute the data or feeds except as expressly permitted; (c) exceed published rate limits or interfere with the Service's operation or security; (d) reverse engineer or attempt unauthorized access; or (e) use the Service unlawfully or to violate any third party's rights.</p>

      <h2 style={{ fontSize: '17px', margin: '30px 0 8px', borderTop: '1px solid var(--border)', paddingTop: '22px' }}>7. Intellectual property</h2>
      <p>The underlying congressional disclosures are public records. The Service's software, design, compilation, enrichment, and analytics are owned by us or our licensors. Subject to these Terms, we grant you a limited, non-exclusive, non-transferable right to use the Service for your personal or internal business purposes.</p>

      <h2 style={{ fontSize: '17px', margin: '30px 0 8px', borderTop: '1px solid var(--border)', paddingTop: '22px' }}>8. Third-party data &amp; services</h2>
      <p>The Service relies on third-party sources and providers (including U.S. House/Senate disclosure systems and market-data vendors). We do not control and are not responsible for the accuracy, availability, or content of third-party data or websites.</p>

      <h2 style={{ fontSize: '17px', margin: '30px 0 8px', borderTop: '1px solid var(--border)', paddingTop: '22px' }}>9. Disclaimers</h2>
      <p>THE SERVICE AND ALL DATA ARE PROVIDED "AS IS" AND "AS AVAILABLE," WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, ACCURACY, AND NON-INFRINGEMENT. We do not warrant that the Service will be uninterrupted, timely, secure, or error-free, or that data is accurate or complete.</p>

      <h2 style={{ fontSize: '17px', margin: '30px 0 8px', borderTop: '1px solid var(--border)', paddingTop: '22px' }}>10. Limitation of liability</h2>
      <p>TO THE MAXIMUM EXTENT PERMITTED BY LAW, {ENTITY} AND ITS OWNERS WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR EXEMPLARY DAMAGES, OR FOR ANY LOST PROFITS OR TRADING/INVESTMENT LOSSES, ARISING FROM OR RELATED TO THE SERVICE. OUR TOTAL LIABILITY FOR ANY CLAIM WILL NOT EXCEED THE GREATER OF (a) THE AMOUNTS YOU PAID US IN THE 12 MONTHS BEFORE THE CLAIM, OR (b) USD $100.</p>

      <h2 style={{ fontSize: '17px', margin: '30px 0 8px', borderTop: '1px solid var(--border)', paddingTop: '22px' }}>11. Indemnification</h2>
      <p>You agree to indemnify and hold harmless {ENTITY} from claims and expenses arising out of your use of the Service or violation of these Terms.</p>

      <h2 style={{ fontSize: '17px', margin: '30px 0 8px', borderTop: '1px solid var(--border)', paddingTop: '22px' }}>12. Termination</h2>
      <p>We may suspend or terminate your access for violation of these Terms or to protect the Service. You may stop using the Service at any time. Sections that by their nature should survive (e.g., disclaimers, limitation of liability) survive termination.</p>

      <h2 style={{ fontSize: '17px', margin: '30px 0 8px', borderTop: '1px solid var(--border)', paddingTop: '22px' }}>13. Changes to these Terms</h2>
      <p>We may update these Terms from time to time. Material changes will be reflected by an updated effective date and, where appropriate, additional notice. Continued use after changes take effect constitutes acceptance.</p>

      <h2 style={{ fontSize: '17px', margin: '30px 0 8px', borderTop: '1px solid var(--border)', paddingTop: '22px' }}>14. Governing law</h2>
      <p>These Terms are governed by the laws of the State of Texas, USA, without regard to conflict-of-laws rules. The exclusive venue for disputes is the state and federal courts located in Harris County, Texas, and you consent to their jurisdiction.</p>

      <h2 style={{ fontSize: '17px', margin: '30px 0 8px', borderTop: '1px solid var(--border)', paddingTop: '22px' }}>15. Contact</h2>
      <p>Questions about these Terms: <a href={`mailto:${CONTACT}`} style={{ color: 'var(--accent)', textDecoration: 'none' }}>{CONTACT}</a>.</p>
    </main>
  );
}
