export declare const PADI_CLIENT_ID: string;

export declare const LOGBOOK_PAGE_QUERY: string;

export declare class PadiApiError extends Error {
  status: number | undefined;
  constructor(message: string, status?: number);
}

export interface PadiTokenSet {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
}

export interface PadiLoginResponse {
  tokens: PadiTokenSet;
}

export interface PadiLogbookLogsPage {
  data: {
    logbook_logs: unknown[];
  };
}

export interface PadiCreateLogbookDiveResponse {
  data: {
    insert_logbook_logs: {
      affected_rows: number;
      returning: Array<Record<string, unknown> & { id: number }>;
    };
  };
}

export function login(username: string, password: string): Promise<PadiLoginResponse>;

export function refresh(refreshToken: string, idToken: string): Promise<PadiLoginResponse>;

export function fetchLogbookPage(
  bearerToken: string,
  affiliateId: string | number,
  options: { limit?: number; offset?: number },
): Promise<PadiLogbookLogsPage>;

export function fetchLogbookDetail(
  bearerToken: string,
  affiliateId: string | number,
  id: string | number,
): Promise<PadiLogbookLogsPage>;

export function createLogbookDive(
  bearerToken: string,
  affiliateId: string | number,
  general: Record<string, unknown>,
): Promise<PadiCreateLogbookDiveResponse>;

export function decodeIdTokenClaims(idToken: string): { affiliateId: string | undefined };
