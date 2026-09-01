import type { CoreUpdateStatus } from '../shared/core-update'
import type { UpdateLocale } from './update-view'

export function shouldShowCoreUpdate(status: CoreUpdateStatus): boolean {
  if (['available', 'downloading', 'verifying', 'staged', 'activating'].includes(status.phase)) {
    return true
  }
  return status.manual && ['checking', 'up-to-date', 'error', 'unsupported'].includes(status.phase)
}

export function coreUpdateMessage(status: CoreUpdateStatus, locale: UpdateLocale): string {
  const zh = locale === 'zh'
  const version = status.availableVersion ? ` ${status.availableVersion}` : ''
  switch (status.phase) {
    case 'checking':
      return zh ? '正在检查 DSH 内核更新…' : 'Checking for DSH Core updates…'
    case 'available':
      return zh ? `DSH 内核${version} 可升级` : `DSH Core${version} is available`
    case 'downloading':
      return zh
        ? `正在下载 DSH 内核 ${Math.round(status.percent ?? 0)}%`
        : `Downloading DSH Core ${Math.round(status.percent ?? 0)}%`
    case 'verifying':
      if (status.source === 'embedded') {
        return zh ? '正在准备安装包内置的 DSH 内核…' : 'Preparing the bundled DSH Core…'
      }
      return zh ? '正在验证 DSH 内核…' : 'Verifying DSH Core…'
    case 'staged':
      return zh ? `DSH 内核${version} 已准备好` : `DSH Core${version} is ready`
    case 'activating':
      return zh ? '正在激活并重启 Harness…' : 'Activating and restarting Harness…'
    case 'up-to-date':
      return zh ? 'DSH 内核已是最新版本' : 'DSH Core is up to date'
    case 'unsupported':
      return zh ? '当前版本不支持独立内核更新' : 'Core updates are unavailable in this build'
    case 'error':
      return zh ? 'DSH 内核更新失败' : 'DSH Core update failed'
    case 'idle':
      return ''
  }
}

export function isCoreUpdateDismissed(
  status: CoreUpdateStatus,
  dismissedGeneration: number | null,
  dismissedTransientPhase: CoreUpdateStatus['phase'] | null
): boolean {
  if (status.availableGeneration !== undefined) {
    return status.availableGeneration === dismissedGeneration
  }
  return status.phase === dismissedTransientPhase
}
