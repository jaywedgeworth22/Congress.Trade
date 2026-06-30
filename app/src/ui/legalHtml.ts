/**
 * src/ui/legalHtml.ts
 * Static legal pages served at /terms-of-service and /privacy-policy.
 *
 * These satisfy Stripe's requirement that a publicly accessible Terms of Service
 * and Privacy Policy be linkable from Checkout (Public/Checkout settings). They
 * are good-faith templates tailored to Congress.Trade — have counsel review
 * before relying on them. Update EFFECTIVE_DATE when the text changes.
 */

const EFFECTIVE_DATE = 'June 22, 2026';
const ENTITY = 'Jay Wedgeworth, LLC d/b/a Congress.Trade';
const CONTACT = 'congress.trade@jays.services';

/** Wrap page body in the shared dark-theme shell. */
function shell(title: string, body: string): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} · Congress.Trade</title>
<style>
  :root{--bg:#0b1120;--bg2:#111a2e;--panel:#15203a;--border:#243154;--text:#e6edf6;--dim:#8da2c0;--accent:#4f8cff;--warn:#f59e0b;}
  *{box-sizing:border-box}
  body{margin:0;background:radial-gradient(1200px 600px at 70% -10%,var(--bg2),var(--bg));color:var(--text);
       font:15px/1.65 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;}
  header{display:flex;align-items:center;gap:14px;padding:16px 22px;border-bottom:1px solid var(--border);
         background:rgba(10,16,30,.6);position:sticky;top:0;backdrop-filter:blur(8px)}
  .brand{font-weight:700;font-size:16px}.brand .dot{color:var(--accent)}
  a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
  main{max-width:820px;margin:0 auto;padding:32px 22px 64px}
  h1{font-size:26px;margin:0 0 4px}.eff{color:var(--dim);font-size:13px;margin:0 0 28px}
  h2{font-size:17px;margin:30px 0 8px;border-top:1px solid var(--border);padding-top:22px}
  p,li{color:#cdd8ea}strong{color:var(--text)}
  ul{padding-left:20px}li{margin:5px 0}
  .callout{border:1px solid color-mix(in srgb,var(--warn) 45%,transparent);
           background:color-mix(in srgb,var(--warn) 9%,transparent);border-radius:10px;padding:14px 16px;margin:18px 0}
  .callout strong{color:var(--warn)}
  footer{color:var(--dim);font-size:12px;border-top:1px solid var(--border);padding:22px;text-align:center}
  code{background:var(--bg);padding:1px 6px;border-radius:5px;font-size:13px;color:var(--accent)}
</style>
</head>
<body>
<header><a class="brand" href="/">Congress<span class="dot">.</span>Trade</a></header>
<main>
${body}
<p style="margin-top:36px"><a href="/">&larr; Back to Congress.Trade</a></p>
</main>
<footer>Congress.Trade · an educational tool for exploring public STOCK Act (2012) disclosures · informational only — not financial advice, not trading signals · dollar figures are estimates from disclosed brackets</footer>
</body>
</html>`;
}

export const TOS_HTML = shell(
  'Terms of Service',
  /* html */ `
<h1>Terms of Service</h1>
<p class="eff">Effective ${EFFECTIVE_DATE}</p>

<p>These Terms of Service ("Terms") are a binding agreement between you and ${ENTITY} ("Congress.Trade," "we," "us"), governing your access to and use of the Congress.Trade website, API, data feeds, and related services (the "Service"). By creating an account, subscribing, or otherwise using the Service, you agree to these Terms. If you do not agree, do not use the Service.</p>

<h2>1. What the Service is</h2>
<p>Congress.Trade aggregates and presents <strong>public financial-disclosure data</strong> filed by politicians serving in the U.S. Congress under the STOCK Act (2012), and provides tools to explore, analyze, and receive that data (including webhook and SSE delivery). It is an <strong>informational and educational</strong> product.</p>

<div class="callout">
<strong>Not financial advice.</strong> The Service is for informational and educational purposes only. Nothing on Congress.Trade is investment, financial, legal, or tax advice, a recommendation, an offer or solicitation to buy or sell any security, or a "trading signal." We are not a broker-dealer, investment adviser, or fiduciary, and no advisory relationship is created by your use of the Service. Disclosure data is sourced from third parties and public filings, may be delayed, incomplete, or inaccurate, and <strong>dollar amounts are estimates derived from the disclosed value brackets</strong>. Always do your own research and consult a licensed professional before making any financial decision. You are solely responsible for your decisions and any resulting gains or losses.
</div>

<h2>2. Eligibility &amp; accounts</h2>
<ul>
<li>You must be at least 18 years old and able to form a binding contract.</li>
<li>You are responsible for the accuracy of your account information and for safeguarding your sign-in. Notify us promptly at <a href="mailto:${CONTACT}">${CONTACT}</a> of any unauthorized use.</li>
<li>You are responsible for all activity under your account.</li>
</ul>

<h2>3. Subscriptions, billing &amp; trials</h2>
<ul>
<li>Premium is offered as an auto-renewing subscription: <strong>$15.00 / month</strong> or <strong>$140.00 / year</strong> (USD), plus any applicable taxes.</li>
<li>New subscriptions may include a free trial (currently 7 days). If you do not cancel before the trial ends, the subscription renews and your payment method is charged.</li>
<li>Subscriptions <strong>automatically renew</strong> at the end of each billing period until canceled. You authorize recurring charges to your payment method.</li>
<li>We may change prices or plan features; changes apply to the next billing period after reasonable notice. Continued use after a price change constitutes acceptance.</li>
</ul>

<h2>4. Cancellation &amp; refunds</h2>
<ul>
<li>You may cancel at any time from your account / billing portal. Cancellation stops future renewals; you retain access through the end of the current paid period.</li>
<li>Because the Service is a <strong>digital product delivered immediately</strong>, payments are generally <strong>non-refundable</strong> except where required by law or as expressly granted by us or the payment processor.</li>
<li>Where Stripe acts as merchant of record (see §5), Stripe may issue refunds within its own policy windows (e.g., to resolve disputes).</li>
</ul>

<h2>5. Payments &amp; merchant of record</h2>
<p>Payments are processed by <strong>Stripe</strong>. We do not collect or store full payment-card details. Where <strong>Stripe Managed Payments</strong> is enabled, Stripe (via its Link entity) acts as the <strong>merchant of record</strong> for your purchase and is responsible for charging, billing receipts, applicable sales tax/VAT, and certain transaction support. Your purchase is also subject to Stripe's applicable terms.</p>

<h2>6. Acceptable use</h2>
<p>You agree not to: (a) scrape, crawl, or bulk-extract the Service except through interfaces we provide; (b) resell, sublicense, or publicly redistribute the data or feeds except as expressly permitted; (c) exceed published rate limits or interfere with the Service's operation or security; (d) reverse engineer or attempt unauthorized access; or (e) use the Service unlawfully or to violate any third party's rights.</p>

<h2>7. Intellectual property</h2>
<p>The underlying congressional disclosures are public records. The Service's software, design, compilation, enrichment, and analytics are owned by us or our licensors. Subject to these Terms, we grant you a limited, non-exclusive, non-transferable right to use the Service for your personal or internal business purposes.</p>

<h2>8. Third-party data &amp; services</h2>
<p>The Service relies on third-party sources and providers (including U.S. House/Senate disclosure systems and market-data vendors). We do not control and are not responsible for the accuracy, availability, or content of third-party data or websites.</p>

<h2>9. Disclaimers</h2>
<p>THE SERVICE AND ALL DATA ARE PROVIDED "AS IS" AND "AS AVAILABLE," WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, ACCURACY, AND NON-INFRINGEMENT. We do not warrant that the Service will be uninterrupted, timely, secure, or error-free, or that data is accurate or complete.</p>

<h2>10. Limitation of liability</h2>
<p>TO THE MAXIMUM EXTENT PERMITTED BY LAW, ${ENTITY} AND ITS OWNERS WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR EXEMPLARY DAMAGES, OR FOR ANY LOST PROFITS OR TRADING/INVESTMENT LOSSES, ARISING FROM OR RELATED TO THE SERVICE. OUR TOTAL LIABILITY FOR ANY CLAIM WILL NOT EXCEED THE GREATER OF (a) THE AMOUNTS YOU PAID US IN THE 12 MONTHS BEFORE THE CLAIM, OR (b) USD $100.</p>

<h2>11. Indemnification</h2>
<p>You agree to indemnify and hold harmless ${ENTITY} from claims and expenses arising out of your use of the Service or violation of these Terms.</p>

<h2>12. Termination</h2>
<p>We may suspend or terminate your access for violation of these Terms or to protect the Service. You may stop using the Service at any time. Sections that by their nature should survive (e.g., disclaimers, limitation of liability) survive termination.</p>

<h2>13. Changes to these Terms</h2>
<p>We may update these Terms from time to time. Material changes will be reflected by an updated effective date and, where appropriate, additional notice. Continued use after changes take effect constitutes acceptance.</p>

<h2>14. Governing law</h2>
<p>These Terms are governed by the laws of the State of Texas, USA, without regard to conflict-of-laws rules. The exclusive venue for disputes is the state and federal courts located in Harris County, Texas, and you consent to their jurisdiction.</p>

<h2>15. Contact</h2>
<p>Questions about these Terms: <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>
`,
);

export const PRIVACY_HTML = shell(
  'Privacy Policy',
  /* html */ `
<h1>Privacy Policy</h1>
<p class="eff">Effective ${EFFECTIVE_DATE}</p>

<p>This Privacy Policy explains how ${ENTITY} ("Congress.Trade," "we," "us") collects, uses, and shares personal information when you use the Congress.Trade website and services (the "Service").</p>

<h2>1. Information we collect</h2>
<ul>
<li><strong>Account information</strong> — your email address, and (if you sign in with Google) your name, profile picture, and Google account identifier.</li>
<li><strong>Billing information</strong> — handled by Stripe. We receive subscription status and limited metadata (e.g., plan, period end, last 4 / brand are stored by Stripe, not us). <strong>We do not collect or store full payment-card numbers.</strong></li>
<li><strong>Usage &amp; technical data</strong> — IP address, device/browser type, pages viewed, and similar log data, used for security, analytics, and reliability.</li>
<li><strong>Communications</strong> — messages you send us (e.g., support email).</li>
</ul>

<h2>2. How we use information</h2>
<ul>
<li>To provide, maintain, and secure the Service and your account.</li>
<li>To process subscriptions, send transactional emails (e.g., sign-in links, receipts), and provide support.</li>
<li>To monitor, debug, and improve the Service and prevent abuse and fraud.</li>
<li>To comply with legal obligations and enforce our Terms.</li>
</ul>

<h2>3. Cookies</h2>
<p>We use a small number of <strong>essential cookies</strong> (e.g., to keep you signed in). We do not use third-party advertising or cross-site tracking cookies. You can control cookies through your browser, but disabling essential cookies may break sign-in.</p>

<h2>4. How we share information (service providers)</h2>
<p>We do not sell your personal information. We share it only with providers that process it on our behalf to run the Service:</p>
<ul>
<li><strong>Stripe</strong> — payment processing and, where enabled, merchant-of-record billing.</li>
<li><strong>Cloudflare</strong> — hosting, content delivery, security, and email routing for our domain.</li>
<li><strong>Google</strong> — "Sign in with Google" authentication (only if you choose it).</li>
<li><strong>Resend</strong> — delivery of transactional emails (e.g., magic sign-in links).</li>
<li><strong>Financial Modeling Prep</strong> — market-data enrichment (we send ticker symbols, <em>not</em> your personal information).</li>
</ul>
<p>We may also disclose information to comply with law, respond to lawful requests, or protect our rights, users, and the public.</p>

<h2>5. Data retention</h2>
<p>We retain account and billing records for as long as your account is active and as needed for legal, accounting, and dispute-resolution purposes. You can request deletion as described below.</p>

<h2>6. Your rights</h2>
<p>Depending on where you live (e.g., under GDPR or the CCPA/CPRA), you may have rights to access, correct, delete, or port your personal information, and to object to or restrict certain processing. To exercise these rights, email <a href="mailto:${CONTACT}">${CONTACT}</a>. We will not discriminate against you for exercising them. Note that some payment records held by Stripe are retained by Stripe under its own policies and legal obligations.</p>

<h2>7. Security</h2>
<p>We use reasonable technical and organizational measures to protect personal information. No method of transmission or storage is 100% secure, and we cannot guarantee absolute security.</p>

<h2>8. International users</h2>
<p>We operate from the United States, and our providers may process data in the U.S. and other countries. By using the Service, you understand your information may be transferred to and processed in the United States.</p>

<h2>9. Children</h2>
<p>The Service is not directed to, and may not be used by, anyone under 18. We do not knowingly collect personal information from children.</p>

<h2>10. Changes to this Policy</h2>
<p>We may update this Policy from time to time. Material changes will be reflected by an updated effective date and, where appropriate, additional notice.</p>

<h2>11. Contact</h2>
<p>Questions about privacy or to exercise your rights: <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>
`,
);
