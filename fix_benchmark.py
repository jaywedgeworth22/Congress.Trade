import re

with open('app/src/ui/dashboardHtml.ts', 'r') as f:
    content = f.read()

# Replace the HTML block
html_start = r'<div class="section">\s*<h3>Model Benchmarking</h3>'
html_end = r'<div id="benchmarkResults" class="diag-grid" aria-live="polite"></div>\s*</div>'

new_html = """<div class="section">
      <h3>Model Benchmarking</h3>
      <p class="sub">Run systematic tests of individual models against a sample of human-resolved filings (ground truth) to evaluate autonomy vs accuracy. Note: Evaluates up to 25 docs per run.</p>
      <div class="row-flex" style="margin-bottom:8px; gap: 8px;">
        <button class="btn primary" id="btnBenchHouse" onclick="runChamberBenchmark('house')">Benchmark House</button>
        <button class="btn primary" id="btnBenchSenate" onclick="runChamberBenchmark('senate')">Benchmark Senate</button>
        <button class="btn primary" id="btnBenchExec" onclick="runChamberBenchmark('executive')">Benchmark Exec</button>
      </div>
      <span id="benchmarkMsg" class="note"></span>
      <div id="benchmarkResults" class="diag-grid" aria-live="polite"></div>
    </div>"""

content = re.sub(html_start + r'.*?' + html_end, new_html, content, flags=re.DOTALL)

# Replace the JavaScript block
js_start = r'async function runBenchmark\(\) \{'
js_end = r'msg\.innerText = \'Benchmark completed!\';\n  \} catch \(err\) \{\n    msg\.style\.color = \'var\(--neg\)\';\n    msg\.innerText = \'Error: \' \+ err;\n  \}\n\}'

new_js = """async function runChamberBenchmark(chamberName) {
  var msg = el('benchmarkMsg');
  var res = el('benchmarkResults');
  var btns = [el('btnBenchHouse'), el('btnBenchSenate'), el('btnBenchExec')];
  
  msg.innerText = 'Fetching ground-truth docs for ' + chamberName + '...';
  msg.style.color = '';
  res.innerHTML = '';
  btns.forEach(b => { if (b) b.disabled = true; });

  try {
    const docsData = await apiCall('/api/admin/benchmark/ground-truth-docs?limit=25&chamber=' + chamberName, 'GET');
    const docList = docsData.docs || [];
    if (!docList.length) {
      msg.innerText = 'No ground-truth docs found for ' + chamberName + '.';
      btns.forEach(b => { if (b) b.disabled = false; });
      return;
    }

    var html = '<table><thead><tr><th>Model</th><th>Autonomy Rate</th></tr></thead><tbody id="benchmarkTbody">';
    for (var i = 0; i < REREAD_MODELS.length; i++) {
      html += '<tr id="lineup-' + i + '"><td><strong>' + esc(REREAD_MODELS[i].model) + ' <small class="note">(' + esc(REREAD_MODELS[i].provider) + ')</small></strong></td>' +
              '<td id="auto-' + i + '">Pending...</td></tr>';
    }
    html += '</tbody></table>';
    res.innerHTML = html;

    for (let i = 0; i < REREAD_MODELS.length; i++) {
      let published = 0;
      let flagged = 0;
      
      const singleModel = REREAD_MODELS[i];
      const testModels = { a: singleModel }; // Only test this single model

      for (let j = 0; j < docList.length; j++) {
        msg.innerText = 'Evaluating ' + singleModel.model + ' (' + (i + 1) + '/' + REREAD_MODELS.length + ')... Doc ' + (j + 1) + '/' + docList.length;
        try {
          const result = await apiCall('/api/admin/benchmark/dry-run/' + docList[j], 'POST', { models: testModels });
          const autoPublished = result.outcome === 'published' || result.outcome === 'would_publish';
          let confidence = 1;
          if (result.rows && result.rows.length) {
            confidence = result.rows.reduce((min, r) => Math.min(min, r.confidence || 0), 1);
          }
          if (autoPublished && confidence >= 0.90) {
            published++;
          } else {
            flagged++;
          }
        } catch (e) {
          flagged++;
        }
        
        let autoRate = ((published / (j + 1)) * 100).toFixed(1) + '%';
        el('auto-' + i).innerText = autoRate + ' (' + published + '/' + (j + 1) + ')';
      }
    }

    msg.innerText = chamberName.toUpperCase() + ' benchmark completed!';
  } catch (err) {
    msg.style.color = 'var(--neg)';
    msg.innerText = 'Error: ' + err;
  } finally {
    btns.forEach(b => { if (b) b.disabled = false; });
  }
}"""

content = re.sub(js_start + r'.*?' + js_end, new_js, content, flags=re.DOTALL)

with open('app/src/ui/dashboardHtml.ts', 'w') as f:
    f.write(content)

