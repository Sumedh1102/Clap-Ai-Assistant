import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { ClapController } from './app/controller'
import { ControllerContext } from './app/controller-context'
import './styles.css'

// One controller for the life of the page, created outside React so that
// StrictMode's double-mounting in development can't open two bridge sessions.
const controller = new ClapController()
controller.start()
window.addEventListener('pagehide', () => controller.dispose())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ControllerContext.Provider value={controller}>
      <App />
    </ControllerContext.Provider>
  </StrictMode>,
)
