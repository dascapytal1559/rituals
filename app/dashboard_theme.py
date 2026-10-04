"""Shared local/browser title-bar script: theme and ritual picker; no account, network, or database preference."""
import base64
import hashlib

LIGHT={'ink':'#243c36','subtle':'#596b61','line':'#d2ddd5','paper':'#ffffff','wash':'#f3f6f2','green':'#256449','header':'#e7eee7','header-ink':'#405748','border':'#bccdbe','row':'#ffffff','stripe':'#fafcf9','newest':'#f0f6ec','hover':'#edf4ef','done-ink':'#245d3d','done-bg':'#e0eee0','not-done-ink':'#874916','not-done-bg':'#f9e9d8','na-ink':'#4d6071','na-bg':'#edf0f4','quiet':'#596b61','time':'#354d40','open':'#275f83'}
DARK={'ink':'#e2eee7','subtle':'#acbeb2','line':'#35483d','paper':'#17271f','wash':'#0e1813','green':'#91d5af','header':'#24392d','header-ink':'#d1e7d7','border':'#425c4b','row':'#17271f','stripe':'#1b2d23','newest':'#243d2c','hover':'#2a4434','done-ink':'#aaefbd','done-bg':'#294a34','not-done-ink':'#ffd19f','not-done-bg':'#503824','na-ink':'#cfdae8','na-bg':'#304151','quiet':'#adbbb3','time':'#d0ebd8','open':'#a5d4f5'}
def palette(values,scheme):
    return 'color-scheme:'+scheme+';'+''.join('--'+key+':'+value+';' for key,value in values.items())
CSS=':root{'+palette(LIGHT,'light')+'}\n'
CSS+='@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){'+palette(DARK,'dark')+'}}\n'
CSS+=':root[data-theme="dark"]{'+palette(DARK,'dark')+'}\n'
CSS+='''
.sheet{border-color:var(--border)}thead th,thead th.date{background:var(--header);color:var(--header-ink);border-bottom-color:var(--border)}
tbody tr{--row-bg:var(--row)}tbody tr:nth-child(even){--row-bg:var(--stripe)}tbody tr:first-child{--row-bg:var(--newest)}tbody tr:hover{--row-bg:var(--hover)}
.done{background:var(--done-bg);color:var(--done-ink)}.not-done{background:var(--not-done-bg);color:var(--not-done-ink)}.na{background:var(--na-bg);color:var(--na-ink)}
.unknown,.none{color:var(--quiet)}.time{color:var(--time)}.open-badge{color:var(--open)!important}.header-metric{color:var(--header-ink)}
.header-actions{display:flex;align-items:center;justify-content:flex-end;gap:12px}.header-actions .snapshot{margin:0}
.theme-toggle{min-height:32px;min-width:84px;margin:0;padding:5px 9px;font-size:11px;line-height:1.5;background:var(--paper);border-color:var(--line)}
.theme-toggle:hover{background:var(--hover)}.theme-toggle:focus-visible{outline:2px solid var(--green);outline-offset:3px}
@media(max-width:760px){.header-actions{margin-top:12px;justify-content:flex-start;flex-wrap:wrap}}
@media print{.theme-toggle{display:none}}
'''
BUTTON='<button type="button" id="theme-toggle" class="theme-toggle" aria-label="Theme: System. Switch to Light." title="Theme: System. Switch to Light.">◐ System</button>'
SCRIPT='''(() => {
  const key = 'ritual-dashboard-theme-v1';
  const modes = ['system','light','dark'];
  const names = {system:'System',light:'Light',dark:'Dark'};
  const symbols = {system:'◐',light:'☀',dark:'☾'};
  let mode = 'system';
  if (navigator.standalone === true) document.documentElement.dataset.webApp = 'ios';
  try { const saved = localStorage.getItem(key); if (modes.includes(saved)) mode = saved; } catch (_) {}
  function apply() {
    document.documentElement.dataset.theme = mode;
    const button = document.querySelector('#theme-toggle');
    if (!button) return;
    const next = modes[(modes.indexOf(mode)+1)%modes.length];
    const label = 'Theme: '+names[mode]+'. Switch to '+names[next]+'.';
    button.textContent = symbols[mode]+' '+names[mode];
    button.title = label;button.setAttribute('aria-label',label);
  }
  function bind() {
    const button = document.querySelector('#theme-toggle');
    if (button) button.addEventListener('click', () => {
      mode = modes[(modes.indexOf(mode)+1)%modes.length];
      try { if (mode === 'system') localStorage.removeItem(key); else localStorage.setItem(key,mode); } catch (_) {}
      apply();
    });
    apply();
    // The title's native picker switches ritual pages; reset first so a page restored from history still names itself.
    const picker = document.querySelector('#ritual-picker');
    if (picker) picker.addEventListener('change', () => {
      const target = picker.value;
      for (const option of picker.options) option.selected = option.defaultSelected;
      location.assign(target);
    });
  }
  apply();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',bind,{once:true}); else bind();
  window.addEventListener('storage',event => {
    if (event.key === key || event.key === null) { mode = modes.includes(event.newValue) ? event.newValue : 'system';apply(); }
  });
})();'''
HASH=base64.b64encode(hashlib.sha256(SCRIPT.encode()).digest()).decode()
