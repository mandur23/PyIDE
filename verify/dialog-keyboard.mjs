// Keyboard-only use of dialogs: Tab and Shift+Tab from a focused element that is not a Tab stop (a scroller Chromium
// focuses, a list row) go on to the next or previous stop by position instead of back to the first; Settings is walked
// from the search box through the category list into the page's controls and the buttons, and the category list
// switches pages with the arrow keys. English and Korean.
import { launch } from './lib.mjs';

const results = [];
let consoleErrors = [];
const check = (ok, label) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); };
const where = `(() => { const a = document.activeElement; const page = a.closest('.settings-page'); return a.closest('.settings-search-wrap') ? 'search' : a.classList.contains('settings-pages') ? 'categories' : page ? 'page:' + (a.dataset.key || a.tagName) : a.closest('.dialog-buttons') ? 'button:' + a.textContent : a.tagName + '.' + a.className; })()`;

async function run(lang, port) {
  const t = await launch({ fixture: 'core', port, name: `dialog-keyboard-${lang}`, lang });
  const { js, until, press } = t;
  const L = `${lang}:`;
  try {
    // A dialog with a scroller between two fields: Chromium gives the scroller the keyboard on Tab, and it is no stop.
    await js(`(() => {
      const body = document.createElement('div');
      body.innerHTML = '<input id="kbA" class="input"><div id="kbScroll" style="height:40px;overflow:auto"><div style="height:400px">long text</div></div><input id="kbB" class="input">';
      window.__kb = ide.ui.dialog({ title: 'Keys', body, buttons: [{ label: 'OK', primary: true }, { label: 'Cancel' }] });
      return true;
    })()`);
    await js(`(document.getElementById('kbScroll').focus(), true)`);
    await press('Tab');
    const afterScroll = await js('document.activeElement.id');
    await js(`(document.getElementById('kbScroll').focus(), true)`);
    await press('Shift+Tab');
    const beforeScroll = await js('document.activeElement.id');
    check(afterScroll === 'kbB' && beforeScroll === 'kbA', `${L} Tab and Shift+Tab from a focused scroller go to the next and previous field, not the first (${afterScroll}, ${beforeScroll})`);
    await press('Escape');

    await press('Ctrl+Alt+S');
    await until(`!!document.querySelector('.settings-dialog')`, 'settings');
    await until(`document.activeElement?.classList.contains('settings-search')`, 'search box has the keyboard');
    const walk = [await js(where)];
    for (let i = 0; i < 40 && !walk.slice(1).includes('search'); i++) {
      await press('Tab');
      walk.push(await js(where));
    }
    const firstPage = walk.findIndex((w) => w.startsWith('page:'));
    const firstButton = walk.findIndex((w) => w.startsWith('button:'));
    check(walk[1] === 'categories' && firstPage > 1 && firstButton > firstPage && walk[walk.length - 1] === 'search',
      `${L} Tab goes from the search box to the category list, into the page's controls, to the buttons and back to the search box (${walk.join(' > ')})`);
    const back = [];
    for (let i = 0; i < 3; i++) { await press('Shift+Tab'); back.push(await js(where)); }
    check(back[0].startsWith('button:') && back[1].startsWith('button:'), `${L} Shift+Tab from the search box goes back to the buttons (${back.join(' < ')})`);

    await js(`(document.querySelector('.settings-pages').focus(), true)`);
    const page = () => js(`document.querySelector('.settings-page').dataset.page`);
    const start = await page();
    await press('ArrowDown');
    const next = await page();
    await press('ArrowUp');
    const again = await page();
    check(start === 'appearance' && next !== start && again === start, `${L} Down and Up in the category list switch pages (${start} > ${next} > ${again})`);
    await press('End');
    const last = await page();
    await press('Home');
    const groupSelected = await js(`document.querySelector('.settings-nav-row.selected')?.dataset.group || ''`);
    check(last !== start && groupSelected === 'appearance-behavior' && await page() === last, `${L} End opens the last page; Home selects the first group row and keeps the page (${last}, ${groupSelected})`);
    await press('ArrowLeft');
    const collapsed = await js(`!document.querySelector('.settings-nav-row[data-page="appearance"]').offsetParent`);
    await press('ArrowRight');
    const expanded = await js(`!!document.querySelector('.settings-nav-row[data-page="appearance"]').offsetParent`);
    await press('ArrowRight');
    check(collapsed && expanded && await page() === 'appearance', `${L} Left and Right collapse and expand a group, and Right then enters its first page`);
    await press('ArrowDown');
    await press('ArrowLeft');
    check(await js(`document.querySelector('.settings-nav-row.selected')?.dataset.group === 'appearance-behavior'`), `${L} Left on a page goes to its group`);
    check(await js(`document.activeElement === document.querySelector('.settings-pages')`), `${L} the category list keeps the keyboard while switching pages`);
    await press('Escape');
    await until(`!document.querySelector('.settings-dialog')`, 'settings closed');
  } catch (err) {
    check(false, `${L} ${err.message}`);
  }
  consoleErrors = consoleErrors.concat(t.consoleErrors);
  t.close();
}

await run('en-US', 9100);
await run('ko-KR', 9101);
if (consoleErrors.length) console.log(`renderer exceptions:\n  ${consoleErrors.join('\n  ')}`);
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed || consoleErrors.length ? 1 : 0);
