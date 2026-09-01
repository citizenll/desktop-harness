declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ReactElement } from 'react'

  export interface IconProps {
    size?: number
    className?: string
  }

  export function IconLoadingOutline16(props: IconProps): ReactElement
  export function IconSparkle16(props: IconProps): ReactElement
  export function IconWarningOutline16(props: IconProps): ReactElement
}
