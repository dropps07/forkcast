import { Fragment, useEffect, useMemo, useState } from 'react';
import type { ShoppingItem } from '../../types/mealPlan';
import { useMealPlanStore } from '../../store/useMealPlanStore';
import { usePantryStore } from '../../store/usePantryStore';
import { canonicalIngredientKey } from '../../utils/ingredientKey';

type SortKey = 'alpha-asc' | 'alpha-desc' | 'recipes-desc' | 'recipes-asc';

// Retailers we link out to. No cart API, no scraping: each link just opens
// that retailer's own search page for the item, in the user's own session.
type Retailer = 'blinkit' | 'bigbasket' | 'instamart';

const RETAILER_LABEL: Record<Retailer, string> = {
  blinkit: 'Blinkit',
  bigbasket: 'BigBasket',
  instamart: 'Instamart',
};

// Verify each pattern in a browser - retailers change their URLs.
const SEARCH_URL: Record<Retailer, (q: string) => string> = {
  blinkit: (q) => `https://blinkit.com/s/?q=${encodeURIComponent(q)}`,
  bigbasket: (q) => `https://www.bigbasket.com/ps/?q=${encodeURIComponent(q)}`,
  instamart: (q) => `https://www.swiggy.com/instamart/search?query=${encodeURIComponent(q)}`,
};

// One status per row. Pantry wins over checked, so a row can never be both.
type Status = 'todo' | 'checked' | 'pantry';
const STATUS_ORDER: Record<Status, number> = { todo: 0, checked: 1, pantry: 2 };
const SECTION_LABEL: Record<Status, string | null> = {
  todo: null,
  checked: 'Checked',
  pantry: 'In Pantry',
};

export default function ShoppingListModal({ onClose }: { onClose: () => void }) {
  // Selectors: this component only re-renders when what it reads changes.
  const items = useMealPlanStore((s) => s.mealPlan?.shoppingList ?? []);
  const checkedItems = useMealPlanStore((s) => s.checkedItems);
  const toggleChecked = useMealPlanStore((s) => s.toggleChecked);
  const pantry = usePantryStore((s) => s.pantry);
  const addToPantry = usePantryStore((s) => s.addToPantry);
  const removeFromPantry = usePantryStore((s) => s.removeFromPantry);

  const [sort, setSort] = useState<SortKey>('alpha-asc');
  const [retailer, setRetailer] = useState<Retailer>('blinkit');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [onClose]);

  // ── Derived data ───────────────────────────────────────────────────────────

  const checkedSet = useMemo(() => new Set(checkedItems), [checkedItems]);

  const pantryNames = useMemo(
    () => new Set(pantry.map((p) => canonicalIngredientKey(p.name))),
    [pantry]
  );

  function statusOf(item: ShoppingItem): Status {
    if (pantryNames.has(canonicalIngredientKey(item.displayName))) return 'pantry';
    if (checkedSet.has(item.searchTerm)) return 'checked';
    return 'todo';
  }

  const nonPantryItems = useMemo(
    () => items.filter((i) => !pantryNames.has(canonicalIngredientKey(i.displayName))),
    [items, pantryNames]
  );
  const allNonPantryChecked =
    nonPantryItems.length > 0 && nonPantryItems.every((i) => checkedSet.has(i.searchTerm));
  const remaining = nonPantryItems.filter((i) => !checkedSet.has(i.searchTerm));

  const displayItems = useMemo(() => {
    const list = [...items];
    list.sort((a, b) => {
      const ta = STATUS_ORDER[statusOf(a)];
      const tb = STATUS_ORDER[statusOf(b)];
      if (ta !== tb) return ta - tb;
      if (sort === 'alpha-asc') return a.displayName.localeCompare(b.displayName);
      if (sort === 'alpha-desc') return b.displayName.localeCompare(a.displayName);
      if (sort === 'recipes-desc') return b.usedIn.length - a.usedIn.length;
      return a.usedIn.length - b.usedIn.length; // recipes-asc
    });
    return list;
    // statusOf only reads checkedSet and pantryNames, which are listed here
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, sort, checkedSet, pantryNames]);

  // ── Actions ────────────────────────────────────────────────────────────────

  function toggleAll() {
    // Every non-pantry row already checked -> uncheck them all; otherwise check them all.
    for (const item of nonPantryItems) {
      const isChecked = checkedSet.has(item.searchTerm);
      if (allNonPantryChecked === isChecked) toggleChecked(item.searchTerm);
    }
  }

  function moveToList(item: ShoppingItem) {
    if (checkedSet.has(item.searchTerm)) toggleChecked(item.searchTerm);
    removeFromPantry(item.displayName);
  }

  function moveToPantry(item: ShoppingItem) {
    addToPantry([{ name: item.displayName }]);
    if (checkedSet.has(item.searchTerm)) toggleChecked(item.searchTerm);
  }

  async function copyList() {
    const text = remaining
      .map((i) => `- ${i.displayName}${i.estimatedQuantity ? ` (${i.estimatedQuantity})` : ''}`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked (e.g. insecure context) - nothing else to do.
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--shopping-list" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">

        <div className="modal__header">
          <div className="modal__title-group">
            <h2 className="modal__title">Shopping List</h2>
            <p className="modal__subtitle">
              {nonPantryItems.length} to buy · {remaining.length} remaining
            </p>
          </div>
          <button className="modal__close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="shopping-modal__body">
          <div className="shopping-modal__controls">
            <button className="shopping-list__toggle-all" onClick={toggleAll} disabled={nonPantryItems.length === 0}>
              {allNonPantryChecked ? 'Deselect all' : 'Select all'}
            </button>
            <div className="shopping-modal__selects">
              <label className="shopping-modal__select-label">
                Sort
                <select className="shopping-modal__select" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                  <option value="alpha-asc">A → Z</option>
                  <option value="alpha-desc">Z → A</option>
                  <option value="recipes-desc">Most recipes</option>
                  <option value="recipes-asc">Fewest recipes</option>
                </select>
              </label>
              <label className="shopping-modal__select-label">
                Buy on
                <select className="shopping-modal__select" value={retailer} onChange={(e) => setRetailer(e.target.value as Retailer)}>
                  {(Object.keys(RETAILER_LABEL) as Retailer[]).map((r) => (
                    <option key={r} value={r}>{RETAILER_LABEL[r]}</option>
                  ))}
                </select>
              </label>
            </div>
          </div>

          <ul className="shopping-modal__list">
            {displayItems.map((item, idx) => {
              const status = statusOf(item);
              const prevStatus = idx > 0 ? statusOf(displayItems[idx - 1]) : null;
              const sectionLabel = status !== prevStatus ? SECTION_LABEL[status] : null;
              const isChecked = status === 'checked';
              const isPantry = status === 'pantry';
              return (
                // The key must sit on the outermost element of the map.
                <Fragment key={item.displayName}>
                  {sectionLabel && (
                    <li className={`shopping-item__section-divider${isPantry ? ' shopping-item__section-divider--pantry' : ''}`}>
                      {sectionLabel}
                    </li>
                  )}
                  <li
                    className={`shopping-item${isChecked ? ' shopping-item--checked' : ''}${isPantry ? ' shopping-item--pantry' : ''}`}
                    onClick={isPantry ? undefined : () => toggleChecked(item.searchTerm)}
                  >
                    <input
                      type="checkbox"
                      className="shopping-item__native-checkbox"
                      checked={isChecked}
                      disabled={isPantry}
                      onChange={() => toggleChecked(item.searchTerm)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`Mark ${item.displayName} as bought`}
                    />
                    <span className="shopping-item__name-group">
                      <span className="shopping-item__name">{item.displayName}</span>
                      {status === 'todo' ? (
                        <button
                          className="shopping-item__move-btn"
                          onClick={(e) => { e.stopPropagation(); moveToPantry(item); }}
                          title="I already have this"
                        >
                          → Pantry
                        </button>
                      ) : (
                        <button
                          className="shopping-item__move-btn"
                          onClick={(e) => { e.stopPropagation(); moveToList(item); }}
                          title="Move back to the to-buy list"
                        >
                          → List
                        </button>
                      )}
                    </span>
                    <span className="shopping-item__qty">{item.estimatedQuantity}</span>
                    {item.usedIn.length > 0 && (
                      <span className="shopping-item__used-in">
                        {item.usedIn.length === 1 ? item.usedIn[0] : `${item.usedIn.length} recipes`}
                      </span>
                    )}
                    {!isPantry && (
                      <a
                        className="shopping-item__buy"
                        href={SEARCH_URL[retailer](item.searchTerm)}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {RETAILER_LABEL[retailer]} ↗
                      </a>
                    )}
                  </li>
                </Fragment>
              );
            })}
          </ul>
        </div>

        <div className="shopping-modal__footer">
          <div className="shopping-modal__footer-actions">
            <button className="btn-secondary" onClick={copyList} disabled={remaining.length === 0}>
              {copied ? 'Copied ✓' : 'Copy list'}
            </button>
            <button className="btn-primary" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    </div>
  );
}
