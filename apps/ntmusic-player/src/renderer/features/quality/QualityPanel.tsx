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
  const [resamplerQuality, setResamplerQuality] = useState('hq');
  const [ditherType, setDitherType] = useState('off');
  const [replaygain, setReplaygain] = useState(false);
  const [soxrAvailable, setSoxrAvailable] = useState(true);

  const resolveDitherChoice = (state: Record<string, any>) => {
    const enabled = state.dither_enabled !== false;
    const bits = state.dither_bits || 24;
    const normalized = (state.dither_type || (enabled ? 'tpdf' : 'off')).toLowerCase();
    if (!enabled || normalized === 'off') return 'off';
    const bitSuffix = bits === 16 ? '16' : '24';
    if (normalized === 'tpdf_ns1') return `tpdf_ns1_${bitSuffix}`;
    if (normalized === 'tpdf_ns2') return `tpdf_ns2_${bitSuffix}`;
    return `tpdf${bitSuffix}`;
  };

  const parseDitherChoice = (choice: string) => {
    if (choice === 'off') {
      return { enabled: false, ditherTypeValue: 'off', bits: 24 };
    }
    if (choice.startsWith('tpdf_ns1_')) {
      return {
        enabled: true,
        ditherTypeValue: 'tpdf_ns1',
        bits: choice.endsWith('16') ? 16 : 24,
      };
    }
    if (choice.startsWith('tpdf_ns2_')) {
      return {
        enabled: true,
        ditherTypeValue: 'tpdf_ns2',
        bits: choice.endsWith('16') ? 16 : 24,
      };
    }
    return {
      enabled: true,
      ditherTypeValue: 'tpdf',
      bits: choice === 'tpdf16' ? 16 : 24,
    };
  };

  useEffect(() => {
    if (!playback) return;
    if (playback.target_samplerate !== undefined) {
      setUpsampling(playback.target_samplerate || 0);
    }
    if (playback.resampler_mode) {
      setResampler(playback.resampler_mode);
    }
    if (playback.resampler_quality) {
      setResamplerQuality(playback.resampler_quality);
    }
    if (playback.soxr_available !== undefined) {
      setSoxrAvailable(Boolean(playback.soxr_available));
    }
    if (playback.dither_enabled !== undefined) {
      setDitherType(resolveDitherChoice(playback));
    }
    if (playback.replaygain_enabled !== undefined) {
      setReplaygain(Boolean(playback.replaygain_enabled));
    }
  }, [playback]);

  const applyOptimizations = async (nextResampler?: string, nextDither?: string, nextReplaygain?: boolean) => {
    const ditherChoice = nextDither ?? ditherType;
    const parsed = parseDitherChoice(ditherChoice);
    await engineCmd('configure-optimizations', {
      dither_enabled: parsed.enabled,
      dither_type: parsed.ditherTypeValue,
      dither_bits: parsed.bits,
      replaygain_enabled: nextReplaygain ?? replaygain,
      resampler_mode: nextResampler ?? resampler,
      resampler_quality: resamplerQuality,
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
            <label>重采样质量</label>
            <select
              value={resamplerQuality}
              onChange={async (event) => {
                const value = event.target.value;
                setResamplerQuality(value);
                await engineCmd('configure-optimizations', {
                  dither_enabled: parseDitherChoice(ditherType).enabled,
                  dither_type: parseDitherChoice(ditherType).ditherTypeValue,
                  dither_bits: parseDitherChoice(ditherType).bits,
                  replaygain_enabled: replaygain,
                  resampler_mode: resampler,
                  resampler_quality: value,
                });
              }}
            >
              <option value="low">Low</option>
              <option value="std">Standard</option>
              <option value="hq">High</option>
              <option value="uhq">Ultra</option>
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
              <option value="tpdf_ns1_16">TPDF NS1 16</option>
              <option value="tpdf_ns1_24">TPDF NS1 24</option>
              <option value="tpdf_ns2_16">TPDF NS2 16</option>
              <option value="tpdf_ns2_24">TPDF NS2 24</option>
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
