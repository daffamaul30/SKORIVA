/**
 * Badminton rules baseline and verification status (T-22, R-05).
 *
 * The official BWF PDF is not part of this repository. Rules explicitly stated
 * in PRD v2.4 / Tech Spec v3.5 are implemented. Article-level details that
 * require the official PDF are marked pending and must not be described as
 * fully BWF-compliant until verified.
 */

export const BADMINTON_RULES_BASELINE = {
  document: 'BWF Laws of Badminton',
  version: '26 April 2025, Version 5.0',
  source: 'https://corporate.bwfbadminton.com/statutes/',
  verifiedAt: '2026-11-13',
  implementationStatus: 'PENDING_ARTICLE_VERIFICATION',
  implementedFrom: ['PRD v2.4 FR-09', 'Tech Spec v3.5 §4.7', 'B-02', 'R-05'],
  pendingVerification: [
    'Exact service rotation and receiver positioning article text',
    'Exact interval procedure and duration wording',
    'Exact change-ends procedure wording',
  ],
} as const;

export type BadmintonRulesBaseline = typeof BADMINTON_RULES_BASELINE;
