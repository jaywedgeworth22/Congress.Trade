'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { normalizeProfileQueryValue } from '../../lib/profileRoutes';
import AssetProfile from '../ui/AssetProfile';

export default function AssetProfilePage() {
  const searchParams = useSearchParams();
  const ticker = normalizeProfileQueryValue(searchParams.get('ticker'));

  if (!ticker) {
    return (
      <div className="app-shell" style={{ padding: '24px', textAlign: 'center' }}>
        <h2>Asset not specified</h2>
        <p>Choose an asset from search to view its profile.</p>
        <Link href="/">Return to Congress.Trade</Link>
      </div>
    );
  }

  return <AssetProfile ticker={ticker} />;
}
