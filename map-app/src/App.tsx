import { useEffect } from 'react'
import { TopBar } from './components/layout/TopBar'
import { Sidebar } from './components/layout/Sidebar'
import { MapContainer } from './components/map/MapContainer'
import { CategoryFilterBar } from './components/filters/CategoryFilterBar'
import { DesktopDetailPanel, MobileBottomSheet } from './components/panels/DetailPanel'
import { useUiStore } from './store'

export default function App() {
  const { setIsMobile } = useUiStore()

  useEffect(() => {
    const handle = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener('resize', handle)
    return () => window.removeEventListener('resize', handle)
  }, [setIsMobile])

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-slate-50">
      {/* Top navigation bar */}
      <TopBar />

      {/* Main content area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Desktop sidebar */}
        <Sidebar />

        {/* Map + filter bar + detail panel */}
        <div className="flex flex-col flex-1 overflow-hidden">
          {/* Mobile category filter bar */}
          <div className="lg:hidden bg-white border-b border-slate-100 shadow-sm z-20 flex-shrink-0">
            <CategoryFilterBar />
          </div>

          {/* Map area + right detail panel */}
          <div className="flex flex-1 overflow-hidden relative">
            {/* Map */}
            <div className="flex-1 relative z-0">
              <MapContainer />
            </div>

            {/* Desktop detail panel (slides in from right) */}
            <DesktopDetailPanel />
          </div>
        </div>
      </div>

      {/* Mobile bottom sheet */}
      <MobileBottomSheet />
    </div>
  )
}
