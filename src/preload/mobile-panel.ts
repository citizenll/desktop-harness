import type { IpcRenderer } from 'electron'

const HOST_ID = 'dsh-desktop-mobile-panel'

interface MobilePanelMessage {
  url?: unknown
}

export function installMobilePanel(options: {
  document: Document
  ipcRenderer: IpcRenderer
  locale: 'en' | 'zh'
}): void {
  const { document, ipcRenderer, locale } = options
  if (document.getElementById(HOST_ID)) return

  const host = document.createElement('div')
  host.id = HOST_ID
  host.style.cssText = [
    'all:initial',
    'position:fixed',
    'inset:0',
    'z-index:2147483647',
    'display:none',
    '-webkit-app-region:no-drag'
  ].join(';')

  const shadow = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = mobilePanelStyles
  const backdrop = document.createElement('div')
  backdrop.className = 'backdrop'
  backdrop.innerHTML = `
    <section class="panel" role="dialog" aria-modal="true" aria-labelledby="mobile-panel-title">
      <header>
        <h1 id="mobile-panel-title">${locale === 'zh' ? '手机访问' : 'Phone access'}</h1>
        <button class="close" type="button" aria-label="${locale === 'zh' ? '关闭' : 'Close'}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </button>
      </header>
      <iframe title="${locale === 'zh' ? '手机访问' : 'Phone access'}" sandbox="allow-scripts allow-same-origin" allow="clipboard-write" referrerpolicy="no-referrer"></iframe>
    </section>`
  shadow.append(style, backdrop)
  document.documentElement.appendChild(host)

  const panel = backdrop.querySelector<HTMLElement>('.panel')!
  const closeButton = backdrop.querySelector<HTMLButtonElement>('.close')!
  const iframe = backdrop.querySelector<HTMLIFrameElement>('iframe')!
  let iframeOrigin = ''
  let previousFocus: HTMLElement | null = null

  const close = (): void => {
    if (host.style.display === 'none') return
    host.style.display = 'none'
    iframe.src = 'about:blank'
    iframeOrigin = ''
    previousFocus?.focus({ preventScroll: true })
    previousFocus = null
  }

  const open = (payload: MobilePanelMessage): void => {
    const url = trustedPanelUrl(payload?.url)
    if (!url) {
      console.error('[mobile] rejected an invalid pairing panel URL')
      return
    }
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    iframeOrigin = url.origin
    iframe.src = url.href
    host.style.display = 'block'
    closeButton.focus({ preventScroll: true })
  }

  closeButton.addEventListener('click', close)
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close()
  })
  panel.addEventListener('click', (event) => event.stopPropagation())
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || host.style.display === 'none') return
    event.preventDefault()
    close()
  })
  window.addEventListener('message', (event) => {
    if (
      !iframeOrigin ||
      event.origin !== iframeOrigin ||
      event.source !== iframe.contentWindow ||
      typeof event.data !== 'object' ||
      event.data === null ||
      (event.data as { type?: unknown }).type !== 'dsh-mobile-panel-close'
    ) {
      return
    }
    close()
  })
  ipcRenderer.on('mobile:show-panel', (_event, payload: MobilePanelMessage) => open(payload))
}

function trustedPanelUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      url.pathname !== '/desktop' ||
      url.searchParams.get('embedded') !== '1' ||
      url.username ||
      url.password
    ) {
      return undefined
    }
    return url
  } catch {
    return undefined
  }
}

const mobilePanelStyles = `
  :host { color-scheme: light dark; }
  * { box-sizing: border-box; }
  .backdrop {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 12px;
    background: rgba(17, 18, 22, 0.34);
    backdrop-filter: blur(2px);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    -webkit-app-region: no-drag;
  }
  .panel {
    width: min(1024px, calc(100vw - 24px));
    height: min(780px, calc(100vh - 24px));
    min-height: 520px;
    display: grid;
    grid-template-rows: 56px minmax(0, 1fr);
    overflow: hidden;
    border: 1px solid var(--dsw-alias-border-l2, rgba(35, 39, 47, 0.14));
    border-radius: 12px;
    background: var(--dsw-alias-bg-layer-1, #fff);
    box-shadow: 0 22px 70px rgba(18, 22, 31, 0.24);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px 0 20px;
    border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(35, 39, 47, 0.12));
    background: var(--dsw-alias-bg-layer-1, #fff);
  }
  h1 {
    margin: 0;
    color: var(--dsw-alias-label-primary, #18191c);
    font-size: 15px;
    line-height: 1;
    font-weight: 600;
  }
  .close {
    width: 32px;
    height: 32px;
    display: grid;
    place-items: center;
    padding: 0;
    border: 0;
    border-radius: 9px;
    color: var(--dsw-alias-label-secondary, #737780);
    background: transparent;
    cursor: pointer;
  }
  .close:hover { color: var(--dsw-alias-label-primary, #18191c); background: rgba(127, 127, 127, 0.1); }
  .close:focus-visible { outline: 2px solid #4d6bfe; outline-offset: 1px; }
  .close svg { width: 19px; height: 19px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; }
  iframe { width: 100%; height: 100%; border: 0; background: var(--dsw-alias-bg-layer-1, #fff); }
  @media (prefers-color-scheme: dark) {
    .backdrop { background: rgba(0, 0, 0, 0.5); }
    .panel, header, iframe { background: var(--dsw-alias-bg-layer-1, #1d1d20); }
    .panel { border-color: var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.14)); box-shadow: 0 22px 70px rgba(0, 0, 0, 0.52); }
    header { border-color: var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.12)); }
    h1 { color: var(--dsw-alias-label-primary, #f5f5f6); }
    .close { color: var(--dsw-alias-label-secondary, #999ca4); }
  }
  @media (max-width: 700px), (max-height: 600px) {
    .backdrop { padding: 0; }
    .panel { width: 100vw; height: 100vh; min-height: 0; border: 0; border-radius: 0; }
  }
  @media (prefers-reduced-motion: reduce) { .backdrop { backdrop-filter: none; } }
`
