import { useState } from 'react';

type DspChainPanelProps = {
  proMode: boolean;
};

export const DspChainPanel = ({ proMode }: DspChainPanelProps) => {
  if (!proMode) return null;

  const [nodes, setNodes] = useState([
    { id: 'resampler', label: 'Resampler', enabled: true },
    { id: 'filter', label: 'Filter', enabled: true },
    { id: 'spatial', label: 'Spatial', enabled: false },
    { id: 'dither', label: 'Dither', enabled: true },
    { id: 'output', label: 'Output', enabled: true },
  ]);

  const moveNode = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= nodes.length) return;
    const next = [...nodes];
    const [removed] = next.splice(index, 1);
    next.splice(target, 0, removed);
    setNodes(next);
  };

  const toggleNode = (index: number) => {
    const next = [...nodes];
    next[index] = { ...next[index], enabled: !next[index].enabled };
    setNodes(next);
  };

  return (
    <section className="panel settings-container dsp-chain-panel">
      <div className="section-title">DSP Chain</div>
      <div className="chain">
        {nodes.map((node) => (
          <div
            key={node.id}
            className={`chain-node ${node.enabled ? 'active' : ''}`}
          >
            {node.label}
          </div>
        ))}
      </div>
      <div className="chain-details">
        {nodes.map((node, index) => (
          <div key={`${node.id}-card`} className="chain-card">
            <div className="chain-title">{node.label}</div>
            <div className="chain-subtitle">
              {node.enabled ? 'Enabled' : 'Disabled'}
            </div>
            <div className="chain-body">
              <button className="ghost-btn" onClick={() => toggleNode(index)}>
                {node.enabled ? '关闭' : '启用'}
              </button>
              <div className="chain-actions">
                <button
                  className="ghost-btn"
                  onClick={() => moveNode(index, -1)}
                >
                  上移
                </button>
                <button
                  className="ghost-btn"
                  onClick={() => moveNode(index, 1)}
                >
                  下移
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="placeholder">
        Pro 模式下的节点编排占位，后续接入可视化链路。
      </div>
    </section>
  );
};
