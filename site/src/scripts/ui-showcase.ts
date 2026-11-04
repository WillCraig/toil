// The Toil UI showcase's controls (#374): the theme pickers and the two
// checkboxes switch which theme's cards show and reload the framed app in
// that theme, and the view buttons open a view in the frame. The frame is
// the real app from the same origin, so for a few views this script also
// presses what a visitor would (opens the chat, asks one of the plain
// questions, opens the agent switcher, types a request no ticket covers), by the
// controls' visible names, which no theme renames. If the app ever moves a
// control, the view still opens and the caption says what to press: the
// tour degrades to a signpost, which is what most tours are anyway.

type Act = '' | 'board' | 'ask' | 'switcher' | 'ticket';

const root = document.querySelector<HTMLElement>('[data-uix]');
const frame = document.querySelector<HTMLIFrameElement>('[data-frame]');
const openApp = document.querySelector<HTMLAnchorElement>('[data-open-app]');

if (root && frame) {
  const app = frame.dataset.app ?? '';
  const steps = [...document.querySelectorAll<HTMLButtonElement>('[data-step]')];
  const themeNames = new Set([...document.querySelectorAll<HTMLInputElement>('[data-theme-pick]')].map((i) => i.value));
  // Each theme opens in the scheme its cards are drawn in, its default, so the frame matches the page whatever the system prefers (#507).
  const schemeOf = new Map([...document.querySelectorAll<HTMLInputElement>('[data-theme-pick]')].map((i) => [i.value, i.dataset.scheme ?? 'system']));
  const state = {
    theme: root.dataset.theme ?? 'crate',
    voice: true,
    wording: true,
    step: steps.find((s) => s.getAttribute('aria-pressed') === 'true')?.dataset.step ?? 'dashboard',
    route: steps.find((s) => s.getAttribute('aria-pressed') === 'true')?.dataset.route ?? '#/',
    act: '' as Act,
  };

  // An old /ui-preview/ link lands here with its theme and route (pages/ui-preview.astro), and opens as it was.
  const params = new URLSearchParams(location.search);
  const asked = params.get('theme');
  if (asked && themeNames.has(asked)) state.theme = asked;
  if (params.get('voice') === 'off') state.voice = false;
  if (params.get('wording') === 'off') state.wording = false;
  const landed = location.hash.startsWith('#/');
  if (landed) state.route = location.hash;

  const appUrl = () => {
    const q = new URLSearchParams({ theme: state.theme, scheme: schemeOf.get(state.theme) ?? 'system' });
    // The app starts with both off, so say which the page wants every time.
    q.set('wording', state.wording ? 'on' : 'off');
    q.set('voice', state.voice ? 'on' : 'off');
    return `${app}?${q}${state.route}`;
  };

  /** Shows what the state says: the checked theme everywhere, its cards and caption, the checkbox variants, the pressed view. */
  const render = () => {
    root.dataset.theme = state.theme;
    root.dataset.voice = state.voice ? 'on' : 'off';
    root.dataset.wording = state.wording ? 'on' : 'off';
    for (const input of document.querySelectorAll<HTMLInputElement>('[data-theme-pick]')) input.checked = input.value === state.theme;
    for (const el of document.querySelectorAll<HTMLElement>('[data-for-theme]')) el.hidden = el.dataset.forTheme !== state.theme;
    for (const s of steps) s.setAttribute('aria-pressed', String(s.dataset.step === state.step));
    for (const el of document.querySelectorAll<HTMLElement>('[data-caption]')) el.hidden = el.dataset.caption !== state.step;
    for (const box of document.querySelectorAll<HTMLInputElement>('[data-check]')) box.checked = box.dataset.check === 'voice' ? state.voice : state.wording;
  };

  /** Opens the app at the state's URL as a fresh page, so a view starts as it would from a link, with no chat left open. */
  const load = () => {
    const next = new URL(appUrl(), location.href);
    if (openApp) openApp.href = next.href;
    const w = frame.contentWindow;
    const now = w ? new URL(w.location.href) : null;
    // Only the hash differs (or nothing): setting src would navigate within the page and never fire load.
    if (w && now && now.origin === next.origin && now.pathname === next.pathname && now.search === next.search) {
      w.location.hash = next.hash;
      w.location.reload();
    } else frame.src = next.href;
  };

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** The first element in the frame matching a selector (and a test), once it shows up; null after a few seconds. */
  async function find<T extends Element>(selector: string, test: (el: T) => boolean = () => true, ms = 6000): Promise<T | null> {
    for (const until = Date.now() + ms; Date.now() < until; await wait(100)) {
      const doc = frame!.contentDocument;
      const hit = doc ? [...doc.querySelectorAll<T>(selector)].find(test) : undefined;
      if (hit) return hit;
    }
    return null;
  }

  /** Opens the chat from the Ask bar and returns its dialog. */
  async function chat(): Promise<Element | null> {
    (await find<HTMLElement>('[data-ask-bar]'))?.click();
    return find('[role="dialog"]');
  }

  /** Presses what a visitor would to reach the view, if this load is still the one it was for. */
  async function act(kind: Act, token: number) {
    const current = () => token === loads;
    if (kind === 'board') {
      // Scrolls the app's own page, never this one, as scrollIntoView would.
      const board = await find<HTMLElement>('#board');
      const view = frame!.contentWindow;
      if (board && view && current()) view.scrollTo({ top: board.getBoundingClientRect().top + view.scrollY - 16, behavior: 'instant' });
    } else if (kind === 'ask') {
      if (!(await chat()) || !current()) return;
      // "Are we going to finish the sprint?", by its own id: the words on the button change with plain words and themes.
      const starters = '[aria-label="Starter questions"] button';
      ((await find<HTMLButtonElement>(`${starters}[data-question="finish"]`, () => true, 3000)) ?? (await find<HTMLButtonElement>(starters)))?.click();
    } else if (kind === 'switcher') {
      if (!(await chat()) || !current()) return;
      (await find<HTMLButtonElement>('[role="dialog"] button', (b) => /change the (agent|AI helper)/.test(b.textContent ?? '')))?.click();
    } else if (kind === 'ticket') {
      if (!(await chat()) || !current()) return;
      const field = await find<HTMLInputElement>('[role="dialog"] form.ask-form input');
      if (!field || !current()) return;
      // React reads a typed value from the input event, so set it the way typing would.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, 'Tokenise the card numbers at the edge of the gateway');
      field.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(50);
      if (current()) field.form?.requestSubmit();
    }
  }

  // A theme picked in the app's own picker shows here too, without reloading the frame.
  let watching: MutationObserver | null = null;
  let loads = 0;
  frame.addEventListener('load', () => {
    const token = ++loads;
    watching?.disconnect();
    const html = frame.contentDocument?.documentElement;
    if (html) {
      watching = new MutationObserver(() => {
        const theme = html.dataset.theme;
        if (theme && theme !== state.theme && themeNames.has(theme)) {
          state.theme = theme;
          render();
          if (openApp) openApp.href = appUrl();
        }
      });
      watching.observe(html, { attributes: true, attributeFilter: ['data-theme'] });
    }
    if (!state.act) return;
    // Pressing in the app moves focus into it, and the browser scrolls to follow. Whoever pressed the view
    // button keeps their place: the page stays where it was, and focus goes back to the button, except
    // for the agent switcher, whose menu closes when focus leaves it, as a menu should.
    const before = { el: document.activeElement, y: window.scrollY };
    const kind = state.act;
    void act(kind, token).finally(() => {
      if (token !== loads) return;
      if (document.activeElement === frame && kind !== 'switcher' && before.el instanceof HTMLElement && before.el !== frame) before.el.focus({ preventScroll: true });
      if (window.scrollY !== before.y) window.scrollTo({ top: before.y, behavior: 'instant' });
    });
  });

  for (const input of document.querySelectorAll<HTMLInputElement>('[data-theme-pick]')) {
    input.addEventListener('change', () => {
      if (!input.checked) return;
      state.theme = input.value;
      render();
      load();
    });
  }
  for (const box of document.querySelectorAll<HTMLInputElement>('[data-check]')) {
    box.addEventListener('change', () => {
      if (box.dataset.check === 'voice') state.voice = box.checked;
      else state.wording = box.checked;
      render();
      load();
    });
  }
  for (const s of steps) {
    s.addEventListener('click', () => {
      state.step = s.dataset.step ?? state.step;
      state.route = s.dataset.route ?? '#/';
      state.act = (s.dataset.act ?? '') as Act;
      render();
      load();
    });
  }

  // At 1440px the app shows its whole header in one row. Where the frame has room for most of that,
  // lay the app out at DESKTOP and scale it down to fit; below that, leave it at the frame's own width,
  // so a phone gets the app's phone layout at full size.
  const DESKTOP = 1440;
  const box = document.querySelector<HTMLElement>('[data-frame-box]');
  if (box && 'ResizeObserver' in window) {
    new ResizeObserver(() => {
      const scale = box.clientWidth / DESKTOP;
      const fit = scale >= 0.7 && scale < 1;
      frame.style.width = fit ? `${DESKTOP}px` : '';
      frame.style.height = fit ? `${box.clientHeight / scale}px` : '';
      frame.style.transform = fit ? `scale(${scale})` : '';
    }).observe(box);
  }

  render();
  // After load, so the browser's own jump to the (missing) fragment doesn't undo it.
  if (landed) window.addEventListener('load', () => document.getElementById('live')?.scrollIntoView({ behavior: 'instant' }), { once: true });
  if (frame.src !== new URL(appUrl(), location.href).href) load();
  else if (openApp) openApp.href = appUrl();
}
