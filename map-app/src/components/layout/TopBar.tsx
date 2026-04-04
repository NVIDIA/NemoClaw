import { useState, useRef, useEffect } from 'react'
import { useUiStore } from '@/store'
import { useFilteredMarkers } from '@/hooks/useFilteredMarkers'
import { NationalityDropdown } from '@/components/filters/NationalityDropdown'
import { useFilterStore } from '@/store'

export function TopBar() {
  const { language, toggleLanguage } = useUiStore()
  const filteredCount = useFilteredMarkers().length
  const { searchQuery, setSearchQuery } = useFilterStore()
  const [searchOpen, setSearchOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (searchOpen && inputRef.current) {
      inputRef.current.focus()
    }
  }, [searchOpen])

  function handleSearchToggle() {
    if (searchOpen && searchQuery) {
      setSearchQuery('')
    } else {
      setSearchOpen((v) => !v)
    }
  }

  return (
    <header className="flex-shrink-0 bg-bg-layer-default text-fg-neutral px-4 py-3 shadow-sm border-b border-stroke-neutral-subtle z-30">
      <div className="flex items-center justify-between gap-3">
        {/* Logo */}
        <div className="flex items-center gap-2.5 flex-shrink-0">
          <div className="w-9 h-9 rounded-xl bg-bg-brand-solid flex items-center justify-center text-lg shadow-sm">
            💰
          </div>
          <div>
            <h1 className="font-bold text-base leading-tight text-fg-brand">
              {language === 'ko' ? '최저가 지도' : 'Lowest Price Map'}
            </h1>
            <p className="text-[11px] text-fg-neutral-subtle leading-none">
              {language === 'ko' ? `${filteredCount}개 장소` : `${filteredCount} places`}
            </p>
          </div>
        </div>

        {/* Search bar (expanded state) */}
        {searchOpen && (
          <div className="flex-1 min-w-0">
            <input
              ref={inputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={language === 'ko' ? '장소 검색...' : 'Search places...'}
              className="w-full bg-bg-layer-fill text-fg-neutral placeholder:text-fg-neutral-subtle text-sm px-3 py-1.5
                rounded-lg border border-stroke-neutral-subtle focus:outline-none focus:border-stroke-brand-solid transition-colors"
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setSearchQuery('')
                  setSearchOpen(false)
                }
              }}
            />
          </div>
        )}

        {/* Right side controls */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* Search button */}
          <button
            onClick={handleSearchToggle}
            className={`w-8 h-8 rounded-full flex items-center justify-center text-sm transition-colors
              ${searchOpen ? 'bg-bg-brand-solid text-fg-neutral-inverted' : 'bg-bg-layer-fill hover:bg-bg-layer-default-pressed text-fg-neutral-muted'}
              border border-stroke-neutral-subtle`}
            title={language === 'ko' ? '검색' : 'Search'}
          >
            {searchOpen && searchQuery ? '✕' : '🔍'}
          </button>

          {/* Nationality filter (hide when search open on small screens) */}
          {!searchOpen && <NationalityDropdown />}

          {/* Language toggle */}
          <button
            onClick={toggleLanguage}
            className="px-2.5 py-1.5 rounded-full bg-bg-layer-fill hover:bg-bg-layer-default-pressed text-xs font-bold
              transition-colors text-fg-neutral-muted border border-stroke-neutral-subtle"
          >
            {language === 'ko' ? 'EN' : '한'}
          </button>
        </div>
      </div>
    </header>
  )
}
