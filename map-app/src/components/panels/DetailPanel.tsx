import { useRef, useEffect } from 'react'
import { useUiStore } from '@/store'
import { useFavoritesStore } from '@/store/favoritesStore'
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
  const { isFavorite, toggle } = useFavoritesStore()
  const scrollRef = useRef<HTMLDivElement>(null)

  // Reset scroll when pin changes
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [selectedPin?.id])

  if (!selectedPin) return null

  const meta = CATEGORY_META[selectedPin.category]
  const fav = isFavorite(selectedPin.id)

  function renderDetail() {
    if (!selectedPin) return null
    switch (selectedPin.category) {
      case 'exchange': return <ExchangeDetail location={selectedPin as ExchangeLocation} />
      case 'fuel': return <FuelDetail location={selectedPin as FuelStation} />
      case 'restaurant': return <RestaurantDetail location={selectedPin as Restaurant} />
      default: return <GenericDetail location={selectedPin} />
    }
  }

  const kakaoUrl = `https://map.kakao.com/link/map/${encodeURIComponent(selectedPin.name)},${selectedPin.lat},${selectedPin.lng}`
  const googleUrl = `https://www.google.com/maps/search/?api=1&query=${selectedPin.lat},${selectedPin.lng}`

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-start justify-between p-4 pb-3 border-b border-slate-100">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          <div
            className="w-11 h-11 rounded-2xl flex items-center justify-center text-2xl flex-shrink-0"
            style={{ backgroundColor: `${meta.color}20` }}
          >
            {meta.emoji}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <h2 className="text-base font-bold text-slate-900 leading-tight">
                {language === 'ko' ? selectedPin.name : (selectedPin.nameEn || selectedPin.name)}
              </h2>
            </div>
            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
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
              <p className="text-xs text-slate-400 mt-1 leading-tight truncate">{selectedPin.address}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0 ml-2">
          {/* Favorites button */}
          <button
            onClick={() => toggle(selectedPin.id)}
            className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors
              ${fav ? 'text-red-500 bg-red-50' : 'text-slate-300 hover:text-red-400 hover:bg-red-50'}`}
            title={fav ? (language === 'ko' ? '즐겨찾기 해제' : 'Remove from favorites') : (language === 'ko' ? '즐겨찾기 추가' : 'Add to favorites')}
          >
            {fav ? '❤️' : '🤍'}
          </button>
          {/* Close button */}
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-600 transition-colors"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Scrollable content */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
        {renderDetail()}

        {/* Phone */}
        {selectedPin.phone && (
          <div className="pt-3 border-t border-slate-100">
            <div className="flex items-center gap-2 text-sm text-slate-600">
              <span>📞</span>
              <a href={`tel:${selectedPin.phone}`} className="hover:text-blue-600">{selectedPin.phone}</a>
            </div>
          </div>
        )}

        {/* Open in Maps */}
        <div className="pt-3 border-t border-slate-100 grid grid-cols-2 gap-2">
          <a
            href={kakaoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-yellow-400 hover:bg-yellow-500 text-yellow-900 text-xs font-semibold transition-colors"
          >
            🗺️ {language === 'ko' ? '카카오맵' : 'Kakao Map'}
          </a>
          <a
            href={googleUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-blue-500 hover:bg-blue-600 text-white text-xs font-semibold transition-colors"
          >
            📍 Google Maps
          </a>
        </div>
      </div>
    </div>
  )
}

// Desktop sidebar panel
export function DesktopDetailPanel() {
  const { isPanelOpen, closePanel } = useUiStore()

  return (
    <div
      className={`hidden md:flex flex-col w-80 xl:w-96 bg-white border-l border-slate-100 shadow-xl
        transition-all duration-300 flex-shrink-0 overflow-hidden
        ${isPanelOpen ? 'opacity-100' : 'w-0 opacity-0 pointer-events-none'}`}
      style={{ width: isPanelOpen ? undefined : 0 }}
    >
      {isPanelOpen && <PanelContent onClose={closePanel} />}
    </div>
  )
}

// Mobile bottom sheet with drag support
export function MobileBottomSheet() {
  const { isPanelOpen, closePanel } = useUiStore()

  return (
    <>
      {isPanelOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/30 z-40"
          onClick={closePanel}
        />
      )}
      <div
        className={`md:hidden fixed bottom-0 left-0 right-0 bg-white rounded-t-3xl shadow-2xl z-50
          transition-transform duration-300
          ${isPanelOpen ? 'translate-y-0' : 'translate-y-full'}`}
        style={{ maxHeight: '75vh' }}
      >
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 bg-slate-200 rounded-full" />
        </div>
        <div className="overflow-y-auto" style={{ maxHeight: 'calc(75vh - 24px)' }}>
          {isPanelOpen && <PanelContent onClose={closePanel} />}
        </div>
      </div>
    </>
  )
}
