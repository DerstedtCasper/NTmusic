import { useEffect, useMemo, useState } from 'react';
import { engineCmd } from '../../shared/lib/engine';

type EqPanelProps = {
  playback: Record<string, any> | null;
  proMode: boolean;
};

const bands = ['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];

export const EqPanel = ({ playback, proMode }: EqPanelProps) => {
  const [enabled, setEnabled] = useState(false);
  const [eqType, setEqType] = useState('IIR');
  const [values, setValues] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!playback) return;
    if (playback.eq_enabled !== undefined) {
      setEnabled(Boolean(playback.eq_enabled));
    }
    if (playback.eq_type) {
      setEqType(playback.eq_type);
    }
    if (playback.eq_bands) {
      setValues(playback.eq_bands);
    }
  }, [playback]);

  const displayValues = useMemo(() => {
    const merged: Record<string, number> = {};
    bands.forEach((band) => {
      const raw = values?.[band];
      merged[band] = typeof raw === 'number' ? raw : 0;
    });
    return merged;
  }, [values]);

  const applyEq = async (nextValues = displayValues, nextEnabled = enabled) => {
    await engineCmd('set-eq', {
      bands: nextValues,
      enabled: nextEnabled,
    });
  };

  if (!proMode) return null;

  return (
    <section className="panel settings-container eq-panel">
      <div className="section-title">均衡器</div>
      <div className="setting-row">
        <label>启用</label>
        <input
          type="checkbox"
          checked={enabled}
          onChange={async (event) => {
            const value = event.target.checked;
            setEnabled(value);
            await applyEq(displayValues, value);
          }}
        />
      </div>
      <div className="setting-row">
        <label>类型</label>
        <select
          value={eqType}
          onChange={async (event) => {
            const value = event.target.value;
            setEqType(value);
            await engineCmd('set-eq-type', { type: value });
          }}
        >
          <option value="IIR">IIR</option>
          <option value="FIR">FIR</option>
        </select>
      </div>
      <div className="eq-bands">
        {bands.map((band) => (
          <div key={band} className="eq-band">
            <label>{band}</label>
            <input
              type="range"
              min={-12}
              max={12}
              step={1}
              value={displayValues[band]}
              onChange={(event) => {
                const next = { ...displayValues, [band]: Number(event.target.value) };
                setValues(next);
              }}
              onMouseUp={async () => applyEq(displayValues, enabled)}
              onTouchEnd={async () => applyEq(displayValues, enabled)}
            />
            <span className="eq-value">{displayValues[band]} dB</span>
          </div>
        ))}
      </div>
    </section>
  );
};
