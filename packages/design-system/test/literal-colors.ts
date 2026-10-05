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

const NON_COLOR_PROPS =
  /^(content|grid-template-areas|grid-area|font|font-family|animation|animation-name|counter-reset|counter-increment|list-style|transition|transition-property|will-change|appearance|cursor|display|position|overflow.*|text-align|text-overflow|text-transform|text-wrap|text-indent|text-rendering|text-size-adjust|-webkit-text-size-adjust|text-underline-offset|text-decoration-thickness|text-decoration-line|white-space|user-select|pointer-events|scrollbar-width|resize|object-fit)$/i;

export function literalColors(css: string): string[] {
  let s = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(["'])(?:\\.|(?!\1).)*\1/g, '""');
  for (let prev = ''; prev !== s;) {
    prev = s;
    s = s.replace(/var\([^()]*\)/g, '');
  }
  const found = [
    ...(s.match(/#[0-9a-f]{3,8}\b/gi) ?? []),
    ...(s.match(/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(/gi) ?? []),
  ];
  for (const m of s.matchAll(/(?:^|[{;])\s*([-a-z]+)\s*:([^;{}]*)/gi)) {
    const [, prop = '', value = ''] = m;
    if (prop.startsWith('--') || NON_COLOR_PROPS.test(prop)) continue;
    for (const word of value.toLowerCase().match(/[a-z][a-z-]*/g) ?? []) {
      if (NAMED.has(word)) found.push(word);
    }
  }
  return found;
}
