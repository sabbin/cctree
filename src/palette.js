// One palette for every renderer, at whatever colour depth the terminal has.
//
// The tree used to declare its own escape codes as `C` and the picker declared
// four more inline, and they drifted: the same colour meant "prompt" in one view
// and "session id" in the other. Colour is the only channel this UI has for
// saying what a row IS, so it gets exactly one vocabulary — defined here, handed
// to the renderers as data, and never rebuilt by them.
//
// Renderers take a palette and call it. They do not know what an escape code is,
// which is what keeps them pure and what makes `vlen` the only measurement any
// of them needs.

/**
 * Which of the three tiers this terminal has. The one impure function in the
 * module, and it is called at the I/O boundary — never by a renderer.
 *
 * @returns {0|4|8|24} 0 = no colour at all, then bits of colour depth
 */
export function colorDepth(env = process.env, stream = process.stdout) {
  if (env.NO_COLOR) return 0; // no-color.org — an explicit user request
  if (env.FORCE_COLOR) return Number(env.FORCE_COLOR) > 1 ? 24 : 4;
  if (!stream?.isTTY) return 0; // piped to a file or another process
  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') return 24;
  if (/-256color|kitty|alacritty|wezterm|ghostty/.test(env.TERM || '')) return 8;
  return 4;
}

// Five hues and two greys, and that is the whole vocabulary — hue says which
// CATEGORY a thing is, lightness says how important it is. Nothing is ever
// distinguished by colour alone: HEAD also has `◆` and `← HEAD`, the latest
// session also has `▸`, so the 16-colour and no-colour tiers lose polish rather
// than meaning.
//
// The values are deliberately desaturated. A TUI sits on the user's own
// background for hours, and stock ANSI colours at full saturation are why
// terminal apps read as noisy; muted and close in lightness lets colour signal
// category without competing for attention.
const HUES = {
  //             truecolor        256    basic
  prompt: [[126, 196, 214], 110, '36'], // what the user wrote
  branch: [[214, 166, 90], 179, '33'], //  what distinguishes this arm
  head: [[126, 196, 140], 108, '32'], //   where you are now
  graft: [[176, 142, 214], 140, '35'], //  transplanted history
  machine: [[122, 118, 110], 244, '90'], // machinery, ids, timestamps
  faint: [[78, 74, 68], 238, '2'], //      lane art, empty states
};

const RESET = '\x1b[0m';

// The selection background, one step off the user's own rather than a colour of
// its own. `null` at the basic tier: 16-colour terminals have no background to
// set here, so selection degrades to bold (§1.9).
const SEL_BG = [[40, 38, 35], 236, null];

/** Visible width — escape codes occupy no columns. */
export const vlen = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '').length;

/** One escape sequence, anchored — used to walk a string escape by escape. */
const ESC_AT = /^\x1b\[[0-9;]*m/;

/**
 * Walk `s`, handing each escape and each visible character to the caller.
 *
 * The one primitive the split view needs and did not have. `slice` cannot do
 * this: it counts escape bytes as columns, and cutting inside a sequence emits
 * a fragment the terminal will happily interpret as garbage.
 */
function walk(s, onEscape, onChar) {
  const str = String(s);
  for (let i = 0; i < str.length; ) {
    if (str[i] === '\x1b') {
      const m = ESC_AT.exec(str.slice(i));
      if (m) {
        onEscape(m[0]);
        i += m[0].length;
        continue;
      }
    }
    onChar(str[i]);
    i += 1;
  }
}

/**
 * Truncate to `n` VISIBLE columns, keeping the escapes intact. Pure.
 *
 * Escapes past the cut are still emitted, which looks wrong and is the whole
 * point: the closing `\x1b[0m` of a span that started before the cut lives after
 * it, and dropping it bleeds that colour across the divider and through the
 * right-hand pane. That is the failure you would actually see.
 *
 * No ellipsis — the pane border already says the row was cut, and an `…` on
 * every row is noise against the tree's lane art.
 */
export function vtrunc(s, n) {
  let out = '';
  let visible = 0;
  let open = false;
  walk(
    s,
    (esc) => {
      out += esc;
      open = esc !== RESET;
    },
    (ch) => {
      if (visible < n) {
        out += ch;
        visible += 1;
      }
    },
  );
  // Belt and braces for a string that never closed its own span.
  return open ? out + RESET : out;
}

/** Drop the first `n` visible columns, keeping every escape. Pure. */
function vdrop(s, n) {
  let out = '';
  let seen = 0;
  walk(
    s,
    (esc) => {
      out += esc;
    },
    (ch) => {
      if (seen >= n) out += ch;
      seen += 1;
    },
  );
  return out;
}

/**
 * Word-wrap to `width` visible columns. Pure. Returns lines, never a string.
 *
 * Measured with `vlen` so a coloured value wraps where it looks like it should,
 * and a word too long for the column is cut with `vtrunc` rather than allowed
 * to overhang — in a pane, an overhang is a row that runs into the tree.
 */
export function wrap(text, width) {
  if (width <= 0) return [];
  const words = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  const lines = [];
  let line = '';
  const flush = () => {
    if (line) lines.push(line);
    line = '';
  };
  for (let word of words) {
    while (vlen(word) > width) {
      flush();
      lines.push(vtrunc(word, width));
      word = vdrop(word, width);
    }
    if (!line) line = word;
    else if (vlen(line) + 1 + vlen(word) <= width) line += ` ${word}`;
    else {
      flush();
      line = word;
    }
  }
  flush();
  return lines;
}

/**
 * Re-open `code` after every reset inside `s`.
 *
 * A row is built from coloured spans, and each one closes with `\x1b[0m`, which
 * clears the BACKGROUND as well as the foreground. Wrapping such a row in a
 * selection background therefore paints only as far as the first inner span —
 * which is exactly why a highlight looks patchy. Reasserting after each reset is
 * what makes the fill continuous without flattening the colours underneath it.
 */
const reassert = (s, code) => String(s).split(RESET).join(RESET + code);

/**
 * A palette: one function per semantic name, plus `select` for the row fill.
 *
 * Pure and depth-only — no env, no stream, no clock — so a test can ask for any
 * tier and a renderer can be handed one without reaching for the terminal.
 *
 * @param {0|4|8|24} depth
 */
export function makePalette(depth = 0) {
  const p = { depth };

  if (!depth) {
    // Identity. Every renderer's `color: false` path, and the one that must stay
    // byte-identical to the output a pipe has always seen.
    for (const name of Object.keys(HUES)) p[name] = (s) => String(s);
    p.select = (s) => String(s);
    return p;
  }

  const open = ([rgb, idx, basic], bg) => {
    if (depth === 24) return `\x1b[${bg ? 48 : 38};2;${rgb.join(';')}m`;
    if (depth === 8) return `\x1b[${bg ? 48 : 38};5;${idx}m`;
    return basic ? `\x1b[${basic}m` : null;
  };

  for (const [name, hue] of Object.entries(HUES)) {
    const code = open(hue, false);
    p[name] = (s) => `${code}${reassert(s, code)}${RESET}`;
  }

  const bg = open(SEL_BG, true);
  p.select = (s, width = 0) => {
    // No background at 16 colours, so the selected row goes bold instead. It is
    // the one place a tier genuinely loses a signal, which is why `▸` carries
    // the same information positionally at every tier.
    const code = bg ?? '\x1b[1m';
    const pad = bg ? ' '.repeat(Math.max(0, width - vlen(s))) : '';
    return `${code}${reassert(s, code)}${pad}${RESET}`;
  };
  return p;
}

/** The palette a renderer gets when its caller supplies none. */
export const PLAIN = makePalette(0);
