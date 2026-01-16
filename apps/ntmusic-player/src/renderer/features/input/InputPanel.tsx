import { useEffect, useState } from 'react';

type CaptureDevice = {
  id: number;
  name: string;
};

type InputPanelProps = {
  mode: 'file' | 'stream' | 'capture';
  streamUrl: string;
  captureDevices: CaptureDevice[];
  captureDeviceId: number | null;
  onCaptureDeviceChange: (deviceId: number | null) => void;
  onModeChange: (mode: 'file' | 'stream' | 'capture') => void;
  onStreamUrlChange: (value: string) => void;
  onStreamStart: () => void;
  onStreamStop: () => void;
  onCaptureStart: () => void;
  onCaptureStop: () => void;
  onRefreshCaptureDevices: () => void;
};

export const InputPanel = ({
  mode,
  streamUrl,
  captureDevices,
  captureDeviceId,
  onCaptureDeviceChange,
  onModeChange,
  onStreamUrlChange,
  onStreamStart,
  onStreamStop,
  onCaptureStart,
  onCaptureStop,
  onRefreshCaptureDevices,
}: InputPanelProps) => {
  const [localMode, setLocalMode] = useState(mode);

  useEffect(() => {
    setLocalMode(mode);
  }, [mode]);

  return (
    <section className="panel input-panel">
      <div className="section-title">输入源</div>
      <div className="input-row">
        <label>模式</label>
        <select
          value={localMode}
          onChange={(event) => {
            const value = event.target.value as 'file' | 'stream' | 'capture';
            setLocalMode(value);
            onModeChange(value);
          }}
        >
          <option value="file">本地文件</option>
          <option value="stream">流媒体</option>
          <option value="capture">系统捕获</option>
        </select>
      </div>
      {localMode === 'stream' && (
        <div className="input-block">
          <input
            type="text"
            placeholder="输入流媒体 URL"
            value={streamUrl}
            onChange={(event) => onStreamUrlChange(event.target.value)}
          />
          <div className="input-actions">
            <button className="ghost-btn" onClick={onStreamStart}>
              启动
            </button>
            <button className="ghost-btn" onClick={onStreamStop}>
              停止
            </button>
          </div>
        </div>
      )}
      {localMode === 'capture' && (
        <div className="input-block">
          <div className="input-row">
            <label>设备</label>
            <select
              value={captureDeviceId === null ? 'default' : String(captureDeviceId)}
              onChange={(event) => {
                const value = event.target.value;
                const deviceId = value === 'default' ? null : Number(value);
                onModeChange('capture');
                if (deviceId !== captureDeviceId) {
                  onCaptureDeviceChange(deviceId);
                  onCaptureStop();
                }
              }}
            >
              <option value="default">默认设备</option>
              {captureDevices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name}
                </option>
              ))}
            </select>
          </div>
          <div className="input-actions">
            <button className="ghost-btn" onClick={onCaptureStart}>
              开始捕获
            </button>
            <button className="ghost-btn" onClick={onCaptureStop}>
              停止捕获
            </button>
            <button className="ghost-btn" onClick={onRefreshCaptureDevices}>
              刷新设备
            </button>
          </div>
        </div>
      )}
    </section>
  );
};
