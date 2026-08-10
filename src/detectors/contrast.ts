/**
 * Contrast detector.
 *
 * This runs inside the page. It is deliberately conservative: it would rather
 * return "unmeasurable" than produce a number it cannot stand behind, because
 * a confident wrong contrast figure costs more than a gap in coverage.
 *
 * Three traps this specifically avoids, each of which produces invented
 * failures in the naive implementation:
 *
 *   1. Reading `background-color` on the text element alone. It is usually
 *      `rgba(0,0,0,0)`, so the naive version walks up to some light ancestor
 *      and reports a nonsense ratio against a background nobody can see.
 *   2. Gradients. `background-image` with a gradient has no single colour, so
 *      compositing to the nearest solid ancestor silently measures against
 *      the wrong thing.
 *   3. Translucent surfaces stacked over a gradient painted on a div rather
 *      than on body. The composite is genuinely not derivable from computed
 *      styles, which is the common case in dark themes.
 *
 * In cases 2 and 3 the honest answer is that computed styles cannot settle it
 * and a human or a screenshot has to. We say so rather than guessing.
 */
import type { PolicyRules } from '../policy.js';

export const contrastProbe = (p: PolicyRules) => `(() => {
  const parseRGBA = (s) => {
    const m = String(s).match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x.trim()));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };

  const luminance = ({ r, g, b }) => {
    const f = (c) => {
      c = c / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };

  const ratio = (fg, bg) => {
    const a = luminance(fg), b = luminance(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };

  const over = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  });

  /**
   * Composite backgrounds from the element upward. Returns either a settled
   * colour or the reason it cannot be settled.
   */
  const resolveBackdrop = (el) => {
    const stack = [];
    let node = el;
    while (node && node !== document.documentElement.parentNode) {
      const cs = getComputedStyle(node);
      const img = cs.backgroundImage;
      if (img && img !== 'none') {
        if (/gradient/i.test(img)) {
          return { unmeasurable: 'gradient background on ' + node.tagName.toLowerCase() };
        }
        return { unmeasurable: 'image background on ' + node.tagName.toLowerCase() };
      }
      const c = parseRGBA(cs.backgroundColor);
      if (c && c.a > 0) {
        stack.push(c);
        if (c.a === 1) {
          // Fully opaque — everything below is irrelevant. Composite down.
          let acc = stack.pop();
          while (stack.length) acc = over(stack.pop(), acc);
          return { colour: acc };
        }
      }
      node = node.parentElement;
    }
    return { unmeasurable: 'no opaque ancestor found' };
  };

  const TEXT = 'p,span,a,h1,h2,h3,h4,h5,h6,li,td,th,label,button,small,strong,em,div';
  const out = [];
  const seen = new Set();
  let passes = 0;

  for (const el of document.querySelectorAll(TEXT)) {
    // Only elements that actually render their own text.
    const own = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .join('');
    if (!own) continue;

    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.opacity === '0' || cs.display === 'none') continue;

    const fg = parseRGBA(cs.color);
    if (!fg) continue;

    const size = parseFloat(cs.fontSize);
    const weight = parseInt(cs.fontWeight, 10) || 400;
    // WCAG large text: >=24px, or >=18.66px when bold.
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const threshold = large ? ${p.contrastLarge} : ${p.contrastNormal};
    // A profile that does not examine contrast must not be read as approving
    // it, so zero means "not assessed" rather than "everything passes".
    if (threshold <= 0) continue;

    const backdrop = resolveBackdrop(el);
    const selector = el.tagName.toLowerCase() +
      (el.id ? '#' + el.id : '') +
      (el.className && typeof el.className === 'string'
        ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.')
        : '');

    if (backdrop.unmeasurable) {
      const key = 'U:' + selector;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        selector,
        text: own.slice(0, 60),
        unmeasurable: backdrop.unmeasurable,
      });
      continue;
    }

    const composited = fg.a < 1 ? over(fg, backdrop.colour) : fg;
    const r = ratio(composited, backdrop.colour);
    const pass = r >= threshold;

    // Passing samples are reported too, capped, so the graph carries the
    // shape of the UI rather than only its defects. Without them a node
    // disappears the moment it is healed, and you cannot watch anything
    // improve — which is the only reason to draw a graph at all.
    if (pass && passes >= 40) continue;
    if (pass) passes++;

    const key = 'C:' + selector + ':' + r.toFixed(2);
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      selector,
      pass,
      text: own.slice(0, 60),
      ratio: Math.round(r * 100) / 100,
      threshold,
      fontSize: size,
      fontWeight: weight,
      colour: cs.color,
      backdrop: 'rgb(' + [backdrop.colour.r, backdrop.colour.g, backdrop.colour.b]
        .map(Math.round).join(',') + ')',
    });
  }
  return out;
})()`;
