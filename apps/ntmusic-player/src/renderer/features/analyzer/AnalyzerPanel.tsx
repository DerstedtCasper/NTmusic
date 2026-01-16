type AnalyzerPanelProps = {
  proMode: boolean;
  spectrum: number[] | null;
};

const toBars = (spectrum: number[]) => {
  const count = 32;
  const step = Math.max(1, Math.floor(spectrum.length / count));
  const bars: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const idx = i * step;
    const value = spectrum[idx] ?? 0;
    bars.push(Math.min(1, Math.max(0, value)));
  }
  return bars;
};

export const AnalyzerPanel = ({ proMode, spectrum }: AnalyzerPanelProps) => {
  if (!proMode) return null;
  const bars = spectrum ? toBars(spectrum) : [];

  const phaseBars = bars.length
    ? bars.map((value) => Math.min(1, value * 0.6 + 0.2))
    : [];
  const loudnessBars = bars.length
    ? bars.map((value) => Math.min(1, value * 0.4 + 0.1))
    : [];

  return (
    <section className="panel settings-container analyzer-panel">
      <div className="section-title">Analyzer</div>
      <div className="analyzer-grid">
        <div className="analyzer-card active">频谱</div>
        <div className="analyzer-card">相位</div>
        <div className="analyzer-card">响度</div>
      </div>
      <div className="spectrum-bars">
        {bars.length === 0 ? (
          <div className="placeholder">等待频谱数据...</div>
        ) : (
          bars.map((value, index) => (
            <div
              key={`bar-${index}`}
              className="spectrum-bar"
              style={{ height: `${Math.round(value * 100)}%` }}
            />
          ))
        )}
      </div>
      <div className="analyzer-secondary">
        <div className="secondary-block">
          <div className="secondary-title">相位概览</div>
          <div className="mini-bars">
            {phaseBars.length === 0 ? (
              <div className="placeholder">等待相位数据...</div>
            ) : (
              phaseBars.map((value, index) => (
                <div
                  key={`phase-${index}`}
                  className="mini-bar"
                  style={{ height: `${Math.round(value * 100)}%` }}
                />
              ))
            )}
          </div>
        </div>
        <div className="secondary-block">
          <div className="secondary-title">响度概览</div>
          <div className="mini-bars loudness">
            {loudnessBars.length === 0 ? (
              <div className="placeholder">等待响度数据...</div>
            ) : (
              loudnessBars.map((value, index) => (
                <div
                  key={`loud-${index}`}
                  className="mini-bar"
                  style={{ height: `${Math.round(value * 100)}%` }}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
};
