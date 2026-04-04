import { PriceRangeSlider } from '@/components/filters/PriceRangeSlider'
import { useUiStore, useFilterStore, useFavoritesStore } from '@/store'
import { useAllLocations } from '@/hooks/useAllLocations'
import { useUiStore as useUi } from '@/store'
import { CATEGORY_META } from '@/types'
import type { PriceCategory } from '@/types'

const CATEGORIES: PriceCategory[] = [
  'exchange', 'fuel', 'restaurant', 'cafe', 'convenience',
  'jjimjilbang', 'karaoke', 'market', 'attraction', 'extra',
]

const STAT_CATEGORIES: { emoji: string; cat: PriceCategory; labelKo: string; labelEn: string }[] = [
  { emoji: '💱', cat: 'exchange', labelKo: '환전소', labelEn: 'Exchange' },
  { emoji: '⛽', cat: 'fuel', labelKo: '주유소', labelEn: 'Fuel' },
  { emoji: '🍜', cat: 'restaurant', labelKo: '식당', labelEn: 'Restaurants' },
  { emoji: '☕', cat: 'cafe', labelKo: '카페', labelEn: 'Cafes' },
]

export function Sidebar() {
  const { language } = useUiStore()
  const { activeCategories, toggleCategory, clearCategories, showCheapestOnly, toggleCheapestOnly } = useFilterStore()
  const { favoriteIds, clear: clearFavs } = useFavoritesStore()
  const { setSelectedPin } = useUi()
  const all = useAllLocations()

  const countByCategory = CATEGORIES.reduce<Record<string, number>>((acc, cat) => {
    acc[cat] = all.filter((l) => l.category === cat).length
    return acc
  }, {})

  return (
    <aside className="hidden lg:flex flex-col w-64 xl:w-72 bg-white border-r border-slate-100 overflow-y-auto flex-shrink-0">
      <div className="p-4 space-y-4">
        {/* Category filter */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-slate-700">
              {language === 'ko' ? '카테고리' : 'Categories'}
            </h3>
            {activeCategories.length > 0 && (
              <button
                onClick={clearCategories}
                className="text-xs text-blue-600 hover:text-blue-800 font-medium"
              >
                {language === 'ko' ? '전체보기' : 'All'}
              </button>
            )}
          </div>
          <div className="space-y-1">
            {CATEGORIES.map((cat) => {
              const meta = CATEGORY_META[cat]
              const isActive = activeCategories.includes(cat)
              const count = countByCategory[cat] ?? 0
              return (
                <button
                  key={cat}
                  onClick={() => toggleCategory(cat)}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-xl transition-all text-sm
                    ${isActive
                      ? 'text-white shadow-sm'
                      : 'text-slate-600 hover:bg-slate-50'
                    }`}
                  style={isActive ? { backgroundColor: meta.color } : {}}
                >
                  <div className="flex items-center gap-2.5">
                    <span className="text-lg">{meta.emoji}</span>
                    <span className="font-medium">{language === 'ko' ? meta.label : meta.labelEn}</span>
                  </div>
                  <span className={`text-xs font-semibold px-1.5 py-0.5 rounded-full
                    ${isActive ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500'}`}>
                    {count}
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        {/* Price range */}
        <PriceRangeSlider />

        {/* Cheapest-only toggle */}
        <div className="bg-yellow-50 rounded-2xl p-3 border border-yellow-100">
          <button
            onClick={toggleCheapestOnly}
            className="w-full flex items-center justify-between"
          >
            <div className="flex items-center gap-2">
              <span className="text-lg">👑</span>
              <div className="text-left">
                <div className="text-sm font-semibold text-slate-800">
                  {language === 'ko' ? '최저가만 보기' : 'Cheapest Only'}
                </div>
                <div className="text-xs text-slate-400">
                  {language === 'ko' ? '각 카테고리 1위 핀만 표시' : 'Show only #1 pin per category'}
                </div>
              </div>
            </div>
            <div className={`w-11 h-6 rounded-full transition-colors relative flex-shrink-0
              ${showCheapestOnly ? 'bg-yellow-400' : 'bg-slate-200'}`}>
              <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform
                ${showCheapestOnly ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </div>
          </button>
        </div>

        {/* Favorites section */}
        {favoriteIds.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-slate-700">
                ❤️ {language === 'ko' ? `즐겨찾기 (${favoriteIds.length})` : `Favorites (${favoriteIds.length})`}
              </h3>
              <button
                onClick={clearFavs}
                className="text-xs text-slate-400 hover:text-red-500 font-medium transition-colors"
              >
                {language === 'ko' ? '전체삭제' : 'Clear all'}
              </button>
            </div>
            <div className="space-y-1.5">
              {favoriteIds.map((id) => {
                const loc = all.find((l) => l.id === id)
                if (!loc) return null
                const m = CATEGORY_META[loc.category]
                return (
                  <button
                    key={id}
                    onClick={() => setSelectedPin(loc)}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-slate-50 transition-colors text-left"
                  >
                    <span className="text-base">{m.emoji}</span>
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-700 truncate">
                        {language === 'ko' ? loc.name : (loc.nameEn || loc.name)}
                      </div>
                      <div className="text-xs text-slate-400 truncate">{loc.address}</div>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* Stats — dynamic */}
        <div className="bg-gradient-to-br from-slate-800 to-slate-900 rounded-2xl p-4 text-white">
          <div className="text-xs font-semibold text-slate-400 mb-3 uppercase tracking-wide">
            {language === 'ko' ? '데이터 현황' : 'Data Overview'}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {STAT_CATEGORIES.map((s) => (
              <div key={s.cat} className="bg-white/10 rounded-xl p-2 text-center">
                <div className="text-lg">{s.emoji}</div>
                <div className="text-base font-bold">{countByCategory[s.cat] ?? 0}</div>
                <div className="text-[10px] text-slate-400">
                  {language === 'ko' ? s.labelKo : s.labelEn}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 text-center text-xs text-slate-500">
            {language === 'ko' ? `전체 ${all.length}개 장소` : `${all.length} total places`}
          </div>
        </div>
      </div>
    </aside>
  )
}
