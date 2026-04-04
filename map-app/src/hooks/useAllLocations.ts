import { useMemo } from 'react'
import type { AnyLocation } from '@/types'

import exchangeData from '@/data/exchange.json'
import fuelData from '@/data/fuel.json'
import restaurantsData from '@/data/restaurants.json'
import cafesData from '@/data/cafes.json'
import convenienceData from '@/data/convenience.json'
import jjimjilbangData from '@/data/jjimjilbang.json'
import karaokeData from '@/data/karaoke.json'
import marketsData from '@/data/markets.json'
import attractionsData from '@/data/attractions.json'
import extrasData from '@/data/extras.json'

export function useAllLocations(): AnyLocation[] {
  return useMemo(() => {
    return [
      ...exchangeData,
      ...fuelData,
      ...restaurantsData,
      ...cafesData,
      ...convenienceData,
      ...jjimjilbangData,
      ...karaokeData,
      ...marketsData,
      ...attractionsData,
      ...extrasData,
    ] as AnyLocation[]
  }, [])
}
