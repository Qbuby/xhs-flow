/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          50: '#faf8f6',
          100: '#f2ede8',
          200: '#e4dbd2',
          300: '#cfc0b4',
          400: '#a89689',
          500: '#8a7869',
          600: '#6f6054',
          700: '#584c43',
          800: '#3b332d',
          900: '#241f1b',
        },
        accent: {
          400: '#f4796a',
          500: '#e8604c',
          600: '#c94836',
        },
      },
      fontFamily: {
        sans: [
          '"Microsoft YaHei"',
          '"PingFang SC"',
          '"Noto Sans SC"',
          'system-ui',
          'sans-serif',
        ],
      },
    },
  },
  plugins: [],
};