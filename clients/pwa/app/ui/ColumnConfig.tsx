import { useState, useEffect } from 'react';
import {
  ALL_COLUMNS,
  ColumnDef,
  getOrderedColumns,
  loadHiddenCols,
  saveHiddenCols,
  saveColOrder,
  defaultHidden,
} from '../../lib/columns';

interface ColumnConfigProps {
  isPremium: boolean;
  isAdmin: boolean;
  onChange: () => void;
  onClose?: () => void;
}

export function ColumnConfig({ isPremium, isAdmin, onChange, onClose }: ColumnConfigProps) {
  const [columns, setColumns] = useState<ColumnDef[]>([]);
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);

  // Hydrate from localStorage on mount
  useEffect(() => {
    setColumns(getOrderedColumns(isPremium, isAdmin));
    setHiddenIds(loadHiddenCols(isPremium, isAdmin));
  }, [isPremium, isAdmin]);

  const handleToggleVisibility = (id: string) => {
    let nextHidden: string[];
    if (hiddenIds.includes(id)) {
      nextHidden = hiddenIds.filter((x) => x !== id);
    } else {
      nextHidden = [...hiddenIds, id];
    }
    setHiddenIds(nextHidden);
    saveHiddenCols(nextHidden);
    onChange();
  };

  const moveColumn = (index: number, direction: 'up' | 'down') => {
    const nextIndex = direction === 'up' ? index - 1 : index + 1;
    if (nextIndex < 0 || nextIndex >= columns.length) return;

    const updated = [...columns];
    const temp = updated[index];
    updated[index] = updated[nextIndex];
    updated[nextIndex] = temp;

    setColumns(updated);
    saveColOrder(updated.map((c) => c.id));
    onChange();
  };

  const handleReset = () => {
    const defaultOrder = ALL_COLUMNS.filter((c) => {
      if (c.tier === 'admin') return isAdmin;
      if (c.tier === 'premium') return isAdmin || isPremium;
      return true;
    });
    setColumns(defaultOrder);
    saveColOrder(defaultOrder.map((c) => c.id));

    const defHiddenList = defaultHidden(isPremium, isAdmin);
    setHiddenIds(defHiddenList);
    saveHiddenCols(defHiddenList);

    onChange();
  };

  return (
    <div className="column-config-panel">
      <div className="column-config-header">
        <div>
          <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '800', letterSpacing: '-0.02em' }}>Configure Columns</h3>
          <p style={{ margin: '4px 0 0 0', fontSize: '11px', color: 'var(--muted)' }}>
            Toggle visibility and reorder columns for the feed table view.
          </p>
        </div>
        {onClose && (
          <button
            type="button"
            className="dismiss-button"
            onClick={onClose}
            style={{ padding: '4px 10px', fontSize: '12px' }}
          >
            Close
          </button>
        )}
      </div>

      <div className="column-list">
        {columns.map((col, index) => {
          const isVisible = !hiddenIds.includes(col.id);
          return (
            <div key={col.id} className="column-config-row">
              {/* Order Controls */}
              <div className="column-order-btns">
                <button
                  type="button"
                  onClick={() => moveColumn(index, 'up')}
                  disabled={index === 0}
                  className="order-btn"
                  title="Move Up"
                  aria-label={`Move ${col.label} up`}
                >
                  ▲
                </button>
                <button
                  type="button"
                  onClick={() => moveColumn(index, 'down')}
                  disabled={index === columns.length - 1}
                  className="order-btn"
                  title="Move Down"
                  aria-label={`Move ${col.label} down`}
                >
                  ▼
                </button>
              </div>

              {/* Checkbox / Label */}
              <label className="column-toggle-label">
                <input
                  type="checkbox"
                  checked={isVisible}
                  onChange={() => handleToggleVisibility(col.id)}
                />
                <span className="column-name-text">
                  {col.label}
                  {col.tier && (
                    <span className={`column-tier-badge ${col.tier}`}>
                      {col.tier}
                    </span>
                  )}
                </span>
              </label>

              {/* Tooltip Description */}
              {col.tip && (
                <span className="column-tooltip-icon" title={col.tip}>
                  ⓘ
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div className="column-config-footer">
        <button
          type="button"
          onClick={handleReset}
          className="reset-columns-btn"
        >
          Reset to Defaults
        </button>
      </div>

      <style jsx>{`
        .column-config-panel {
          border: 1px solid hsla(217, 30%, 40%, 0.3);
          border-top-color: hsla(217, 30%, 55%, 0.5);
          border-radius: 16px;
          background: var(--panel);
          backdrop-filter: blur(20px);
          padding: 16px;
          box-shadow: inset 0 1px 0 hsla(0, 0%, 100%, 0.1), 0 8px 32px rgba(0, 0, 0, 0.2);
          margin-bottom: 16px;
        }
        .column-config-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          margin-bottom: 16px;
          border-bottom: 1px solid hsla(217, 30%, 40%, 0.2);
          padding-bottom: 12px;
        }
        .column-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
          max-height: 280px;
          overflow-y: auto;
          padding-right: 4px;
          margin-bottom: 16px;
        }
        /* Custom scrollbar for column-list */
        .column-list::-webkit-scrollbar {
          width: 6px;
        }
        .column-list::-webkit-scrollbar-track {
          background: rgba(255, 255, 255, 0.03);
          border-radius: 999px;
        }
        .column-list::-webkit-scrollbar-thumb {
          background: hsla(217, 30%, 35%, 0.6);
          border-radius: 999px;
        }
        .column-config-row {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 6px 8px;
          border-radius: 8px;
          background: rgba(255, 255, 255, 0.02);
          transition: background 0.2s;
        }
        .column-config-row:hover {
          background: rgba(255, 255, 255, 0.05);
        }
        .column-order-btns {
          display: flex;
          gap: 4px;
        }
        .order-btn {
          background: transparent;
          border: none;
          color: var(--muted);
          font-size: 10px;
          cursor: pointer;
          padding: 2px 4px;
          border-radius: 4px;
          transition: all 0.2s;
        }
        .order-btn:hover:not(:disabled) {
          color: var(--text);
          background: rgba(255, 255, 255, 0.1);
        }
        .order-btn:disabled {
          opacity: 0.25;
          cursor: not-allowed;
        }
        .column-toggle-label {
          flex: 1;
          display: flex;
          align-items: center;
          gap: 8px;
          cursor: pointer;
          user-select: none;
          font-size: 13px;
        }
        .column-name-text {
          display: flex;
          align-items: center;
          gap: 6px;
          font-weight: 550;
        }
        .column-tier-badge {
          font-size: 9px;
          padding: 1px 4px;
          border-radius: 4px;
          text-transform: uppercase;
          font-weight: 800;
          letter-spacing: 0.05em;
        }
        .column-tier-badge.premium {
          background: hsla(222, 100%, 64%, 0.15);
          color: hsl(222, 100%, 75%);
          border: 1px solid hsla(222, 100%, 64%, 0.3);
        }
        .column-tier-badge.admin {
          background: hsla(0, 84%, 60%, 0.15);
          color: hsl(0, 84%, 75%);
          border: 1px solid hsla(0, 84%, 60%, 0.3);
        }
        .column-tooltip-icon {
          color: var(--muted);
          font-size: 12px;
          cursor: help;
          opacity: 0.6;
          transition: opacity 0.2s;
        }
        .column-tooltip-icon:hover {
          opacity: 1;
        }
        .column-config-footer {
          display: flex;
          justify-content: flex-end;
          border-top: 1px solid hsla(217, 30%, 40%, 0.2);
          padding-top: 12px;
        }
        .reset-columns-btn {
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid var(--border);
          color: var(--muted);
          padding: 6px 12px;
          border-radius: 8px;
          cursor: pointer;
          font-size: 12px;
          font-weight: 600;
          transition: all 0.2s;
        }
        .reset-columns-btn:hover {
          background: rgba(255, 255, 255, 0.1);
          color: var(--text);
          border-color: var(--border-hover);
        }
      `}</style>
    </div>
  );
}
