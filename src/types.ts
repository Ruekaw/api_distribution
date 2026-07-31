export interface AuditContext {
  ipHashPrefix?: string;
  globalRequestCount?: number;
  stream?: boolean;
  errorCategory?: string;
}

export interface ChatRequestBody {
  [key: string]: unknown;
}

export interface Reservation {
  leaseId: string;
  globalRequestCount: number;
}

export type ReservationFailureCode =
  | 'hourly_unique_ip_limit'
  | 'per_ip_rpm_limit'
  | 'global_request_limit'
  | 'max_concurrency';

export interface ReservationFailure {
  code: ReservationFailureCode;
  retryAfterSeconds: number;
}

export interface ReservationInput {
  ipHash: string;
  now: Date;
  perIpRpmLimit: number;
  hourlyUniqueIpLimit: number;
  globalRequestLimit: number;
  maxConcurrency: number;
  leaseTtlSeconds: number;
}

export interface QuotaStore {
  reserve(input: ReservationInput): Promise<Reservation | ReservationFailure>;
  releaseLease(leaseId: string): Promise<void>;
  getGlobalRequestCount(): Promise<number>;
  close(): Promise<void>;
}
