/**
 * Design detector — the subset of the apple-design guidance that can be
 * checked against the live DOM without asking anyone's opinion.
 *
 * The split matters. "Tighten tracking on display type" has a measurable
 * threshold, so it belongs in a loop with a gate that can fail. "Does this
 * hierarchy feel right" does not, and is deliberately absent: a check that
 * cannot fail is not a check, and a loop built on one only looks like a loop.
 *
 * Each finding names the principle it came from, so a patch can be argued
 * with rather than merely accepted.
 */
export const DESIGN_PROBE = `(() => {
  const out = {
    tracking: [], leading: [], nonCompositor: [],
    stackedTranslucency: [], reducedMotion: null, pressFeedback: null,
  };

  const describe = (el) =>
    el.tagName.toLowerCase() +
    (el.id ? '#' + el.id : '') +
    (el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.')
      : '');

  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  // --- typography: tracking and leading on display type -------------------
  // Letters read too far apart as they grow, so large text wants negative
  // tracking and tight leading. A single letter-spacing value across all
  // sizes is wrong somewhere by definition.
  for (const el of document.querySelectorAll('h1,h2,h3,[class*=display],[class*=hero],[class*=title]')) {
    if (!visible(el)) continue;
    const own = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('');
    if (!own) continue;

    const cs = getComputedStyle(el);
    const size = parseFloat(cs.fontSize);
    if (size < 32) continue;

    const tracking = cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing);
    if (tracking >= 0) {
      out.tracking.push({
        selector: describe(el), fontSize: size,
        letterSpacing: cs.letterSpacing,
        suggested: (Math.round(size * -0.02 * 100) / 100) + 'px',
        text: own.slice(0, 40),
      });
    }

    const lh = cs.lineHeight === 'normal' ? size * 1.2 : parseFloat(cs.lineHeight);
    const ratio = lh / size;
    if (ratio > 1.3) {
      out.leading.push({
        selector: describe(el), fontSize: size,
        lineHeight: Math.round(ratio * 100) / 100,
        suggested: 1.1,
        text: own.slice(0, 40),
      });
    }
  }

  // --- motion: compositor-friendly properties only ------------------------
  // Animating layout properties forces layout on every frame. transform and
  // opacity are the two the compositor can handle alone.
  const LAYOUT_PROPS = ['left', 'top', 'right', 'bottom', 'width', 'height', 'margin', 'padding'];
  for (const el of document.querySelectorAll('*')) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.transitionProperty === 'none' || !cs.transitionProperty) continue;
    const props = cs.transitionProperty.split(',').map((p) => p.trim());
    const offenders = props.filter((p) => LAYOUT_PROPS.some((l) => p === l || p.startsWith(l + '-')));
    if (offenders.length) {
      out.nonCompositor.push({
        selector: describe(el),
        properties: offenders,
        duration: cs.transitionDuration,
      });
    }
  }
  out.nonCompositor = out.nonCompositor.slice(0, 10);

  // --- materials: never stack translucency on translucency ----------------
  // A light translucent surface over another one destroys legibility; the
  // blur compounds and neither layer reads as a distinct plane.
  const blurred = Array.from(document.querySelectorAll('*')).filter((el) => {
    if (!visible(el)) return false;
    const cs = getComputedStyle(el);
    const bf = cs.backdropFilter || cs.webkitBackdropFilter;
    return bf && bf !== 'none';
  });
  for (const el of blurred) {
    const ancestor = blurred.find((o) => o !== el && o.contains(el));
    if (ancestor) {
      out.stackedTranslucency.push({
        inner: describe(el),
        outer: describe(ancestor),
      });
    }
  }

  // --- accessibility: reduced motion --------------------------------------
  // Reduced motion does not mean no feedback — it means a non-vestibular
  // equivalent. Having animation and no such rule is the defect.
  let hasMotion = false;
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if ((cs.transitionDuration && cs.transitionDuration !== '0s') ||
        (cs.animationName && cs.animationName !== 'none')) { hasMotion = true; break; }
  }

  let reducedMotionRule = false;
  let activeRule = false;
  for (const sheet of document.styleSheets) {
    let rules;
    // Cross-origin stylesheets throw on access. Unreadable is not the same
    // as absent, so this is tracked rather than counted as a failure.
    try { rules = sheet.cssRules; } catch { out.unreadableSheets = true; continue; }
    if (!rules) continue;
    const walk = (list) => {
      for (const rule of list) {
        if (rule.media && /prefers-reduced-motion/.test(rule.conditionText || rule.media.mediaText || '')) {
          reducedMotionRule = true;
        }
        if (rule.selectorText && /:active/.test(rule.selectorText)) activeRule = true;
        if (rule.cssRules) walk(rule.cssRules);
      }
    };
    walk(rules);
  }

  if (hasMotion && !reducedMotionRule && !out.unreadableSheets) {
    out.reducedMotion = { hasMotion: true, hasRule: false };
  }

  // --- response: feedback on press, not on release ------------------------
  const controls = document.querySelectorAll('button,a,[role=button]');
  if (controls.length > 0 && !activeRule && !out.unreadableSheets) {
    out.pressFeedback = { controls: controls.length, hasActiveRule: false };
  }

  return out;
})()`;
