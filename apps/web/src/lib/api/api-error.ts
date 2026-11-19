/**
 * Normalised API errors (T-31.2).
 *
 * The backend always answers errors as `{ code, message }` (see
 * `apps/api/src/middleware/error.ts`). `message` is an English developer string;
 * the UI must show Bahasa Indonesia, so `ApiClientError` keeps the original
 * `code` for feature-specific handling and exposes a safe Indonesian `message`.
 *
 * Security: nothing here ever receives credentials, cookies, or view codes. The
 * inputs are validated backend fields plus HTTP status only.
 */

/** Machine code emitted by the backend, plus the two client-only failures. */
export const CLIENT_ERROR_CODES = {
  network: 'NETWORK_ERROR',
  aborted: 'REQUEST_ABORTED',
  invalidJson: 'INVALID_RESPONSE_BODY',
  invalidErrorBody: 'INVALID_ERROR_BODY',
} as const;

export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[keyof typeof CLIENT_ERROR_CODES];

/** Bahasa Indonesia copy for the codes the frontend can act on. */
const SAFE_MESSAGES: Readonly<Record<string, string>> = {
  // Client-side failures
  [CLIENT_ERROR_CODES.network]:
    'Tidak dapat menghubungi server. Periksa koneksi lalu coba lagi.',
  [CLIENT_ERROR_CODES.aborted]: 'Permintaan dibatalkan.',
  [CLIENT_ERROR_CODES.invalidJson]: 'Respons server tidak dapat dibaca. Coba lagi.',
  [CLIENT_ERROR_CODES.invalidErrorBody]: 'Terjadi kesalahan pada server. Coba lagi.',

  // Socket-level failures
  ACK_TIMEOUT: 'Server tidak merespons tepat waktu. Periksa koneksi lalu coba lagi.',
  SOCKET_EMIT_FAILED: 'Perintah tidak dapat dikirim ke server. Coba lagi.',

  // Authentication / access
  UNAUTHENTICATED: 'Sesi Anda tidak valid atau sudah berakhir. Silakan masuk kembali.',
  INVALID_CREDENTIALS: 'Email atau password salah.',
  EMAIL_ALREADY_REGISTERED: 'Email ini sudah terdaftar.',
  OPERATOR_SESSION_REQUIRED: 'Sesi operator diperlukan.',
  OPERATOR_SESSION_INVALID: 'Sesi operator tidak valid.',
  OPERATOR_SESSION_REVOKED: 'Sesi operator sudah dicabut. Hubungkan ulang operator.',
  OPERATOR_SESSION_EXPIRED: 'Sesi operator sudah berakhir. Hubungkan ulang operator.',
  OPERATOR_SESSION_STALE: 'Kendali operator telah diambil alih perangkat lain.',
  OPERATOR_SESSION_CONFLICT: 'Operator lain sedang mengendalikan pertandingan ini.',
  HANDOVER_CODE_INVALID: 'Kode handover tidak valid.',
  HANDOVER_CODE_EXPIRED: 'Kode handover sudah kedaluwarsa.',
  VIEW_CODE_REQUIRED: 'Tautan viewer tidak lengkap. Gunakan tautan yang diberikan operator.',
  VIEW_CODE_INVALID: 'Tautan viewer tidak valid untuk pertandingan ini.',
  UNTRUSTED_ORIGIN: 'Permintaan ditolak karena asal tidak dikenal.',
  FORBIDDEN: 'Anda tidak memiliki izin untuk tindakan ini.',
  JOIN_REQUIRED: 'Hubungkan ke pertandingan terlebih dahulu.',

  // Validation & state
  VALIDATION_ERROR: 'Data yang dikirim tidak valid. Periksa kembali isian Anda.',
  INVALID_JSON: 'Data permintaan tidak dapat dibaca.',
  VERSION_CONFLICT: 'Data pertandingan sudah berubah. Memuat ulang data terbaru.',
  STATE_CONFLICT: 'Status pertandingan berubah. Data terbaru telah dimuat ulang.',
  STATE_UPDATE_FAILED: 'Penyimpanan perubahan gagal. Data terbaru telah dimuat ulang.',
  LIFECYCLE_VIA_REST: 'Tindakan ini harus dilakukan melalui API pertandingan.',

  // Resources
  MATCH_NOT_FOUND: 'Pertandingan tidak ditemukan.',
  NOT_FOUND: 'Sumber daya tidak ditemukan.',
  INVALID_MATCH_ID: 'ID pertandingan tidak valid.',
  INVALID_EVENT_ID: 'ID event tidak valid.',
  INVALID_CONFIG: 'Konfigurasi pertandingan tidak valid untuk cabang olahraga ini.',
  TX_ID_CONFLICT: 'Permintaan ganda terdeteksi. Muat ulang data terbaru.',
  MATCH_ALREADY_CLAIMED: 'Pertandingan ini sudah dimiliki akun lain.',
  CONTEXT_UPDATE_FAILED: 'Gagal memperbarui konteks pertandingan.',

  // Events (account-owned)
  EVENT_NOT_FOUND: 'Event tidak ditemukan.',
  EVENT_FORBIDDEN: 'Anda bukan pemilik event ini.',
  EVENT_ARCHIVED: 'Event ini sudah diarsipkan.',
  EVENT_DEPTH_EXCEEDED: 'Event tidak boleh lebih dari dua tingkat.',
  EVENT_HAS_DEPENDENCIES: 'Event masih memiliki pertandingan atau event anak.',
  EVENT_OWNER_MISMATCH: 'Pemilik event tidak sesuai dengan akun Anda.',
  EVENT_OWNER_REQUIRED: 'Event hanya dapat dibuat oleh akun.',
  EVENT_SPORT_MISMATCH: 'Cabang olahraga event harus sama dengan cabang olahraga induknya.',
  MATCH_EVENT_OWNER_MISMATCH: 'Pertandingan dan event harus dimiliki akun yang sama.',
  MATCH_EVENT_SPORT_MISMATCH: 'Cabang olahraga pertandingan harus sama dengan event.',
  PARENT_EVENT_NOT_FOUND: 'Event induk tidak ditemukan.',
};

const FALLBACK_MESSAGE = 'Terjadi kesalahan. Silakan coba lagi.';

/** Safe user-facing text for a backend code; never includes request data. */
export function safeMessageFor(code: string, fallback?: string): string {
  return SAFE_MESSAGES[code] ?? fallback ?? FALLBACK_MESSAGE;
}

export interface ApiClientErrorInit {
  status: number;
  code: string;
  /** Optional backend-supplied message, used only when no safe copy exists. */
  backendMessage?: string;
  currentVersion?: number;
  snapshot?: unknown;
  /** Only populated for client-side failures, never for backend responses. */
  cause?: unknown;
}

/**
 * A failed API call in a normalised shape.
 *
 * `code` is always the backend code (or a `CLIENT_ERROR_CODES` value) so callers
 * can branch on it; `message` is always safe Bahasa Indonesia.
 */
export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly currentVersion?: number;
  readonly snapshot?: unknown;

  constructor(init: ApiClientErrorInit) {
    super(safeMessageFor(init.code, init.backendMessage));
    this.name = 'ApiClientError';
    this.status = init.status;
    this.code = init.code;
    this.currentVersion = init.currentVersion;
    this.snapshot = init.snapshot;
    if (init.cause !== undefined) {
      // Keep the cause for diagnostics without widening the public shape.
      this.cause = init.cause;
    }
  }

  /** True when the client should resync from `snapshot`. */
  get isVersionConflict(): boolean {
    return this.status === 409 && this.code === 'VERSION_CONFLICT';
  }
}

export function isApiClientError(value: unknown): value is ApiClientError {
  return value instanceof ApiClientError;
}
