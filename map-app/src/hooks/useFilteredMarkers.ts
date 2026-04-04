import { useMemo } from 'react'
import { useFilterStore } from '@/store'
import { useAllLocations } from './useAllLocations'
import type { AnyLocation, Restaurant } from '@/types'

function getLocationPrice(loc: AnyLocation): number {
  switch (loc.category) {
    case 'exchange': return 0 // show all exchange shops
    case 'fuel': {
      const prices = Object.values(loc.prices).filter(Boolean) as number[]
      return prices.length ? Math.min(...prices) : 0
    }
    case 'restaurant': return loc.pricePerPerson
    case 'cafe': return loc.americanoPrice
    case 'convenience': return loc.avgItemPrice
    case 'jjimjilbang': return loc.entryFee
    case 'karaoke': {
      const rates = loc.rates.map((r) => r.pricePerHour)
      return Math.min(...rates)
    }
    case 'market': {
      const prices = loc.popularItems.map((i) => i.price)
      return Math.min(...prices)
    }
    case 'attraction': {
      const paid = loc.tickets.filter((t) => t.price > 0)
      return paid.length ? Math.min(...paid.map((t) => t.price)) : 0
    }
    case 'extra': return loc.price
    default: return 0
  }
}

export function useFilteredMarkers(): AnyLocation[] {
  const { activeCategories, nationality, priceRange } = useFilterStore()
  const all = useAllLocations()

  return useMemo(() => {
    return all.filter((loc) => {
      // Category filter
      if (activeCategories.length > 0 && !activeCategories.includes(loc.category)) {
        return false
      }

      // Nationality filter (only for restaurants)
      if (nationality !== 'all' && loc.category === 'restaurant') {
        const rest = loc as Restaurant
        if (!rest.nationalityTags.includes(nationality) && !rest.nationalityTags.includes('all')) {
          return false
        }
      }

      // Price range filter
      const price = getLocationPrice(loc)
      if (price > 0 && (price < priceRange[0] || price > priceRange[1])) {
        return false
      }

      return true
    })
  }, [all, activeCategories, nationality, priceRange])
}

export { getLocationPrice }
