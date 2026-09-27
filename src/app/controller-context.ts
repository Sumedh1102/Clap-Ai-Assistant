import { createContext, useContext } from 'react'
import type { ClapController } from './controller'

export const ControllerContext = createContext<ClapController | null>(null)

export function useController(): ClapController {
  const controller = useContext(ControllerContext)
  if (!controller) throw new Error('useController must be used inside ControllerContext')
  return controller
}
