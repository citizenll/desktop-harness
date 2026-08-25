import type { IpcRenderer } from 'electron'
import {
  DSH_DESKTOP_DIALOG_RESPONSE_CHANNEL,
  DSH_DESKTOP_DIALOG_SHOW_CHANNEL,
  type DesktopDialogButton,
  type DesktopDialogRequest,
  type DesktopDialogResponse,
  type DesktopDialogTone
} from '../shared/app-dialog'

const HOST_ID = 'dsh-desktop-app-dialog'

interface DialogMountOptions {
  document: Document
  ipcRenderer: Pick<IpcRenderer, 'on' | 'send'>
  locale: 'en' | 'zh'
}

/**
 * Installs one renderer-owned dialog surface for every Desktop prompt. The IPC
 * listener is registered immediately so requests sent between preload startup
 * and DOMContentLoaded are queued instead of falling back to an OS message box.
 */
export function installAppDialog(options: DialogMountOptions): void {
  const { document, ipcRenderer, locale } = options
  const queue: DesktopDialogRequest[] = []
  let mounted: ReturnType<typeof mountDialog> | undefined

  const drain = (): void => {
    if (!mounted || mounted.isOpen() || queue.length === 0) return
    const request = queue.shift()
    if (!request) return
    mounted.open(request, (response) => {
      const payload: DesktopDialogResponse = { id: request.id, response }
      ipcRenderer.send(DSH_DESKTOP_DIALOG_RESPONSE_CHANNEL, payload)
      queueMicrotask(drain)
    })
  }

  const ensureMounted = (): void => {
    if (mounted || document.getElementById(HOST_ID)) return
    mounted = mountDialog(document, locale)
    drain()
  }

  ipcRenderer.on(DSH_DESKTOP_DIALOG_SHOW_CHANNEL, (_event, payload: unknown) => {
    const request = parseDialogRequest(payload)
    if (!request) return
    queue.push(request)
    ensureMounted()
    drain()
  })

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', ensureMounted, { once: true })
  } else {
    ensureMounted()
  }
}

function parseDialogRequest(value: unknown): DesktopDialogRequest | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Partial<DesktopDialogRequest>
  if (!Number.isSafeInteger(candidate.id) || (candidate.id ?? -1) < 0) return undefined
  if (!isTone(candidate.tone)) return undefined
  if (typeof candidate.message !== 'string' || candidate.message.trim().length === 0) return undefined
  if (candidate.detail !== undefined && typeof candidate.detail !== 'string') return undefined
  if (!Array.isArray(candidate.buttons) || candidate.buttons.length < 1 || candidate.buttons.length > 3) {
    return undefined
  }
  const buttons = candidate.buttons.map(parseButton)
  if (buttons.some((button) => button === undefined)) return undefined
  if (!Number.isInteger(candidate.defaultId) || !Number.isInteger(candidate.cancelId)) return undefined
  if ((candidate.defaultId ?? -1) < 0 || (candidate.defaultId ?? -1) >= buttons.length) return undefined
  if ((candidate.cancelId ?? -1) < 0 || (candidate.cancelId ?? -1) >= buttons.length) return undefined

  return {
    id: candidate.id!,
    tone: candidate.tone!,
    message: candidate.message.trim().slice(0, 500),
    detail: candidate.detail?.trim().slice(0, 12_000),
    buttons: buttons as DesktopDialogButton[],
    defaultId: candidate.defaultId!,
    cancelId: candidate.cancelId!
  }
}

function parseButton(value: unknown): DesktopDialogButton | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Partial<DesktopDialogButton>
  if (typeof candidate.label !== 'string' || candidate.label.trim().length === 0) return undefined
  if (
    candidate.kind !== undefined &&
    candidate.kind !== 'primary' &&
    candidate.kind !== 'secondary' &&
    candidate.kind !== 'danger'
  ) {
    return undefined
  }
  return { label: candidate.label.trim().slice(0, 100), kind: candidate.kind }
}

function isTone(value: unknown): value is DesktopDialogTone {
  return value === 'info' || value === 'warning' || value === 'error'
}

function mountDialog(document: Document, locale: 'en' | 'zh') {
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
  style.textContent = dialogStyles
  const backdrop = document.createElement('div')
  backdrop.className = 'backdrop'
  const panel = document.createElement('section')
  panel.className = 'panel'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-labelledby', 'dsh-dialog-message')
  panel.setAttribute('aria-describedby', 'dsh-dialog-detail')

  const closeButton = document.createElement('button')
  closeButton.type = 'button'
  closeButton.className = 'close'
  closeButton.setAttribute('aria-label', locale === 'zh' ? '关闭' : 'Close')
  closeButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>'

  const body = document.createElement('div')
  body.className = 'body'
  const icon = document.createElement('div')
  icon.className = 'icon'
  icon.setAttribute('aria-hidden', 'true')
  const copy = document.createElement('div')
  copy.className = 'copy'
  const message = document.createElement('h2')
  message.id = 'dsh-dialog-message'
  const detail = document.createElement('p')
  detail.id = 'dsh-dialog-detail'
  copy.append(message, detail)
  body.append(icon, copy)

  const footer = document.createElement('footer')
  panel.append(closeButton, body, footer)
  backdrop.appendChild(panel)
  shadow.append(style, backdrop)
  document.documentElement.appendChild(host)

  let activeRequest: DesktopDialogRequest | undefined
  let onResponse: ((response: number) => void) | undefined
  let previousFocus: HTMLElement | null = null

  const close = (response: number): void => {
    if (!activeRequest) return
    const callback = onResponse
    activeRequest = undefined
    onResponse = undefined
    host.style.display = 'none'
    footer.replaceChildren()
    previousFocus?.focus({ preventScroll: true })
    previousFocus = null
    callback?.(response)
  }

  const cancel = (): void => {
    if (activeRequest) close(activeRequest.cancelId)
  }

  closeButton.addEventListener('click', cancel)
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) cancel()
  })
  panel.addEventListener('click', (event) => event.stopPropagation())
  document.addEventListener('keydown', (event) => {
    if (!activeRequest) return
    if (event.key === 'Escape') {
      event.preventDefault()
      cancel()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = [...panel.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    if (focusable.length === 0) return
    const current = focusable.indexOf(shadow.activeElement as HTMLButtonElement)
    const next = event.shiftKey
      ? current <= 0 ? focusable.length - 1 : current - 1
      : current < 0 || current === focusable.length - 1 ? 0 : current + 1
    event.preventDefault()
    focusable[next]?.focus()
  })

  return {
    isOpen: (): boolean => activeRequest !== undefined,
    open: (request: DesktopDialogRequest, respond: (response: number) => void): void => {
      if (activeRequest) return
      activeRequest = request
      onResponse = respond
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      panel.dataset.tone = request.tone
      icon.innerHTML = toneIcon(request.tone)
      message.textContent = request.message
      detail.textContent = request.detail ?? ''
      detail.hidden = !request.detail
      footer.replaceChildren(...request.buttons.map((definition, index) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = `action ${definition.kind ?? (index === request.defaultId ? 'primary' : 'secondary')}`
        button.textContent = definition.label
        button.addEventListener('click', () => close(index))
        return button
      }))
      host.style.display = 'block'
      const defaultButton = footer.children.item(request.defaultId)
      window.requestAnimationFrame(() => {
        if (defaultButton instanceof HTMLButtonElement) defaultButton.focus({ preventScroll: true })
      })
    }
  }
}

function toneIcon(tone: DesktopDialogTone): string {
  if (tone === 'warning') {
    return '<svg viewBox="0 0 24 24"><path d="M12 3.4 21 19a1.2 1.2 0 0 1-1 1.8H4A1.2 1.2 0 0 1 3 19L12 3.4Z"/><path d="M12 8v5.2M12 17.2v.1"/></svg>'
  }
  if (tone === 'error') {
    return '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/></svg>'
  }
  return '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 10.8v5M12 7.2v.1"/></svg>'
}

const dialogStyles = `
  :host { color-scheme: light dark; }
  * { box-sizing: border-box; }
  .backdrop {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 20px;
    background: rgba(17, 18, 22, 0.34);
    backdrop-filter: blur(2px);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    -webkit-app-region: no-drag;
    animation: fade-in 120ms ease-out;
  }
  .panel {
    position: relative;
    width: min(480px, calc(100vw - 40px));
    overflow: hidden;
    border: 1px solid var(--dsw-alias-border-l2, rgba(35, 39, 47, 0.14));
    border-radius: 12px;
    color: var(--dsw-alias-label-primary, #18191c);
    background: var(--dsw-alias-bg-layer-1, #fff);
    box-shadow: 0 22px 70px rgba(18, 22, 31, 0.24);
    animation: rise-in 140ms ease-out;
  }
  .close {
    position: absolute;
    top: 12px;
    right: 12px;
    width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    padding: 0;
    border: 0;
    border-radius: 9px;
    color: var(--dsw-alias-label-secondary, #737780);
    background: transparent;
    cursor: pointer;
  }
  .close:hover { color: var(--dsw-alias-label-primary, #18191c); background: var(--dsw-alias-interactive-bg-hover, rgba(35, 39, 47, 0.08)); }
  .close svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; }
  .body { display: flex; gap: 14px; padding: 28px 48px 24px 24px; }
  .icon {
    width: 34px;
    height: 34px;
    flex: none;
    display: grid;
    place-items: center;
    border-radius: 10px;
    color: #4d6bfe;
    background: rgba(77, 107, 254, 0.1);
  }
  .panel[data-tone="warning"] .icon { color: #b86b00; background: rgba(245, 158, 11, 0.14); }
  .panel[data-tone="error"] .icon { color: #d14343; background: rgba(209, 67, 67, 0.12); }
  .icon svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
  .copy { min-width: 0; padding-top: 1px; }
  h2 { margin: 0; font-size: 16px; font-weight: 600; line-height: 23px; }
  p {
    max-height: min(42vh, 320px);
    margin: 7px 0 0;
    overflow: auto;
    color: var(--dsw-alias-label-secondary, #686d76);
    font-size: 13px;
    line-height: 20px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  footer {
    min-height: 60px;
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--dsw-alias-border-l2, rgba(35, 39, 47, 0.11));
    background: var(--dsw-alias-bg-layer-2, #fafafa);
  }
  button { appearance: none; font: inherit; }
  button:focus-visible { outline: 2px solid #4d6bfe; outline-offset: 2px; }
  .action {
    min-width: 76px;
    min-height: 34px;
    padding: 6px 14px;
    border: 1px solid transparent;
    border-radius: 9px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .action.primary { color: #fff; background: #17181b; }
  .action.primary:hover { background: #2c2e33; }
  .action.secondary { color: var(--dsw-alias-label-primary, #18191c); border-color: var(--dsw-alias-border-l2, rgba(35, 39, 47, 0.14)); background: var(--dsw-alias-bg-layer-1, #fff); }
  .action.secondary:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(35, 39, 47, 0.07)); }
  .action.danger { color: #fff; background: #d14343; }
  .action.danger:hover { background: #ba3434; }
  @keyframes fade-in { from { opacity: 0; } }
  @keyframes rise-in { from { opacity: 0; transform: translateY(6px) scale(0.99); } }
  @media (prefers-color-scheme: dark) {
    .backdrop { background: rgba(0, 0, 0, 0.5); }
    .panel { color: var(--dsw-alias-label-primary, #f5f5f6); background: var(--dsw-alias-bg-layer-1, #1d1d20); border-color: rgba(255, 255, 255, 0.14); box-shadow: 0 22px 70px rgba(0, 0, 0, 0.52); }
    p { color: var(--dsw-alias-label-secondary, #a5a8b0); }
    footer { border-color: rgba(255, 255, 255, 0.11); background: var(--dsw-alias-bg-layer-2, #242428); }
    .action.primary { color: #16171a; background: #f4f4f5; }
    .action.primary:hover { background: #fff; }
    .action.secondary { color: #f5f5f6; border-color: rgba(255, 255, 255, 0.14); background: rgba(255, 255, 255, 0.06); }
  }
  @media (max-width: 520px) {
    .backdrop { padding: 12px; }
    .panel { width: 100%; }
    .body { padding: 24px 44px 20px 20px; }
    footer { flex-wrap: wrap; }
  }
  @media (prefers-reduced-motion: reduce) {
    .backdrop, .panel { animation: none; }
    .backdrop { backdrop-filter: none; }
  }
`
