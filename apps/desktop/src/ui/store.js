(function registerStore() {
    const listeners = new Set();
    let state = {
        playback: null,
        buffer: null,
        stream: null,
        spectrum: null,
        engine: { connected: false, message: '' }
    };

    const notify = (prevState) => {
        listeners.forEach((listener) => listener(state, prevState));
    };

    const setState = (patch) => {
        const prevState = state;
        state = { ...state, ...patch };
        notify(prevState);
    };

    const update = (updater) => {
        const prevState = state;
        const nextState = updater(state);
        state = nextState || state;
        notify(prevState);
    };

    const ingest = (event) => {
        if (!event || !event.type) return;
        switch (event.type) {
            case 'playback.state':
                setState({ playback: event.state });
                break;
            case 'buffer.state':
                setState({ buffer: event });
                break;
            case 'stream.state':
                setState({ stream: event });
                break;
            case 'spectrum.data':
                setState({ spectrum: event.data });
                break;
            case 'engine.status':
                setState({
                    engine: {
                        connected: Boolean(event.connected),
                        message: event.message || ''
                    }
                });
                break;
            case 'error':
                setState({
                    engine: {
                        connected: false,
                        message: event.message || 'error'
                    }
                });
                break;
            default:
                break;
        }
    };

    window.ntmusicStore = {
        getState: () => state,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        setState,
        update,
        ingest
    };
})();
