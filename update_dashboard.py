import re
import sys

with open('app/src/ui/dashboardHtml.ts', 'r') as f:
    content = f.read()

# 1. Remove trWindow select from toolbar
content = re.sub(
    r'\s*<select id="trWindow" title="Time window \(by trade date\)">.*?</select>',
    '',
    content,
    flags=re.DOTALL
)

# 2. Remove trSource select from toolbar
content = re.sub(
    r'\s*<select id="trSource" title="Provenance of the underlying rows">.*?</select>',
    '',
    content,
    flags=re.DOTALL
)

# 3. Add bare-select CSS
css = """
  .bare-select {
    border: none;
    background: transparent;
    color: var(--accent);
    font-family: inherit;
    font-size: inherit;
    font-weight: inherit;
    padding: 2px 18px 2px 4px;
    margin: 0 0 0 4px;
    cursor: pointer;
    outline: none;
    appearance: none;
    -webkit-appearance: none;
    background-image: url('data:image/svg+xml;utf8,<svg fill="%23005fb8" height="16" viewBox="0 0 24 24" width="16" xmlns="http://www.w3.org/2000/svg"><path d="M7 10l5 5 5-5z"/></svg>');
    background-repeat: no-repeat;
    background-position: right center;
    border-radius: 4px;
  }
  [data-theme="dark"] .bare-select {
    color: var(--accent);
    background-image: url('data:image/svg+xml;utf8,<svg fill="%234da3ff" height="16" viewBox="0 0 24 24" width="16" xmlns="http://www.w3.org/2000/svg"><path d="M7 10l5 5 5-5z"/></svg>');
  }
  .bare-select:hover {
    background-color: var(--bg-hover);
  }
"""
content = content.replace('/* ---- Branch and Party chip multi-select ---- */', css + '\n  /* ---- Branch and Party chip multi-select ---- */')

# 4. Create the select HTML snippet
select_html = """<select class="tr-window-select bare-select" title="Time window">
          <option value="1d">Past Day</option>
          <option value="7d">Past Week</option>
          <option value="30d">Past Month</option>
          <option value="90d" selected>Past 3 Months</option>
          <option value="180d">Past 6 Months</option>
          <option value="365d">Past Year</option>
          <option value="1825d">Past 5 Years</option>
          <option value="all">All Time</option>
        </select>"""
select_html_inline = select_html.replace('\n', '').replace('  ', '')

# 5. Insert the select snippet into the specified headers
replacements = [
    (r'<div class="tf-cap">Snapshot · <span id="trKpisCap">Past 3 Months</span></div>',
     f'<div class="tf-cap">Snapshot · {select_html_inline}</div>'),
    (r'<h3 class="tf-h">What Congress Is Trading</h3>',
     f'<h3 class="tf-h">What Congress Is Trading {select_html_inline}</h3>'),
    (r'<h3 class="tf-h">Rising Activity</h3>',
     f'<h3 class="tf-h">Rising Activity {select_html_inline}</h3>'),
    (r'<h3 class="tf-h">Consensus Moves <span class="chip" id="trClusterHint"></span></h3>',
     f'<h3 class="tf-h">Consensus Moves {select_html_inline} <span class="chip" id="trClusterHint"></span></h3>'),
    (r'<h3 class="tf-h">Net Flow by Sector</h3>',
     f'<h3 class="tf-h">Net Flow by Sector {select_html_inline}</h3>'),
    (r'<h3 class="tf-h">By Market Cap</h3>',
     f'<h3 class="tf-h">By Market Cap {select_html_inline}</h3>'),
    (r'<h3>Top Performers <span class="info-tip"',
     f'<h3>Top Performers {select_html_inline} <span class="info-tip"'),
    (r'<h3 class="tf-h">Most Active Politicians</h3>',
     f'<h3 class="tf-h">Most Active Politicians {select_html_inline}</h3>'),
    (r'<h3 class="tf-h">By Party</h3>',
     f'<h3 class="tf-h">By Party {select_html_inline}</h3>'),
    (r'<h3 class="tf-h">By Asset Type</h3>',
     f'<h3 class="tf-h">By Asset Type {select_html_inline}</h3>'),
    (r'<h3>Disclosure Timeliness</h3>',
     f'<h3>Disclosure Timeliness {select_html_inline}</h3>')
]

for old, new in replacements:
    content = re.sub(old, new, content, count=1)

# 6. Update JS logic to use tr-window-select
# Replace el('trWindow').value with getTrWindow()
content = content.replace("el('trWindow').value", "getTrWindow()")
content = content.replace("el('trWindow') ? el('trWindow').value : 'all'", "getTrWindow()")

# Remove trKpisCap update
content = re.sub(r"var cap = el\('trKpisCap'\); if \(cap\) cap\.textContent = label;", "", content)

# Remove trSource from JS
content = re.sub(r"var sc = el\('trSource'\)\.value; if \(sc !== 'all'\) p \+= '&source=' \+ sc;", "", content)
content = content.replace("['trWindow', 'trSource'].forEach", "/* no longer binding trWindow/trSource here */ [].forEach")

# Remove CSS rules
content = re.sub(r"#view-trends \.toolbar #trWindow \{ order: 1; \}", "", content)
content = re.sub(r"#view-trends \.toolbar #trSource \{ order: 3; \}", "", content)
content = re.sub(r"#view-trends \.toolbar #trSource \{ order: 4; \}", "", content)

# 7. Add JS to sync the selects
sync_js = """
function getTrWindow() {
  var sel = document.querySelector('.tr-window-select');
  return sel ? sel.value : '90d';
}
document.addEventListener('change', function(e) {
  if (e.target && e.target.classList && e.target.classList.contains('tr-window-select')) {
    var val = e.target.value;
    document.querySelectorAll('.tr-window-select').forEach(function(s) {
      if (s !== e.target) s.value = val;
    });
    loadTrends();
  }
});
"""
content = content.replace('function handleFeedTextFilter', sync_js + '\nfunction handleFeedTextFilter')


with open('app/src/ui/dashboardHtml.ts', 'w') as f:
    f.write(content)
