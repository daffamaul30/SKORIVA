/**
 * `@skoriva/shared` — tipe domain dan konstanta default per cabang olahraga.
 *
 * T-02 menyediakan:
 * - tipe domain yang mencerminkan Tech Spec §2.3 (`matches`, `matchEvents`, `events`);
 * - konstanta default Basketball/Futsal/Badminton (BWF R-05)/Volleyball;
 * - kontrak tipe `SportEngine` (implementasi engine ada di `apps/api`, T-19…T-23).
 *
 * Kontrak Zod (REST + action) diimplementasikan pada T-03 di `src/contracts/`.
 */
export * from './constants/index.js';
export * from './contracts/index.js';
export * from './domain/index.js';
