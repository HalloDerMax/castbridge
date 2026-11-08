import { useState } from 'react';
import { useI18n } from '../i18n';
import { copyToClipboard } from '../lib/format';
import { Check } from './icons';

interface Props {
  label: string;
  value: string;
  hint?: string;
  secret?: boolean;
}

export function CopyField({ label, value, hint, secret = false }: Props): JSX.Element {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(!secret);

  const copy = async (): Promise<void> => {
    const ok = await copyToClipboard(value);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    }
  };

  return (
    <label className="field">
      <span className="label">{label}</span>
      <div className="copy-row">
        <input
          type={revealed ? 'text' : 'password'}
          value={value}
          readOnly
          onFocus={(e) => e.currentTarget.select()}
          spellCheck={false}
        />
        {secret ? (
          <button type="button" className="nowrap" onClick={() => setRevealed((v) => !v)}>
            {revealed ? t('common.hide') : t('common.show')}
          </button>
        ) : null}
        <button type="button" className="nowrap primary" onClick={() => void copy()}>
          {copied ? (
            <>
              <Check /> {t('common.copied')}
            </>
          ) : (
            t('common.copy')
          )}
        </button>
      </div>
      {hint ? <div className="hint">{hint}</div> : null}
    </label>
  );
}
