// Shared API envelope shape (PRD §22 API spec): every route responds with
// either `{ data }` on success or `{ error, code }` on failure.

export type ApiSuccess<T> = {
  data: T;
};

export type ApiError = {
  error: string;
  code: string;
};

export type ApiResponse<T> = ApiSuccess<T> | ApiError;
