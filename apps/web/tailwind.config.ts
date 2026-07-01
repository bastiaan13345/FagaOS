import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Subdued palette; matches the FagaOS "operator console" tone.
        canvas: {
          DEFAULT: '#0b0d12',
          subtle: '#11141b',
          surface: '#161a23',
          raised: '#1c2230',
          border: '#262d3d',
        },
        ink: {
          DEFAULT: '#e7ecf3',
          subtle: '#a4adbe',
          muted: '#6b7385',
        },
        accent: {
          DEFAULT: '#7aa2f7',
          warn: '#e0af68',
          danger: '#f7768e',
          ok: '#9ece6a',
        },
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      screens: {
        // 480px / 768px / 1024px give us small / medium / large breakpoints
        // on top of Tailwind's default `sm` (640), `md` (768), `lg` (1024).
        'xs': '480px',
      },
    },
  },
  plugins: [],
};

export default config;
