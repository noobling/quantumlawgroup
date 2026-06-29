/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          50: '#f6f7f9', 100: '#eceef2', 200: '#d5dae2', 300: '#b0bac8',
          400: '#8593a8', 500: '#647189', 600: '#4f5a70', 700: '#414a5c',
          800: '#39404e', 900: '#0b0f1a'
        },
        accent: { DEFAULT: '#b08d57', 600: '#9a7a47' }
      },
      fontFamily: {
        serif: ['Georgia', 'Cambria', 'Times New Roman', 'serif'],
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif']
      }
    }
  },
  plugins: []
}
