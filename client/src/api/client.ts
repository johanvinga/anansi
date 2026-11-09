import i18next from "i18next";

export interface ApiErrorDetail {
  field?: string;
  message: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: ApiErrorDetail[];

  constructor(status: number, code: string, message: string, details: ApiErrorDetail[] = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Returns the first validation message for a given field, if any. */
  fieldError(field: string): string | undefined {
    return this.details.find((d) => d.field === field)?.message;
  }
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface ErrorEnvelope {
  error?: { code?: string; message?: string; details?: ApiErrorDetail[] };
}

export async function apiRequest<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (data as ErrorEnvelope | null)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? "INTERNAL_ERROR",
      error?.message ?? i18next.t("errors.generic"),
      error?.details ?? [],
    );
  }
  return data as T;
}

/** Sends multipart form data. The browser sets the Content-Type boundary itself. */
export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method: "POST",
    credentials: "same-origin",
    body: form,
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (data as ErrorEnvelope | null)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? "INTERNAL_ERROR",
      error?.message ?? i18next.t("errors.uploadFailed"),
      error?.details ?? [],
    );
  }
  return data as T;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : i18next.t("errors.generic");
}
