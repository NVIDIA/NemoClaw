import { useUiStore } from '@/store'
import { CATEGORY_META } from '@/types'
import { ExchangeDetail } from './ExchangeDetail'
import { FuelDetail } from './FuelDetail'
import { RestaurantDetail } from './RestaurantDetail'
import { GenericDetail } from './GenericDetail'
import type { ExchangeLocation, FuelStation, Restaurant } from '@/types'

interface PanelContentProps {
  onClose: () => void
}

export function PanelContent({ onClose }: PanelContentProps) {
  const { selectedPin, language } = useUiStore()

  if (!selectedPin) return null

  const meta = CATEGORY_META[selectedPin.category]

  function renderDetail() {
    if (!selectedPin) return null
    switch (selectedPin.category) {
      case 'exchange': return <ExchangeDetail location={selectedPin as ExchangeLocation} />
      case 'fuel': return <FuelDetail location={selectedPin as FuelStation} />
      case 'restaurant': return <RestaurantDetail location={selectedPin as Restaurant} />
      default: return <GenericDetail location={selectedPin} />
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-start justify-between p-4 pb-3 border-b border-slate-100">
        <div className="flex items-start gap-3">
          <div
            className="w-11 h-11 rounded-2xl flex items-center justify-center text-2xl flex-shrink-0"
            style={{ backgroundColor: `${meta.color}20` }}
          >
            {meta.emoji}
          </div>
          <div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <h2 className="text-base font-bold text-slate-900 leading-tight">
                {language === 'ko' ? selectedPin.name : (selectedPin.nameEn || selectedPin.name)}
              </h2>
            </div>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span
                className="text-xs font-medium px-2 py-0.5 rounded-full"
                style={{ backgroundColor: `${meta.color}20`, color: meta.color }}
              >
                {language === 'ko' ? meta.label : meta.labelEn}
              </span>
              {selectedPin.rating && (
                <span className="text-xs text-slate-500">⭐ {selectedPin.rating}</span>
              )}
            </div>
            {selectedPin.address && (
              <p className="text-xs text-slate-400 mt-1 leading-tight">{selectedPin.address}</p>
            )}
          </div>
        </div>
        <button
          onClick={onClose}
          className="w-8 h-8 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-600 transition-colors flex-shrink-0 ml-2"
        >
          ✕
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {renderDetail()}

        {/* Phone / website */}
        {(selectedPin.phone || selectedPin.website) && (
          <div className="mt-4 pt-4 border-t border-slate-100 space-y-1.5">
            {selectedPin.phone && (
              <div className="flex items-center gap-2 text-sm text-slate-600">
                <span>📞</span>
                <a href={`tel:${selectedPin.phone}`} className="hover:text-blue-600">{selectedPin.phone}</a>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// Desktop sidebar panel
export function DesktopDetailPanel() {
  const { isPanelOpen, closePanl } = useUiStore()

  return (
    <div
      className={`hidden md:flex flex-col w-80 xl:w-96 bg-white border-l border-slate-100 shadow-xl
        transition-all duration-300 flex-shrink-0
        ${isPanelOpen ? 'translate-x-0' : 'translate-x-full'}`}
    >
      {isPanelOpen && <PanelContent onClose={closePanl} />}
    </div>
  )
}

// Mobile bottom sheet
export function MobileBottomSheet() {
  const { isPanelOpen, closePanl } = useUiStore()

  return (
    <>
      {/* Backdrop */}
      {isPanelOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/30 z-40"
          onClick={closePanl}
        />
      )}
      <div
        className={`md:hidden fixed bottom-0 left-0 right-0 bg-white rounded-t-3xl shadow-2xl z-50
          transition-transform duration-300
          ${isPanelOpen ? 'translate-y-0' : 'translate-y-full'}`}
        style={{ maxHeight: '70vh' }}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 bg-slate-200 rounded-full" />
        </div>
        <div className="overflow-y-auto" style={{ maxHeight: 'calc(70vh - 24px)' }}>
          {isPanelOpen && <PanelContent onClose={closePanl} />}
        </div>
      </div>
    </>
  )
}
