import { Marker, Tooltip } from 'react-leaflet'
import L from 'leaflet'
import { useFilteredMarkers } from '@/hooks/useFilteredMarkers'
import { useAllPriceRanks } from '@/hooks/useAllPriceRanks'
import { useUiStore } from '@/store'
import { createCategoryIcon } from './CategoryPin'
import { CATEGORY_META } from '@/types'
import { EmptyState } from './EmptyState'
import type { AnyLocation } from '@/types'

function getDisplayPrice(loc: AnyLocation): string {
  switch (loc.category) {
    case 'exchange': {
      const usd = loc.rates.find((r) => r.currency === 'USD')
      return usd ? `$1 = ₩${usd.buyRate.toLocaleString()}` : ''
    }
    case 'fuel': {
      if (loc.prices.gasoline) return `휘발유 ₩${loc.prices.gasoline.toLocaleString()}/L`
      if (loc.prices.electric) return `전기 ₩${loc.prices.electric}/kWh`
      if (loc.prices.hydrogen) return `수소 ₩${loc.prices.hydrogen?.toLocaleString()}/kg`
      return ''
    }
    case 'restaurant': return `₩${loc.pricePerPerson.toLocaleString()}/인`
    case 'cafe': return `아메리카노 ₩${loc.americanoPrice.toLocaleString()}`
    case 'convenience': return `평균 ₩${loc.avgItemPrice.toLocaleString()}`
    case 'jjimjilbang': return `입장 ₩${loc.entryFee.toLocaleString()}`
    case 'karaoke': return `₩${Math.min(...loc.rates.map((r) => r.pricePerHour)).toLocaleString()}/시간`
    case 'market': return `₩${Math.min(...loc.popularItems.map((i) => i.price)).toLocaleString()}~`
    case 'attraction': {
      const paid = loc.tickets.filter((t) => t.price > 0)
      if (loc.freeEntry || paid.length === 0) return '무료 입장'
      return `₩${Math.min(...paid.map((t) => t.price)).toLocaleString()}~`
    }
    case 'extra': return `₩${loc.price.toLocaleString()}/${loc.priceUnit}`
    default: return ''
  }
}

function createSelectedIcon(loc: AnyLocation, rank: 1 | 2 | 3 | undefined) {
  const meta = CATEGORY_META[loc.category]
  const rankStyle = rank === 1
    ? 'background:#fbbf24;border-color:#f59e0b'
    : rank === 2
    ? 'background:#94a3b8;border-color:#64748b'
    : rank === 3
    ? 'background:#cd7c4a;border-color:#a16207'
    : `background:${meta.color};border-color:${meta.color}`

  const html = `
    <div style="
      width:44px;height:44px;border-radius:50%;display:flex;align-items:center;
      justify-content:center;font-size:20px;border:4px solid white;
      box-shadow:0 0 0 3px ${meta.color},0 4px 12px rgba(0,0,0,0.35);
      transform:scale(1.25);${rankStyle}
    ">${meta.emoji}</div>
  `
  return L.divIcon({ html, className: '', iconSize: [44, 44], iconAnchor: [22, 22] })
}

export function MarkerLayer() {
  const markers = useFilteredMarkers()
  const { setSelectedPin, selectedPin } = useUiStore()
  const rankMap = useAllPriceRanks()

  return (
    <>
      {markers.length === 0 && <EmptyState />}
      {markers.map((loc) => {
        const rank = rankMap[loc.id] as 1 | 2 | 3 | undefined
        const isSelected = selectedPin?.id === loc.id
        const icon = isSelected
          ? createSelectedIcon(loc, rank)
          : createCategoryIcon(loc.category, rank)
        const meta = CATEGORY_META[loc.category]
        const priceLabel = getDisplayPrice(loc)

        return (
          <Marker
            key={loc.id}
            position={[loc.lat, loc.lng]}
            icon={icon}
            zIndexOffset={isSelected ? 1000 : 0}
            eventHandlers={{
              click: () => setSelectedPin(loc),
            }}
          >
            <Tooltip
              direction="top"
              offset={[0, isSelected ? -54 : -42]}
              opacity={1}
              className="!bg-white !border-0 !shadow-lg !rounded-xl !px-3 !py-2 !text-sm"
            >
              <div className="flex flex-col gap-0.5 min-w-[120px]">
                <div className="flex items-center gap-1.5">
                  <span>{meta.emoji}</span>
                  <span className="font-semibold text-slate-800">{loc.name}</span>
                  {rank === 1 && <span>👑</span>}
                </div>
                {priceLabel && (
                  <div className="text-xs text-emerald-700 font-medium">{priceLabel}</div>
                )}
              </div>
            </Tooltip>
          </Marker>
        )
      })}
    </>
  )
}
