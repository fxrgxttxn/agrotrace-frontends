// The build loads `.svg` files as text (angular.json `loader`; vite.config.ts does the same for the tests): the sprite
// and the illustration sources are inlined into the document, never requested as images.
declare module '*.svg' {
  const markup: string;
  export default markup;
}
