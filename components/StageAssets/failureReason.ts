type FailureReasonCarrier = {
  error?: unknown;
  failureReason?: unknown;
  message?: unknown;
  lastError?: unknown;
};

const MAX_FAILURE_REASON_LENGTH = 320;

export const getFailureReason = (asset: FailureReasonCarrier | null | undefined): string => {
  if (!asset) return '';
  const raw = asset.error ?? asset.failureReason ?? asset.message ?? asset.lastError;
  if (raw == null) return '';
  const reason = String(raw).trim().replace(/\s+/g, ' ');
  if (!reason) return '';
  if (reason.length <= MAX_FAILURE_REASON_LENGTH) return reason;
  return `${reason.slice(0, MAX_FAILURE_REASON_LENGTH)}...`;
};

export const formatFailureStatus = (asset: FailureReasonCarrier | null | undefined): string => {
  const reason = getFailureReason(asset);
  return reason ? `生成失败：${reason}` : '生成失败';
};
