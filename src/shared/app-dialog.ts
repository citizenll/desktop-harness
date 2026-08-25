export const DSH_DESKTOP_DIALOG_SHOW_CHANNEL = 'app-dialog:show'
export const DSH_DESKTOP_DIALOG_RESPONSE_CHANNEL = 'app-dialog:response'

export type DesktopDialogTone = 'info' | 'warning' | 'error'
export type DesktopDialogButtonKind = 'primary' | 'secondary' | 'danger'

export interface DesktopDialogButton {
  label: string
  kind?: DesktopDialogButtonKind
}

export interface DesktopDialogRequest {
  id: number
  tone: DesktopDialogTone
  message: string
  detail?: string
  buttons: DesktopDialogButton[]
  defaultId: number
  cancelId: number
}

export interface DesktopDialogResponse {
  id: number
  response: number
}
