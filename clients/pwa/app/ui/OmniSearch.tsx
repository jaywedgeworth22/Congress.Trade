'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { apiGet } from '../../lib/clientApi';

export type SearchResultItem = {
  id: string;
  name: string;
  type: 'politician' | 'asset';
  subtitle?: string;
  photoUrl?: string;
};

const fetcher = (url: string) => apiGet<{ results: SearchResultItem[] }>(url);

export function OmniSearch() {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedQuery(query);
    }, 250);
    return () => clearTimeout(handler);
  }, [query]);

  const { data, isLoading } = useSWR(
    debouncedQuery.trim().length >= 2 ? `/search?q=${encodeURIComponent(debouncedQuery)}` : null,
    fetcher
  );

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const results = data?.results || [];
  const showResults = isOpen && debouncedQuery.trim().length >= 2;

  return (
    <div className="omnisearch-container" ref={containerRef}>
      <div className="search-input-wrapper">
        <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <input
          type="text"
          className="search-input"
          placeholder="Search politicians or tickers..."
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
        />
        {isLoading && <div className="search-spinner" />}
      </div>

      {showResults && (
        <div className="search-dropdown">
          {results.length === 0 && !isLoading ? (
            <div className="search-no-results">No results found for "{debouncedQuery}"</div>
          ) : (
            <ul className="search-results-list">
              {results.map((item) => (
                <li key={`${item.type}-${item.id}`}>
                  <Link 
                    href={item.type === 'politician' ? `/politician/${item.id}` : `/asset/${item.id}`}
                    className="search-result-link"
                    onClick={() => setIsOpen(false)}
                  >
                    {item.type === 'politician' && item.photoUrl ? (
                      <img src={item.photoUrl} alt="" className="search-result-avatar" />
                    ) : item.type === 'asset' ? (
                      <img src={`/api/logos/ticker?symbol=${encodeURIComponent(item.id)}`} alt="" className="search-result-avatar asset-logo" onError={(e) => e.currentTarget.style.display = 'none'} />
                    ) : (
                      <div className="search-result-avatar-fallback" />
                    )}
                    <div className="search-result-info">
                      <div className="search-result-name">{item.name}</div>
                      <div className="search-result-sub">
                        {item.type === 'politician' ? item.subtitle : `${item.id} • ${item.subtitle}`}
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <style jsx>{`
        .omnisearch-container {
          position: relative;
          width: 100%;
          max-width: 400px;
          margin: 0 auto;
        }
        .search-input-wrapper {
          position: relative;
          display: flex;
          align-items: center;
        }
        .search-icon {
          position: absolute;
          left: 12px;
          width: 16px;
          height: 16px;
          color: var(--text-muted);
          pointer-events: none;
        }
        .search-input {
          width: 100%;
          padding: 10px 12px 10px 36px;
          border-radius: 20px;
          border: 1px solid var(--border);
          background: var(--bg-elevated);
          color: var(--text);
          font-size: 14px;
          outline: none;
          transition: border-color 0.2s, box-shadow 0.2s;
        }
        .search-input:focus {
          border-color: var(--buy);
          box-shadow: 0 0 0 2px rgba(46, 204, 113, 0.2);
        }
        .search-spinner {
          position: absolute;
          right: 12px;
          width: 16px;
          height: 16px;
          border: 2px solid var(--border);
          border-top-color: var(--text-muted);
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        .search-dropdown {
          position: absolute;
          top: 100%;
          left: 0;
          right: 0;
          margin-top: 8px;
          background: var(--bg-elevated);
          border: 1px solid var(--border);
          border-radius: 12px;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
          z-index: 100;
          max-height: 400px;
          overflow-y: auto;
        }
        .search-no-results {
          padding: 16px;
          text-align: center;
          color: var(--text-muted);
          font-size: 14px;
        }
        .search-results-list {
          list-style: none;
          margin: 0;
          padding: 4px 0;
        }
        .search-result-link {
          display: flex;
          align-items: center;
          padding: 10px 16px;
          text-decoration: none;
          color: var(--text);
          transition: background 0.15s;
        }
        .search-result-link:hover, .search-result-link:focus {
          background: rgba(255, 255, 255, 0.05);
          outline: none;
        }
        .search-result-avatar {
          width: 32px;
          height: 32px;
          border-radius: 50%;
          object-fit: cover;
          margin-right: 12px;
          background: #fff;
        }
        .asset-logo {
          border-radius: 4px;
        }
        .search-result-avatar-fallback {
          width: 32px;
          height: 32px;
          border-radius: 50%;
          background: var(--border);
          margin-right: 12px;
        }
        .search-result-info {
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        .search-result-name {
          font-weight: 600;
          font-size: 14px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .search-result-sub {
          font-size: 12px;
          color: var(--text-muted);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
      `}</style>
    </div>
  );
}
