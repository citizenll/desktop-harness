import { describe, expect, it } from 'vitest'
import {
  renderDesktopPairingPage,
  renderMobilePage,
  renderMobileReconnectPage,
  renderPairingWaitPage
} from '../src/main/mobile/lan-mobile-pages'

describe('LAN mobile page', () => {
  it('emits parseable browser JavaScript', () => {
    const html = renderMobilePage({ locale: 'zh' })
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]!)
    expect(scripts).not.toHaveLength(0)
    for (const script of scripts) expect(() => new Function(script)).not.toThrow()
  })

  it('uses the DSH brand color and follows system dark mode', () => {
    const html = renderMobilePage({ locale: 'en' })
    expect(html).toContain('--brand:#4d6bfe')
    expect(html).toContain('prefers-color-scheme:dark')
    expect(html).toContain('content="#ffffff" media="(prefers-color-scheme:light)"')
    expect(html).toContain('content="#141416" media="(prefers-color-scheme:dark)"')
    expect(html).toContain('/brand-logo/light')
    expect(html).not.toContain('id="chatTitle"')
    expect(html).toContain('body.chat-open header{display:none}')
    expect(html).toContain('body.chat-open .shell{padding:env(safe-area-inset-top) 14px 0}')
    expect(html).toContain('.chat-toolbar{position:absolute;inset:0 0 auto;z-index:2;min-height:40px;padding:0;background:transparent')
    expect(html).toContain('background:var(--card)!important;box-shadow:0 2px 8px')
    expect(html).toContain('.chat-open .messages{padding-top:4px;padding-bottom:84px}')
    expect(html).toContain('.composer{position:absolute;z-index:2;inset:auto 0 0;padding:10px 0 4px;background:transparent;pointer-events:none}')
    expect(html).toContain('background:var(--card);box-shadow:0 4px 16px rgba(0,0,0,.05);pointer-events:auto')
    expect(html).toContain('@media(display-mode:standalone)')
    expect(html).not.toContain("</svg>返回</button>")
    expect(html).not.toContain("</svg>Back</button>")
    expect(html).toContain("document.body.classList.add('chat-open')")
    expect(html).toContain("document.body.classList.remove('chat-open')")
    expect(html).toContain("history.replaceState({view:'sessions'},'')")
    expect(html).toContain("history.pushState({view:'chat',sessionId:id")
    expect(html).toContain("window.addEventListener('popstate'")
    expect(html).toContain("if(history.state?.view==='chat')history.back()")
    expect(html).toContain("function showSessionList()")
    expect(html).toContain("function handleHistory(state)")
    expect(html).toContain('class=\"skeleton\"')
    expect(html).toContain('agentRunning?250:750')
    expect(html).toContain("t==='user/message'")
    expect(html).toContain("message.source?.kind==='user'")
    expect(html).toContain("t==='assistant/message'")
    expect(html).not.toContain('id=\"stop\"')
    expect(html).toContain('id=\"cancel\"')
    expect(html).toContain("chunk.type==='text-delta'")
    expect(html).toContain("block?.type==='text'")
    expect(html).toContain('font-size:16px')
    expect(html).toContain('maximum-scale=1')
    expect(html).toContain('rel="apple-touch-icon" href="/app-icon"')
    expect(html).toContain('apple-mobile-web-app-capable')
    expect(html).toContain("chunk.type!=='reasoning-delta'")
    expect(html).toContain('class=\"thinking\"')
    expect(html).toContain("streamKey=kind+':'+String(chunk.index??0)")
    expect(html).toContain("(streaming?' open':'')")
    expect(html).toContain('key=JSON.stringify(messages)')
    expect(html).toContain('class=\"tool\"')
    expect(html).toContain('function markdown(text)')
    expect(html).toContain('function tableCells(line)')
    expect(html).toContain('class=\"table-wrap\"')
    expect(html).toContain('flex-direction:column;gap:0')
    expect(html).toContain('visualViewport')
    expect(html).toContain('var(--app-height,100dvh)')
    expect(html).toContain('id=\"workspaceHint\"')
    expect(html).toContain('id=\"newSession\" class=\"new-session\" disabled')
    expect(html).toContain('class=\"session-hero\"')
    expect(html).toContain('class=\"workspace-panel\"')
    expect(html).toContain('padding:calc(6px + env(safe-area-inset-top))')
    expect(html).toContain('header{height:48px')
    expect(html).toContain('.session-hero{display:flex;align-items:center')
    expect(html).toContain('padding:7px 2px 11px')
    expect(html).toContain('.session-actions select{flex:1;min-width:0;height:39px')
    expect(html).toContain('id=\"sessionCount\" class=\"session-count\"')
    expect(html).toContain('class=\"session-mark\"')
    expect(html).toContain('class=\"row-copy\"')
    expect(html).toContain("workspaces[0].workspaceId")
    expect(html).toContain('function refreshAll()')
    expect(html).toContain('function relativeTime(value)')
    expect(html).toContain("<time>'+esc(relativeTime(s.updatedAt))+'</time>")
    expect(html).toContain("$('workspaceHint').hidden=selected")
    expect(html).toContain('showToast(L.refreshed)')
    expect(html).not.toContain("esc(s.cwd||s.sessionId)")
    expect(html).toContain('@keyframes connectedPulse')
    expect(html).not.toContain('Connected on local network')
    expect(html).toContain("fetch('/api/status',{cache:'no-store'})")
    expect(html).toContain("location.replace('/disconnected')")
    expect(html).toContain('setInterval(checkConnection,1500)')
    expect(html).toContain("status.classList.add('error-state')")
    expect(html).toContain("if(r.status===401)")
    expect(html).toContain('e.disconnected=true')
    expect(html).toContain("function showError(id,error)")
    expect(html).toContain("showError('chatError',e)")
    expect(html).not.toContain("$('chatError').textContent=e.message")
    expect(html).toContain('archivedSessionIds=value.archivedSessionIds||[]')
    expect(html).toContain('archived=new Set(archivedSessionIds)')
    expect(html).not.toContain('new Set(value.archivedSessionIds||[])')
    expect(html).toContain('!archived.has(s.sessionId)')
  })

  it('renders an adaptive reconnect action for the Home Screen app', () => {
    const zh = renderMobileReconnectPage('zh')
    const en = renderMobileReconnectPage('en')
    expect(zh).toContain('连接已断开')
    expect(zh).toContain('href="/reconnect">重新连接')
    expect(zh).toContain('局域网需连接同一 Wi-Fi，公网需保持临时通道开启')
    expect(zh).not.toContain('class="approval"')
    expect(zh).not.toContain('class="network"')
    expect(zh).not.toContain('class="symbol"')
    expect(en).toContain('Connection lost')
    for (const html of [zh, en]) {
      expect(html).toContain('prefers-color-scheme:dark')
      expect(html).toContain('/brand-logo/light')
      expect(html).toContain('/brand-logo/dark')
    }
  })

  it('uses DSH styling on both pairing surfaces', () => {
    const desktop = renderDesktopPairingPage({
      lanPairingUrl: 'http://192.168.1.2/pair?token=test',
      tunnel: { phase: 'idle' },
      expiresAt: Date.now() + 60_000,
      locale: 'en',
      connected: false
    })
    const phone = renderPairingWaitPage('pairing-id', 'en')
    for (const html of [desktop, phone]) {
      expect(html).toContain('/brand-logo/light')
      for (const script of [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
        (match) => match[1]!
      ))
        expect(() => new Function(script)).not.toThrow()
    }
    expect(desktop).toContain('/desktop/disconnect')
    expect(desktop).toContain('--request-accent:#c16f52')
    expect(desktop).toContain('--request-border:#dfbcae')
    expect(desktop).toContain('--request-bg:#fbf6f3')
    expect(desktop).not.toContain('--request-bg:#f5f7ff')
    expect(desktop).toContain('prefers-color-scheme:dark')
    expect(desktop).toContain('/brand-logo/dark')
    expect(desktop).toContain('--bg:#141416')
    expect(desktop).toContain('.qr{width:112px;height:112px;display:grid')
    expect(desktop).toContain('Phone connected')
    expect(desktop).toContain('You can close this window now.')
    expect(desktop).toContain('onclick="finishPanel()">Done</button>')
    expect(desktop).toContain("document.body.classList.toggle('phone-connected'")
    expect(desktop).toContain('container-type:inline-size')
    expect(desktop).toContain('@container (max-width:340px)')
    expect(desktop).toContain('phaseChip={idle:T.chipIdle')
    expect(desktop).toContain('/desktop/tunnel/start')
    expect(desktop).toContain('/desktop/tunnel/stop')
    expect(desktop).toContain('/desktop/qr?target=')
    expect(desktop).toContain('Temporary public route')
    expect(desktop).toContain('Public access never bypasses desktop approval')
    expect(phone).toContain('prefers-color-scheme:dark')
    expect(phone).toContain('--brand:#4d6bfe')
    expect(phone).toContain('--bg:#141416')
    expect(phone).toContain('/brand-logo/dark')
    expect(phone).toContain('background:var(--panel)')
    expect(phone).toContain('content="#141416" media="(prefers-color-scheme:dark)"')
    expect(phone).toContain('id="retry" class="retry"')
    expect(phone).toContain("fetch('/pair/retry'")
    expect(phone).toContain('Request approval again')
    expect(phone).toContain('Cannot reach the desktop. Start DSH Desktop and try again.')
    expect(phone).toContain("location.replace('/')")
    expect(phone).not.toContain("location.href='/'")
  })

  it('localizes both pairing surfaces from the desktop preference', () => {
    const desktop = renderDesktopPairingPage({
      lanPairingUrl: 'http://192.168.1.2/pair?token=test',
      tunnel: { phase: 'idle' },
      expiresAt: Date.now() + 60_000,
      locale: 'zh',
      connected: false
    })
    const phone = renderPairingWaitPage('pairing-id', 'zh')
    expect(desktop).toContain('<html lang="zh-CN">')
    expect(desktop).toContain('连接你的手机')
    expect(desktop).toContain('临时公网通道')
    expect(desktop).toContain('开启公网访问')
    expect(desktop).toContain('断开连接')
    expect(desktop).toContain('现在可以关闭此窗口。')
    expect(desktop).toContain('onclick="finishPanel()">完成</button>')
    expect(phone).toContain('请在 DSH Desktop 中确认连接请求。')
    expect(phone).toContain('再次发起申请')
    expect(phone).toContain('暂时无法连接桌面端，请先启动 DSH Desktop。')
  })

  it('renders a compact management state when a phone is already connected', () => {
    const desktop = renderDesktopPairingPage({
      lanPairingUrl: 'http://192.168.1.2/pair?token=test',
      publicPairingUrl: 'https://example.trycloudflare.com/pair?token=test',
      tunnel: { phase: 'ready', url: 'https://example.trycloudflare.com' },
      expiresAt: Date.now() + 60_000,
      locale: 'en',
      connected: true
    })
    expect(desktop).toContain('class="phone-connected manage-connected"')
    expect(desktop).toContain('Manage phone connection')
    expect(desktop).toContain('A phone is connected. You can still switch routes')
    expect(desktop).toContain('https://example.trycloudflare.com')
  })

  it('renders an embeddable panel surface with a parent-targeted close action', () => {
    const desktop = renderDesktopPairingPage({
      lanPairingUrl: 'http://192.168.1.2/pair?token=test',
      tunnel: { phase: 'idle' },
      expiresAt: Date.now() + 60_000,
      locale: 'zh',
      connected: true,
      embedded: true,
      parentOrigin: 'http://127.0.0.1:9999'
    })
    expect(desktop).toContain('class="phone-connected manage-connected embedded"')
    expect(desktop).toContain('.embedded .brand{display:none}')
    expect(desktop).toContain('现在可以关闭此面板。')
    expect(desktop).toContain("window.parent.postMessage({type:'dsh-mobile-panel-close'}")
    expect(desktop).toContain('PARENT_ORIGIN="http://127.0.0.1:9999"')
  })
})
