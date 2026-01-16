import { useEffect, useState } from 'react';
import { engineCmd } from '../../shared/lib/engine';

type QualityPanelProps = {
  playback: Record<string, any> | null;
  proMode: boolean;
};

const upsamplingOptions = [
  { label: '关闭', value: 0 },
  { label: '96k', value: 96000 },
  { label: '192k', value: 192000 },
];

export const QualityPanel = ({ playback, proMode }: QualityPanelProps) => {
  const [upsampling, setUpsampling] = useState(0);
  const [resampler, setResampler] = useState('auto');
  const [ditherType, setDitherType] = useState('off');
  const [replaygain, setReplaygain] = useState(false);
  const [soxrAvailable, setSoxrAvailable] = useState(true);

  useEffect(() => {
    if (!playback) return;
    if (playback.target_samplerate !== undefined) {
      setUpsampling(playback.target_samplerate || 0);
    }
    if (playback.resampler_mode) {
      setResampler(playback.resampler_mode);
    }
    if (playback.soxr_available !== undefined) {
      setSoxrAvailable(Boolean(playback.soxr_available));
    }
    if (playback.dither_enabled !== undefined) {
      const bits = playback.dither_bits || 24;
      const enabled = playback.dither_enabled;
      setDitherType(enabled ? (bits === 16 ? 'tpdf16' : 'tpdf24') : 'off');
    }
    if (playback.replaygain_enabled !== undefined) {
      setReplaygain(Boolean(playback.replaygain_enabled));
    }
  }, [playback]);

  const applyOptimizations = async (nextResampler?: string, nextDither?: string, nextReplaygain?: boolean) => {
    const ditherChoice = nextDither ?? ditherType;
    const ditherEnabled = ditherChoice !== 'off';
    const ditherBits = ditherChoice === 'tpdf16' ? 16 : 24;
    const ditherTypeValue = ditherEnabled ? 'tpdf' : 'off';
    await engineCmd('configure-optimizations', {
      dither_enabled: ditherEnabled,
      dither_type: ditherTypeValue,
      dither_bits: ditherBits,
      replaygain_enabled: nextReplaygain ?? replaygain,
      resampler_mode: nextResampler ?? resampler,
      resampler_quality: 'hq',
    });
  };

  return (
    <section className="panel settings-container">
      <div className="section-title">音质设置</div>
      <div className="setting-row">
        <label>升频</label>
        <select
          value={upsampling}
          onChange={async (event) => {
            const value = Number(event.target.value);
            setUpsampling(value);
            await engineCmd('configure-upsampling', {
              target_samplerate: value > 0 ? value : null,
            });
          }}
        >
          {upsamplingOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      {proMode && (
        <>
          <div className="setting-row">
            <label>重采样器</label>
            <select
              value={resampler}
              onChange={async (event) => {
                const value = event.target.value;
                if (value === 'soxr' && !soxrAvailable) {
                  setResampler('auto');
                  return;
                }
                setResampler(value);
                await applyOptimizations(value);
              }}
            >
              <option value="auto">Auto</option>
              <option value="rubato">Rubato</option>
              <option value="soxr" disabled={!soxrAvailable}>
                Soxr {soxrAvailable ? '' : '(Missing)'}
              </option>
            </select>
          </div>
          <div className="setting-row">
            <label>Dither</label>
            <select
              value={ditherType}
              onChange={async (event) => {
                const value = event.target.value;
                setDitherType(value);
                await applyOptimizations(undefined, value);
              }}
            >
              <option value="off">Off</option>
              <option value="tpdf16">TPDF 16</option>
              <option value="tpdf24">TPDF 24</option>
            </select>
          </div>
          <div className="setting-row">
            <label>动态增益</label>
            <input
              type="checkbox"
              checked={replaygain}
              onChange={async (event) => {
                const value = event.target.checked;
                setReplaygain(value);
                await applyOptimizations(undefined, undefined, value);
              }}
            />
          </div>
        </>
      )}
    </section>
  );
};
