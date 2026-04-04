import type { Config } from 'tailwindcss'
import seedPlugin from '@seed-design/tailwind3-plugin'

export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Noto Sans KR', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [seedPlugin],
} satisfies Config
