import './style.css';
import { el } from './dom.ts';
import { renderCreate, STEPS, stopPolling, type Step } from './create.ts';
import { renderManage } from './manage.ts';
import { renderRecover } from './recover.ts';
import { onSession } from './session.ts';
import { renderShell } from './shell.ts';

const host = renderShell(document.getElementById('app') as HTMLElement);

function home(): HTMLElement {
  stopPolling();
  return el('section', { class: 'panel' },
    el('h2', {}, 'Lock a secret behind a deadline'),
    el('p', {}, 'Choose a deadline and a set of runners. Until the deadline you can postpone or cancel; after it, the kit releases the secret.'),
    el('div', { class: 'row' }, el('a', { class: 'btn primary', href: '#/create/deadline', id: 'start' }, 'Create a switch'),
      el('a', { class: 'btn primary', href: '#/switches', id: 'my-switches' }, 'My switches'), el('a', { class: 'btn', href: '#/recover', id: 'recover' }, 'Recover')));
}

function route(): void {
  const m = /^#\/create\/([a-z]+)$/.exec(location.hash);
  const step = m && (STEPS as readonly string[]).includes(m[1]!) ? (m[1] as Step) : null;
  window.onbeforeunload = null;
  stopPolling();
  if (step) renderCreate(host, step);
  else if (location.hash === '#/switches') { const h = document.createElement('div'); host.replaceChildren(h); renderManage(h); }
  else if (location.hash === '#/recover') { const h = document.createElement('div'); host.replaceChildren(h); renderRecover(h); }
  else host.replaceChildren(home());
}

window.addEventListener('hashchange', route);
// Redraw on wallet or network change only; the draft keeps the inputs.
onSession(route);
route();
