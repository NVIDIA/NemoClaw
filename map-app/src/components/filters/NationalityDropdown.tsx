import { useState } from 'react'
import { useFilterStore } from '@/store'
import { useUiStore } from '@/store'
import { NATIONALITY_META } from '@/types'
import type { Nationality } from '@/types'

const NATIONALITIES: Nationality[] = [
  'all', 'korean', 'japanese', 'chinese', 'western', 'indian', 'halal', 'vegan',
]

export function NationalityDropdown() {
  const [open, setOpen] = useState(false)
  const { nationality, setNationality } = useFilterStore()
  const { language } = useUiStore()
  const current = NATIONALITY_META[nationality]

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-bg-layer-default border border-stroke-neutral-subtle hover:border-stroke-neutral-muted
          text-sm font-medium text-fg-neutral-muted transition-all shadow-sm whitespace-nowrap"
      >
        <span>{current.flag}</span>
        <span>{language === 'ko' ? current.label : current.labelEn}</span>
        <svg
          className={`w-4 h-4 text-fg-neutral-subtle transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-1.5 w-48 bg-bg-layer-floating rounded-xl shadow-xl border border-stroke-neutral-subtle z-50 overflow-hidden">
          <div className="py-1">
            {NATIONALITIES.map((nat) => {
              const meta = NATIONALITY_META[nat]
              const isSelected = nationality === nat
              return (
                <button
                  key={nat}
                  onClick={() => { setNationality(nat); setOpen(false) }}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-bg-layer-fill transition-colors
                    ${isSelected ? 'bg-bg-brand-weak text-fg-brand font-semibold' : 'text-fg-neutral-muted'}`}
                >
                  <span className="text-lg">{meta.flag}</span>
                  <div className="flex flex-col items-start">
                    <span className="font-medium">{language === 'ko' ? meta.label : meta.labelEn}</span>
                    {language === 'ko' && (
                      <span className="text-xs text-fg-neutral-subtle">{meta.labelEn}</span>
                    )}
                  </div>
                  {isSelected && (
                    <svg className="ml-auto w-4 h-4 text-fg-brand" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {open && (
        <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
      )}
    </div>
  )
}
