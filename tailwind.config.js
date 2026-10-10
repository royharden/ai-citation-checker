/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      colors: {
        verdict: {
          supported: { bg: '#dcfce7', text: '#14532d', border: '#86efac', solid: '#16a34a' },
          partial: { bg: '#ecfccb', text: '#365314', border: '#bef264', solid: '#84cc16' },
          unsupported: { bg: '#fef3c7', text: '#78350f', border: '#fcd34d', solid: '#d97706' },
          contradicted: { bg: '#fee2e2', text: '#7f1d1d', border: '#fca5a5', solid: '#dc2626' },
          misquoted: { bg: '#f3e8ff', text: '#4c1d95', border: '#d8b4fe', solid: '#9333ea' },
          uncertain: { bg: '#fef3c7', text: '#78350f', border: '#fcd34d', solid: '#d97706' },
        },
      },
    },
  },
  plugins: [],
};
