import { Marker, Tooltip } from 'react-leaflet'
import { useFilteredMarkers } from '@/hooks/useFilteredMarkers'
import { useAllPriceRanks } from '@/hooks/useAllPriceRanks'
import { useUiStore } from '@/store'
import { createCategoryIcon } from './CategoryPin'
import { CATEGORY_META } from '@/types'
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

export function MarkerLayer() {
  const markers = useFilteredMarkers()
  const { setSelectedPin } = useUiStore()
  const rankMap = useAllPriceRanks()

  return (
    <>
      {markers.map((loc) => {
        const rank = rankMap[loc.id] as 1 | 2 | 3 | undefined
        const icon = createCategoryIcon(loc.category, rank)
        const meta = CATEGORY_META[loc.category]
        const priceLabel = getDisplayPrice(loc)

        return (
          <Marker
            key={loc.id}
            position={[loc.lat, loc.lng]}
            icon={icon}
            eventHandlers={{
              click: () => setSelectedPin(loc),
            }}
          >
            <Tooltip
              direction="top"
              offset={[0, -42]}
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
