import './style.css';
import { el } from './dom.ts';
import { renderCreate, STEPS, stopPolling, type Step } from './create.ts';
import { onSession } from './session.ts';
import { renderShell } from './shell.ts';

const host = renderShell(document.getElementById('app') as HTMLElement);

function home(): HTMLElement {
  stopPolling();
  return el('section', { class: 'panel' },
    el('h2', {}, 'Lock a secret behind a deadline'),
    el('p', {}, 'Choose a deadline and a set of runners. Until the deadline you can postpone or cancel; after it, the kit releases the secret.'),
    el('a', { class: 'btn primary', href: '#/create/deadline', id: 'start' }, 'Create a switch'));
}

function route(): void {
  const m = /^#\/create\/([a-z]+)$/.exec(location.hash);
  const step = m && (STEPS as readonly string[]).includes(m[1]!) ? (m[1] as Step) : null;
  window.onbeforeunload = null;
  if (step) renderCreate(host, step);
  else host.replaceChildren(home());
}

window.addEventListener('hashchange', route);
// Redraw on wallet or network change only; the draft keeps the inputs.
onSession(route);
route();
