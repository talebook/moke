import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        background: '#FBF9F2',
        foreground: '#2C2C2E',
        card: '#F5F1EB',
        'card-foreground': '#2C2C2E',
        primary: {
          DEFAULT: '#B8956A',
          foreground: '#FFFFFF',
        },
        muted: {
          DEFAULT: '#EDE9DF',
          foreground: '#8B8682',
        },
        accent: {
          DEFAULT: '#F0ECE3',
          foreground: '#2C2C2E',
        },
        destructive: {
          DEFAULT: '#C0392B',
          foreground: '#FFFFFF',
        },
        success: {
          DEFAULT: '#7A8B5E',
          foreground: '#FFFFFF',
        },
        border: '#E8E3DC',
        input: '#F0ECE3',
        ring: '#B8956A',
      },
      fontFamily: {
        sans: [
          "'Inter'",
          "'PingFang SC'",
          "'Noto Sans SC'",
          'system-ui',
          '-apple-system',
          'sans-serif',
        ],
        serif: [
          "'Georgia'",
          "'Noto Serif SC'",
          "'Songti SC'",
          'serif',
        ],
      },
      fontSize: {
        xs: ['11px', { lineHeight: '1.5' }],
        sm: ['13px', { lineHeight: '1.5' }],
        base: ['15px', { lineHeight: '1.55' }],
        lg: ['18px', { lineHeight: '1.5' }],
        xl: ['20px', { lineHeight: '1.4' }],
        '2xl': ['24px', { lineHeight: '1.3' }],
      },
      borderRadius: {
        sm: '4px',
        md: '10px',
        lg: '14px',
        xl: '18px',
        '2xl': '24px',
      },
      boxShadow: {
        card: '0 1px 3px rgba(0,0,0,0.04)',
        dropdown: '0 4px 12px rgba(0,0,0,0.08)',
        welcome: '0 2px 12px rgba(0,0,0,0.05)',
      },
      width: {
        sidebar: '220px',
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
};

export default config;
