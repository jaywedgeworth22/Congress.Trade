const fs = require('fs');
let content = fs.readFileSync('app/src/ui/dashboardHtml.ts', 'utf8');

// A. pushState & popstate
content = content.replace(
  "window.history.replaceState({}, '', u.pathname + u.search + u.hash);",
  "window.history.pushState({ view: b.dataset.view }, '', u.pathname + u.search + u.hash);"
);

// We need a popstate listener
const popstateListener = `
window.addEventListener('popstate', function (e) {
  var urlParams = new URLSearchParams(window.location.search);
  var view = urlParams.get('view') || 'trends';
  var btn = document.querySelector('nav.tabs a[data-view="' + view + '"]');
  if (btn) {
    document.querySelectorAll('nav.tabs a').forEach(function (x) { x.classList.remove('active'); x.setAttribute('aria-selected', 'false'); x.removeAttribute('aria-current'); });
    document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('active'); v.setAttribute('aria-hidden', 'true'); });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    btn.setAttribute('aria-current', 'page');
    if (TAB_PAGE_TITLES[view]) setDocumentTitle(TAB_PAGE_TITLES[view]);
    try { localStorage.setItem('ct-active-tab', view); } catch (e) {}
    document.documentElement.setAttribute('data-view', view);
    var viewEl = el('view-' + view);
    if (viewEl) { viewEl.classList.add('active'); viewEl.setAttribute('aria-hidden', 'false'); }
    if (view === 'trades') {
      requestAnimationFrame(function () {
        syncTradesTableWidth();
      });
    }
  }
  
  if (typeof restoreFiltersFromUrl === 'function') {
    restoreFiltersFromUrl();
  }
  
  if (view === 'trades' && typeof fetchPage === 'function') {
    fetchPage();
  }
});
`;
content = content.replace("/* ============================ TABS + BOOT ============================ */", popstateListener + "\n/* ============================ TABS + BOOT ============================ */");

// B. Column Header Sorting Limited to Current Page In-Memory
// Fix: Wire server-side sort parameters on the backend API or remove sorting indicators from unsupported columns.
// In `tradesQueryParams`, the server-side sort parameters are sent: 'published', 'tx_date'. But the UI might show other columns as sortable.
// Let's check `visibleCols()` or where columns are defined.

// C. Client-Side Re-filtering Causes Row Skipping
content = content.replace(/function makeTradesFilterMatcher[\s\S]*?return tradeRowMatchesSearch\(r, q\);\n  };\n}\n/, "");
content = content.replace("var matchesActiveFilters = makeTradesFilterMatcher();", "");
content = content.replace("return matchesActiveFilters(r);", "return true;");


fs.writeFileSync('app/src/ui/dashboardHtml.ts', content);
