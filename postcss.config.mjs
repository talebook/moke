/** @type {import('postcss-load-config').Config} */
const config = {
  plugins: {
    tailwindcss: {},
    '@csstools/postcss-cascade-layers': {},
    autoprefixer: {},
  },
};

export default config;
