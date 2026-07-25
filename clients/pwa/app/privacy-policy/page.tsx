import React from 'react';

const EFFECTIVE_DATE = 'June 22, 2026';
const ENTITY = 'Jay Wedgeworth, LLC d/b/a Congress.Trade';
const CONTACT = 'congress.trade@jays.services';

export default function PrivacyPolicy() {
  return (
    <main style={{ maxWidth: '820px', margin: '0 auto', padding: '32px 22px 64px' }}>
      <h1 style={{ fontSize: '26px', margin: '0 0 4px' }}>Privacy Policy</h1>
      <p style={{ color: 'var(--muted)', fontSize: '13px', margin: '0 0 28px' }}>Effective {EFFECTIVE_DATE}</p>

      <p>This Privacy Policy explains how {ENTITY} ("Congress.Trade," "we," "us") collects, uses, and shares personal information when you use the Congress.Trade website and services (the "Service").</p>

      <h2 style={{ fontSize: '17px', margin: '30px 0 8px', borderTop: '1px solid var(--border)', paddingTop: '22px' }}>1. Information we collect</h2>
      <ul style={{ paddingLeft: '20px' }}>
        <li style={{ margin: '5px 0' }}><strong>Account information</strong> — your email address, and (if you sign in with Google) your name, profile picture, and Google account identifier.</li>
        <li style={{ margin: '5px 0' }}><strong>Billing information</strong> — handled by Stripe. We receive subscription status and limited metadata (e.g., plan, period end, last 4 / brand are stored by Stripe, not us). <strong>We do not collect or store full payment-card numbers.</strong></li>
        <li style={{ margin: '5px 0' }}><strong>Usage &amp; technical data</strong> — IP address, device/browser type, pages viewed, and similar log data, used for security, analytics, and reliability.</li>
        <li style={{ margin: '5px 0' }}><strong>Communications</strong> — messages you send us (e.g., support email).</li>
      </ul>

      <h2 style={{ fontSize: '17px', margin: '30px 0 8px', borderTop: '1px solid var(--border)', paddingTop: '22px' }}>2. How we use information</h2>
      <ul style={{ paddingLeft: '20px' }}>
        <li style={{ margin: '5px 0' }}>To provide, maintain, and secure the Service and your account.</li>
        <li style={{ margin: '5px 0' }}>To process subscriptions, send transactional emails (e.g., sign-in links, receipts), and provide support.</li>
        <li style={{ margin: '5px 0' }}>To monitor, debug, and improve the Service and prevent abuse and fraud.</li>
        <li style={{ margin: '5px 0' }}>To comply with legal obligations and enforce our Terms.</li>
      </ul>

      <h2 style={{ fontSize: '17px', margin: '30px 0 8px', borderTop: '1px solid var(--border)', paddingTop: '22px' }}>3. Cookies</h2>
      <p>We use a small number of <strong>essential cookies</strong> (e.g., to keep you signed in). We do not use third-party advertising or cross-site tracking cookies. You can control cookies through your browser, but disabling essential cookies may break sign-in.</p>

      <h2 style={{ fontSize: '17px', margin: '30px 0 8px', borderTop: '1px solid var(--border)', paddingTop: '22px' }}>4. How we share information (service providers)</h2>
      <p>We do not sell your personal information. We share it only with providers that process it on our behalf to run the Service:</p>
      <ul style={{ paddingLeft: '20px' }}>
        <li style={{ margin: '5px 0' }}><strong>Stripe</strong> — payment processing and, where enabled, merchant-of-record billing.</li>
        <li style={{ margin: '5px 0' }}><strong>Cloudflare</strong> — hosting, content delivery, security, and email routing for our domain.</li>
        <li style={{ margin: '5px 0' }}><strong>Google</strong> — "Sign in with Google" authentication (only if you choose it).</li>
        <li style={{ margin: '5px 0' }}><strong>Resend</strong> — delivery of transactional emails (e.g., magic sign-in links).</li>
        <li style={{ margin: '5px 0' }}><strong>Financial Modeling Prep</strong> — market-data enrichment (we send ticker symbols, <em>not</em> your personal information).</li>
      </ul>
      <p>We may also disclose information to comply with law, respond to lawful requests, or protect our rights, users, and the public.</p>

      <h2 style={{ fontSize: '17px', margin: '30px 0 8px', borderTop: '1px solid var(--border)', paddingTop: '22px' }}>5. Data retention</h2>
      <p>We retain account and billing records for as long as your account is active and as needed for legal, accounting, and dispute-resolution purposes. You can request deletion as described below.</p>

      <h2 style={{ fontSize: '17px', margin: '30px 0 8px', borderTop: '1px solid var(--border)', paddingTop: '22px' }}>6. Your rights</h2>
      <p>Depending on where you live (e.g., under GDPR or the CCPA/CPRA), you may have rights to access, correct, delete, or port your personal information, and to object to or restrict certain processing. To exercise these rights, email <a href={`mailto:${CONTACT}`} style={{ color: 'var(--accent)', textDecoration: 'none' }}>{CONTACT}</a>. We will not discriminate against you for exercising them. Note that some payment records held by Stripe are retained by Stripe under its own policies and legal obligations.</p>

      <h2 style={{ fontSize: '17px', margin: '30px 0 8px', borderTop: '1px solid var(--border)', paddingTop: '22px' }}>7. Security</h2>
      <p>We use reasonable technical and organizational measures to protect personal information. No method of transmission or storage is 100% secure, and we cannot guarantee absolute security.</p>

      <h2 style={{ fontSize: '17px', margin: '30px 0 8px', borderTop: '1px solid var(--border)', paddingTop: '22px' }}>8. International users</h2>
      <p>We operate from the United States, and our providers may process data in the U.S. and other countries. By using the Service, you understand your information may be transferred to and processed in the United States.</p>

      <h2 style={{ fontSize: '17px', margin: '30px 0 8px', borderTop: '1px solid var(--border)', paddingTop: '22px' }}>9. Children</h2>
      <p>The Service is not directed to, and may not be used by, anyone under 18. We do not knowingly collect personal information from children.</p>

      <h2 style={{ fontSize: '17px', margin: '30px 0 8px', borderTop: '1px solid var(--border)', paddingTop: '22px' }}>10. Changes to this Policy</h2>
      <p>We may update this Policy from time to time. Material changes will be reflected by an updated effective date and, where appropriate, additional notice.</p>

      <h2 style={{ fontSize: '17px', margin: '30px 0 8px', borderTop: '1px solid var(--border)', paddingTop: '22px' }}>11. Contact</h2>
      <p>Questions about privacy or to exercise your rights: <a href={`mailto:${CONTACT}`} style={{ color: 'var(--accent)', textDecoration: 'none' }}>{CONTACT}</a>.</p>
    </main>
  );
}
