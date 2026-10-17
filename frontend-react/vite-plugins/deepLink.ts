import type { Plugin } from 'vite';

function deepLinkScript(base: string): string {
  return (
    `(function(){var p=new URLSearchParams(location.search).get('__p');` +
    `if(p!==null)history.replaceState(history.state,'',${JSON.stringify(base)}+p.replace(RegExp('^/+'),''));})();`
  );
}

export function deepLink(base: string): Plugin {
  return {
    name: 'agrotrace-deep-link',
    transformIndexHtml: () =>
      base === '/' ? [] : [{ tag: 'script', children: deepLinkScript(base), injectTo: 'head' }],
  };
}
