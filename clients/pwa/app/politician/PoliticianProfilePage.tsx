'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { normalizeProfileQueryValue } from '../../lib/profileRoutes';
import PoliticianProfile from '../ui/PoliticianProfile';

export default function PoliticianProfilePage() {
  const searchParams = useSearchParams();
  const slug = normalizeProfileQueryValue(searchParams.get('slug'));

  if (!slug) {
    return (
      <div className="app-shell" style={{ padding: '24px', textAlign: 'center' }}>
        <h2>Politician not specified</h2>
        <p>Choose a politician from search to view their profile.</p>
        <Link href="/">Return to Congress.Trade</Link>
      </div>
    );
  }

  return <PoliticianProfile slug={slug} />;
}
