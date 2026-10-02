// Bundled assets are imported as URLs (Vite natively; Angular's esbuild with `loader: { ".webp": "file", … }`).
declare module '*.webp' {
  const url: string;
  export default url;
}
declare module '*.svg' {
  const url: string;
  export default url;
}
declare module '*.ttf' {
  const url: string;
  export default url;
}
