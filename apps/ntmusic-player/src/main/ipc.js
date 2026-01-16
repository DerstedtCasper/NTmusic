const { ipcMain } = require('electron');

function registerEngineIpc(engineGateway) {
    ipcMain.handle('engine:cmd', async (_event, { name, payload } = {}) => {
        if (!engineGateway) {
            return { status: 'error', message: 'Engine gateway not ready.' };
        }
        return engineGateway.command(name, payload);
    });
}

module.exports = { registerEngineIpc };
