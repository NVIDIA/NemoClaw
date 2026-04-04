import { useMemo } from 'react'
import { useAllLocations } from './useAllLocations'
import { getLocationPrice } from './useFilteredMarkers'
import type { PriceCategory } from '@/types'

const ALL_CATEGORIES: PriceCategory[] = [
  'exchange', 'fuel', 'restaurant', 'cafe', 'convenience',
  'jjimjilbang', 'karaoke', 'market', 'attraction', 'extra',
]

export function useAllPriceRanks(): Record<string, 1 | 2 | 3> {
  const all = useAllLocations()

  return useMemo(() => {
    const merged: Record<string, 1 | 2 | 3> = {}

    ALL_CATEGORIES.forEach((cat) => {
      const filtered = all
        .filter((loc) => loc.category === cat)
        .map((loc) => ({ id: loc.id, price: getLocationPrice(loc) }))
        .filter((item) => item.price > 0)
        .sort((a, b) => a.price - b.price)

      filtered.slice(0, 3).forEach((item, i) => {
        merged[item.id] = (i + 1) as 1 | 2 | 3
      })
    })

    return merged
  }, [all])
}
