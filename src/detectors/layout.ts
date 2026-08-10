/**
 * Layout detector — clipped text, horizontal page overflow, overlapping
 * interactive elements, and tap targets below the 24px minimum.
 *
 * Overlap is checked only between *interactive* elements, because normal
 * layouts are full of harmlessly overlapping decorative boxes and reporting
 * those buries the real hits.
 */
export const LAYOUT_PROBE = `(() => {
  const out = { clipped: [], overflow: null, overlaps: [], smallTargets: [] };

  const describe = (el) =>
    el.tagName.toLowerCase() +
    (el.id ? '#' + el.id : '') +
    (el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.')
      : '');

  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  // --- clipped text -------------------------------------------------------
  for (const el of document.querySelectorAll('*')) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    const hidden = cs.overflow === 'hidden' || cs.overflowX === 'hidden' || cs.overflowY === 'hidden';
    if (!hidden) continue;
    // An explicit ellipsis or line-clamp is a deliberate design choice.
    if (cs.textOverflow === 'ellipsis' || cs.webkitLineClamp !== 'none') continue;
    const overX = el.scrollWidth - el.clientWidth;
    const overY = el.scrollHeight - el.clientHeight;
    if (overX > 1 || overY > 1) {
      out.clipped.push({
        selector: describe(el),
        overflowX: overX,
        overflowY: overY,
        text: (el.textContent || '').trim().slice(0, 60),
      });
    }
  }

  // --- page-level horizontal overflow -------------------------------------
  const docW = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > docW + 1) {
    const culprits = [];
    for (const el of document.querySelectorAll('*')) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.right > docW + 1) culprits.push({ selector: describe(el), right: Math.round(r.right) });
    }
    out.overflow = {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: docW,
      // Deepest offenders are the actual cause; ancestors just inherit it.
      culprits: culprits.slice(-5),
    };
  }

  // --- overlapping interactive elements -----------------------------------
  const INTERACTIVE = 'a,button,input,select,textarea,[role=button],[role=link],[tabindex]';
  const items = Array.from(document.querySelectorAll(INTERACTIVE))
    .filter(visible)
    .map((el) => ({ el, r: el.getBoundingClientRect() }));

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      // Nested controls legitimately contain one another.
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const ox = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const oy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);

      // Visual containment is a deliberate overlay, not a collision. A
      // password-reveal button sits inside its field without being a DOM
      // descendant of it — inputs cannot have children — so checking DOM
      // nesting alone reports every one of them as a blocker.
      const contained =
        (a.r.left >= b.r.left && a.r.right <= b.r.right &&
         a.r.top >= b.r.top && a.r.bottom <= b.r.bottom) ||
        (b.r.left >= a.r.left && b.r.right <= a.r.right &&
         b.r.top >= a.r.top && b.r.bottom <= a.r.bottom);

      if (ox > 1 && oy > 1 && !contained) {
        out.overlaps.push({
          a: describe(a.el),
          b: describe(b.el),
          area: Math.round(ox * oy),
        });
      }
    }
  }
  out.overlaps = out.overlaps.sort((x, y) => y.area - x.area).slice(0, 10);

  // --- tap targets --------------------------------------------------------
  for (const { el, r } of items) {
    if (r.width < 24 || r.height < 24) {
      out.smallTargets.push({
        selector: describe(el),
        width: Math.round(r.width),
        height: Math.round(r.height),
        label: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 40),
      });
    }
  }

  return out;
})()`;
