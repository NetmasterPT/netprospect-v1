// deploy/docs/ctl-server.mjs — controlo mínimo para o botão flutuante de restart.
// Sem deps (node http + fetch nativo). Fala com o docker-socket-proxy (que só expõe restart),
// e serve o overlay.js injetado por sub_filter do NPMplus nas páginas do Obsidian/Notebook.
//
// Segurança em camadas: (1) só escuta na tailnet/localhost; (2) só é alcançável via NPMplus
// (idealmente atrás de Authentik nesses proxy hosts); (3) WHITELIST de nomes exatos; (4) o
// socket-proxy só permite POST /containers/<id>/restart (ALLOW_RESTARTS), nada mais.
import http from 'node:http';

const PROXY = process.env.DOCKER_PROXY_URL || 'http://docker-socket-proxy:2375';
const PORT = Number(process.env.CTL_PORT || 8097);
// Nomes EXATOS dos containers que o botão pode reiniciar (host→container é resolvido no overlay.js).
const ALLOW = new Set((process.env.CTL_ALLOW || 'npdocs-obsidian-web-1,npdocs-open-notebook-1').split(',').map((s) => s.trim()).filter(Boolean));

// overlay.js: injeta um botão flutuante e mapeia o hostname → container a reiniciar.
const OVERLAY_JS = `(function(){
  try { console.log('[np-restart] overlay carregado em', location.hostname, 'top=' + (window.top === window.self)); } catch (e) {}
  var MAP = {
    'netprospect.obsidian.netmaster.pt': 'npdocs-obsidian-web-1',
    'netprospect.notebook.netmaster.pt': 'npdocs-open-notebook-1'
  };
  var CONTAINER = MAP[location.hostname];
  if (!CONTAINER) { try { console.log('[np-restart] hostname não mapeado — sem botão'); } catch (e) {} return; }
  function ensure(){
    if (window.top !== window.self) return;             // só no frame de topo
    if (!document.body || document.getElementById('np-restart-btn')) return;
    var b = document.createElement('button');
    b.id = 'np-restart-btn'; b.type = 'button'; b.textContent = '⟳'; b.title = 'Reiniciar esta app (se travar)';
    b.style.cssText = 'position:fixed!important;bottom:16px;right:16px;z-index:2147483647;width:48px;height:48px;'
      + 'border-radius:50%;border:2px solid #fff;background:#EA0B2A;color:#fff;font:22px/1 sans-serif;'
      + 'cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.4);opacity:.55;transition:opacity .2s';
    b.onmouseenter = function(){ b.style.opacity = 1; };
    b.onmouseleave = function(){ b.style.opacity = .55; };
    b.onclick = async function(){
      if (!confirm('Reiniciar esta app? Vais perder o estado não-guardado.')) return;
      b.disabled = true; b.textContent = '…';
      try {
        var r = await fetch('/ctl/restart/' + CONTAINER, { method: 'POST' });
        var j = await r.json().catch(function(){ return {}; });
        if (r.ok && j.ok) { b.textContent = '✓'; b.style.background = '#1a7f37'; setTimeout(function(){ location.reload(); }, 7000); }
        else { alert('Restart falhou: ' + (j.error || ('HTTP ' + r.status))); b.disabled = false; b.textContent = '⟳'; }
      } catch (e) { alert('Erro: ' + e.message); b.disabled = false; b.textContent = '⟳'; }
    };
    document.body.appendChild(b);
    try { console.log('[np-restart] botão montado'); } catch (e) {}
  }
  ensure();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensure);
  setInterval(ensure, 2000);                            // re-monta se a app (KasmVNC/Streamlit) substituir o DOM
})();`;

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/overlay.js' || req.url === '/ctl/overlay.js')) {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(OVERLAY_JS);
    }
    if (req.method === 'GET' && req.url === '/health') { res.writeHead(200); return res.end('ok'); }
    const m = req.url.match(/^\/restart\/([a-zA-Z0-9._-]+)$/);
    if (req.method === 'POST' && m) {
      const name = m[1];
      if (!ALLOW.has(name)) return json(res, 403, { ok: false, error: 'container não permitido' });
      const r = await fetch(`${PROXY}/containers/${encodeURIComponent(name)}/restart?t=3`, { method: 'POST' });
      // Docker devolve 204 No Content em sucesso.
      return json(res, r.status === 204 ? 200 : 502, { ok: r.status === 204, status: r.status });
    }
    res.writeHead(404); res.end('not found');
  } catch (e) { json(res, 502, { ok: false, error: e.message }); }
}).listen(PORT, () => console.log(`docs-ctl em :${PORT} — allow: ${[...ALLOW].join(', ')} → ${PROXY}`));
