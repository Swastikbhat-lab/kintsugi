/**
 * Which standard is being enforced.
 *
 * Thresholds are not facts, they are choices, and different sources choose
 * differently. A 24x24 touch target is the WCAG 2.2 Level AA minimum; 44x44 is
 * the Level AAA enhanced criterion and what most mobile guidance recommends.
 * Both are correct — for different commitments.
 *
 * Without something like this, whichever number happened to be typed into a
 * detector becomes the de-facto company standard, and a second source of
 * guidance silently disagrees with the first. So the profile is chosen once,
 * explicitly, and every finding records the profile and the rule that produced
 * it. A measurement nobody can trace back to a standard is an opinion with a
 * number attached.
 */

export interface PolicyRules {
  /** Minimum contrast for normal-size text. */
  contrastNormal: number;
  /** Minimum contrast for large text (>=24px, or >=18.66px bold). */
  contrastLarge: number;
  /** Minimum width and height of an interactive target, in CSS pixels. */
  tapTarget: number;
  /** At or above this size, type is treated as display type. */
  displayTypePx: number;
  /** Display type looser than this ratio is flagged. */
  displayLeadingMax: number;
  /** Display type is expected to carry negative tracking. */
  requireNegativeTracking: boolean;
  /** Animating these properties forces layout on every frame. */
  layoutProperties: string[];
  /** Require a prefers-reduced-motion rule when the page animates. */
  requireReducedMotion: boolean;
}

export interface Policy {
  id: string;
  label: string;
  /** Where each threshold comes from, so a finding can cite it. */
  citation: string;
  rules: PolicyRules;
}

const LAYOUT_PROPS = ['left', 'top', 'right', 'bottom', 'width', 'height', 'margin', 'padding'];

const AA: PolicyRules = {
  contrastNormal: 4.5,
  contrastLarge: 3.0,
  tapTarget: 24,
  displayTypePx: 32,
  displayLeadingMax: 1.3,
  requireNegativeTracking: true,
  layoutProperties: LAYOUT_PROPS,
  requireReducedMotion: true,
};

export const POLICIES: Record<string, Policy> = {
  'wcag-22-aa': {
    id: 'wcag-22-aa',
    label: 'WCAG 2.2 Level AA',
    citation: 'WCAG 2.2 AA — 1.4.3 Contrast (Minimum), 2.5.8 Target Size (Minimum)',
    rules: AA,
  },

  'wcag-22-aaa': {
    id: 'wcag-22-aaa',
    label: 'WCAG 2.2 Level AAA',
    citation: 'WCAG 2.2 AAA — 1.4.6 Contrast (Enhanced), 2.5.5 Target Size (Enhanced)',
    rules: { ...AA, contrastNormal: 7.0, contrastLarge: 4.5, tapTarget: 44 },
  },

  /**
   * Touch-first targets without the rest of AAA. This is where external design
   * guidance recommending 44x44 belongs: as a profile someone selects, not as
   * a number that quietly replaces the compliance floor.
   */
  'mobile-touch': {
    id: 'mobile-touch',
    label: 'Mobile touch targets, AA contrast',
    citation: 'WCAG 2.2 AA contrast with 2.5.5 Target Size (Enhanced) at 44px',
    rules: { ...AA, tapTarget: 44 },
  },

  'botstacks-product': {
    id: 'botstacks-product',
    label: 'BotStacks product baseline',
    citation: 'WCAG 2.2 AA, with the product\'s own display-type conventions',
    rules: { ...AA, displayTypePx: 32, displayLeadingMax: 1.3 },
  },

  /**
   * Motion and layout stability only. Useful when the question is whether the
   * interface is cheap to render, not whether it is compliant.
   */
  'performance-strict': {
    id: 'performance-strict',
    label: 'Motion and layout stability',
    citation: 'Compositor-only animation; reduced-motion honoured',
    rules: {
      ...AA,
      // Contrast is unreachable rather than passing: a profile that does not
      // examine something must not be read as having approved it.
      contrastNormal: 0,
      contrastLarge: 0,
      tapTarget: 0,
      requireNegativeTracking: false,
      requireReducedMotion: true,
    },
  },
};

export const DEFAULT_POLICY = 'wcag-22-aa';

export function resolvePolicy(id?: string): Policy {
  if (!id) return POLICIES[DEFAULT_POLICY];
  const found = POLICIES[id];
  if (!found) {
    throw new Error(
      `Unknown policy "${id}". Available: ${Object.keys(POLICIES).join(', ')}`,
    );
  }
  return found;
}

/** Attached to every finding so a number can always be traced to a standard. */
export function provenance(policy: Policy, rule: keyof PolicyRules) {
  return {
    policy: policy.id,
    rule,
    threshold: policy.rules[rule],
    citation: policy.citation,
  };
}
