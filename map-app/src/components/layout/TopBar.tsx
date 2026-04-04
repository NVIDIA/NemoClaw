import { useUiStore } from '@/store'
import { useFilteredMarkers } from '@/hooks/useFilteredMarkers'
import { NationalityDropdown } from '@/components/filters/NationalityDropdown'
import { useFilterStore } from '@/store'

export function TopBar() {
  const { language, toggleLanguage } = useUiStore()
  const filteredCount = useFilteredMarkers().length
  const { nationality } = useFilterStore()

  return (
    <header className="flex-shrink-0 bg-[#0f172a] text-white px-4 py-3 shadow-md z-30">
      <div className="flex items-center justify-between gap-3">
        {/* Logo */}
        <div className="flex items-center gap-2.5 flex-shrink-0">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-yellow-400 to-orange-500 flex items-center justify-center text-lg shadow-md">
            💰
          </div>
          <div>
            <h1 className="font-bold text-base leading-tight">
              {language === 'ko' ? '최저가 지도' : 'Lowest Price Map'}
            </h1>
            <p className="text-[11px] text-slate-400 leading-none">
              {language === 'ko' ? `${filteredCount}개 장소` : `${filteredCount} places`}
            </p>
          </div>
        </div>

        {/* Right side controls */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* Nationality filter */}
          <NationalityDropdown />

          {/* Language toggle */}
          <button
            onClick={toggleLanguage}
            className="px-2.5 py-1.5 rounded-full bg-slate-700 hover:bg-slate-600 text-xs font-bold
              transition-colors text-slate-200 border border-slate-600"
          >
            {language === 'ko' ? 'EN' : '한'}
          </button>
        </div>
      </div>
    </header>
  )
}
