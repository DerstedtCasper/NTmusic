type Device = {
  id: number;
  name: string;
  hostapi?: string;
};

type DevicePanelProps = {
  devices: Device[];
  currentDeviceId: number | null;
  exclusive: boolean;
  onRefresh: () => void;
  onChange: (deviceId: number | null, exclusive: boolean) => void;
  onToggleExclusive: (exclusive: boolean) => void;
};

export const DevicePanel = ({
  devices,
  currentDeviceId,
  exclusive,
  onRefresh,
  onChange,
  onToggleExclusive,
}: DevicePanelProps) => {
  return (
    <section className="panel settings-container">
      <div className="section-title">输出设备</div>
      <div className="setting-row">
        <label>设备</label>
        <select
          value={currentDeviceId === null ? 'default' : String(currentDeviceId)}
          onChange={(event) => {
            const value = event.target.value;
            const deviceId = value === 'default' ? null : Number(value);
            onChange(deviceId, exclusive);
          }}
        >
          <option value="default">默认设备</option>
          {devices.map((device) => {
            const label = device.hostapi ? `[${device.hostapi}] ${device.name}` : device.name;
            return (
              <option key={device.id} value={device.id}>
                {label}
              </option>
            );
          })}
        </select>
      </div>
      <div className="setting-row">
        <label>独占模式</label>
        <input
          type="checkbox"
          checked={exclusive}
          onChange={(event) => onToggleExclusive(event.target.checked)}
        />
      </div>
      <button className="ghost-btn" onClick={onRefresh}>
        刷新设备
      </button>
    </section>
  );
};
