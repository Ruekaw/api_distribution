export interface ProxyConfig {
  upstreamUrl: string;
  upstreamApiKey: string;
  groupApiKey: string;
  ipHmacSecret: string;
  modelName: string;
  perIpRpmLimit: number;
  hourlyUniqueIpLimit: number;
  globalRequestLimit: number;
  maxConcurrency: number;
  leaseTtlSeconds: number;
  leaseHeartbeatSeconds: number;
  maxOutputTokens: number;
  maxBodyBytes: number;
  disableAt: number | null;
  quotaScope: string;
}

export interface ChatRequestBody {
  [key: string]: unknown;
}

export interface AcquireInput {
  ipHash: string;
  nowMs: number;
  quotaScope: string;
  perIpRpmLimit: number;
  hourlyUniqueIpLimit: number;
  globalRequestLimit: number;
  maxConcurrency: number;
  leaseTtlSeconds: number;
}

export interface AcquireSuccess {
  ok: true;
  leaseId: string;
  globalRequestCount: number;
}

export type LimiterCode =
  | "per_ip_rpm_limit"
  | "hourly_unique_ip_limit"
  | "global_request_limit"
  | "max_concurrency";

export interface AcquireFailure {
  ok: false;
  code: LimiterCode;
  retryAfterSeconds?: number;
}

export type AcquireResult = AcquireSuccess | AcquireFailure;

export interface LimiterStatus {
  globalUsage: Array<{
    scope: string;
    requestCount: number;
  }>;
  activeLeaseCount: number;
  totalLeaseCount: number;
  hourlyAdmissionCount: number;
  minuteUsageCount: number;
}

export interface AuditContext {
  ipHashPrefix?: string;
  status?: number;
  stream?: boolean;
  errorCategory?: string;
  globalRequestCount?: number;
}

export interface ErrorBody {
  error: {
    message: string;
    type: string;
    code: string;
  };
}
