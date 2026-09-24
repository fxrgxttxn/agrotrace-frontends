// Components and base styles take every color from tokens.css: no hex, functional (rgb, hsl, hwb,
// lab, lch, oklab, oklch, color, color-mix) or named colors outside var(…) expressions.
// `transparent`, `currentColor` and `inherit` are keywords, not colors, and stay allowed.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const files = [
  'base.css',
  ...readdirSync(join(root, 'components'))
    .filter((f) => f.endsWith('.css'))
    .map((f) => `components/${f}`),
];

// CSS Color 4 named colors (extended keywords).
const NAMED = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown ' +
    'burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan ' +
    'darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid ' +
    'darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet ' +
    'deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ' +
    'ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki ' +
    'lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow ' +
    'lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray ' +
    'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine ' +
    'mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen ' +
    'mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace ' +
    'olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred ' +
    'papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue ' +
    'saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey ' +
    'snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow ' +
    'yellowgreen canvas canvastext linktext visitedtext activetext buttonface buttontext buttonborder ' +
    'field fieldtext highlight highlighttext selecteditem selecteditemtext mark marktext graytext ' +
    'accentcolor accentcolortext'
  ).split(' '),
);

// Declarations whose values can never hold a color (names, counters, content, areas, fonts…).
const NON_COLOR_PROPS =
  /^(content|grid-template-areas|grid-area|font|font-family|animation|animation-name|counter-reset|counter-increment|list-style|transition|transition-property|will-change|appearance|cursor|display|position|overflow.*|text-.*|white-space|user-select|pointer-events|scrollbar-width|resize|object-fit)$/i;

export function literalColors(css: string): string[] {
  let s = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(["'])(?:\\.|(?!\1).)*\1/g, '""');
  // Drop var(...) expressions, innermost first, until none are left.
  for (let prev = ''; prev !== s;) {
    prev = s;
    s = s.replace(/var\([^()]*\)/g, '');
  }
  const found = [
    ...(s.match(/#[0-9a-f]{3,8}\b/gi) ?? []),
    ...(s.match(/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(/gi) ?? []),
  ];
  // Named colors: only inside declaration values (selectors like `.at-field` must not trip it).
  for (const m of s.matchAll(/(?:^|[{;])\s*([-a-z]+)\s*:([^;{}]*)/gi)) {
    const [, prop = '', value = ''] = m;
    if (prop.startsWith('--') || NON_COLOR_PROPS.test(prop)) continue;
    for (const word of value.toLowerCase().match(/[a-z][a-z-]*/g) ?? []) {
      if (NAMED.has(word)) found.push(word);
    }
  }
  return found;
}

describe('no literal colors outside tokens.css', () => {
  it('detects literals and ignores var() fallbacks', () => {
    expect(
      literalColors('a { color: #fff; background: rgb(0 0 0 / .5); border-color: hsl(0 0% 0%) }'),
    ).toEqual(['#fff', 'rgb(', 'hsl(']);
    expect(literalColors('a { color: var(--c-ink, #33291f); /* #abc */ }')).toEqual([]);
  });

  it('detects modern color functions and named colors', () => {
    expect(
      literalColors(
        'a { color: oklch(60% .1 120); fill: lab(50 0 0); stroke: hwb(0 0% 0%); background: color-mix(in srgb, var(--c-ink), white) }',
      ),
    ).toEqual(['oklch(', 'lab(', 'hwb(', 'color-mix(', 'white']);
    expect(literalColors('.x { border: 1px solid red; outline-color: Tomato }')).toEqual(['red', 'tomato']);
  });

  it('keeps keywords, selectors, custom property names and non-color values', () => {
    expect(
      literalColors(
        ".at-field .red, .tan { color: currentColor; background: transparent; content: 'white'; " +
          'grid-template-areas: "label value"; --green: 1px; font-family: var(--font-body) }',
      ),
    ).toEqual([]);
  });

  it('covers every component file', () => {
    expect(files.length).toBeGreaterThanOrEqual(30);
  });

  for (const f of files) {
    it(f, () => {
      expect(literalColors(readFileSync(join(root, f), 'utf8'))).toEqual([]);
    });
  }
});
