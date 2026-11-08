import { useI18n } from '../i18n';
import { useLive } from '../lib/live';
import { PLATFORM_NAME, type PlatformId } from '../lib/types';
import { Cross } from './icons';

const RETRYABLE = new Set(['relay_failed']);

export function Toasts({ onRetry }: { onRetry?: (platform: PlatformId) => void }): JSX.Element {
  const { t } = useI18n();
  const { toasts, dismissToast } = useLive();

  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => {
        const name = toast.platform ? PLATFORM_NAME[toast.platform] : '';
        const key = `toast.${toast.code}`;
        const text = t(key, { name, detail: toast.detail ?? '' });
        const fallback = text === key ? t('toast.generic_error', { detail: toast.code }) : text;
        return (
          <div key={toast.id} className={`toast ${toast.level}`}>
            <div className="row between" style={{ alignItems: 'flex-start', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <div className="t-title">{fallback}</div>
                {toast.detail && !fallback.includes(toast.detail) ? (
                  <div className="t-detail">{toast.detail}</div>
                ) : null}
                {toast.retryable && RETRYABLE.has(toast.code) && toast.platform && onRetry ? (
                  <button
                    className="sm"
                    style={{ marginTop: 8 }}
                    onClick={() => {
                      onRetry(toast.platform as PlatformId);
                      dismissToast(toast.id);
                    }}
                  >
                    {t('common.retry')}
                  </button>
                ) : null}
              </div>
              <button className="ghost" aria-label={t('common.close')} onClick={() => dismissToast(toast.id)}>
                <Cross />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
