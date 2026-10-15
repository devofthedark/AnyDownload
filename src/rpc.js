(function (global) {
    'use strict';
    
    const NS = 'ytx';
    const MAX_HOPS = 15;
    const DEFAULT_TIMEOUT = 30_000;
    
    const encodeErr = (e) => ({
        name: e?.name ?? 'Error',
        message: String(e?.message ?? e),
        stack: e?.stack,
    });
    
    const decodeErr = (o) => {
        const e = new Error(o.message);
        e.name = o.name;
        e.remoteStack = o.stack; // keep the far-side stack; local one is useless
        return e;
    };
    
    function createNode(id, { onError = console.error } = {}) {
        console.debug("[RPC]", `Created RPC Node with id "${id}"`);
        const handlers = new Map();  // method -> fn
        const pending = new Map();   // callId -> {resolve, reject, timer, via}
        const inflight = new Map();  // callId -> AbortController (server side)
        const links = new Map();     // peerId -> link
        const routes = new Map();    // destId -> peerId to forward through
        let seq = 0;
        
        const peerFor = (to) => routes.get(to) ?? to;
        const linkFor = (to) => links.get(peerFor(to));
        
        function ship(env, transfer) {
            const link = linkFor(env.to);
            if (!link) throw new Error(`[${id}] no route to "${env.to}"`);
            //console.debug("[RPC]", `[${id}]`, `"${env.from}" transfer via "${routes.get(env.to) ?? env.to}" to "${env.to}"`);
            link.send(env, transfer);
        }
        
        function receive(env, link) {
            if (env?.ns !== NS) return;
            
            if (env.to !== id) {
                if ((env.hops ?? 0) >= MAX_HOPS) {
                    onError(new Error(`[${id}] dropping looping envelope to "${env.to}"`));
                    return;
                }
                try {
                    ship({ ...env, hops: (env.hops ?? 0) + 1 });
                } catch (e) {
                    if (env.kind === 'req') {
                        link.send({
                            ns: NS, v: 1, kind: 'res', id: env.id,
                            from: id, to: env.from, hops: 0, error: encodeErr(e),
                        });
                    } else {
                        onError(e);
                    }
                }
                return;
            }
            
            switch (env.kind) {
                case 'req': return serve(env);
                case 'nfy': return serve(env);
                case 'res': return settle(env);
                case 'cancel': return inflight.get(env.id)?.abort();
            }
        }
        
        async function serve(env) {
            // console.debug("[RPC]", `[${id}] got call to method "${env.method}" from "${env.from}"`);
            const fn = handlers.get(env.method);
            const isCall = env.kind === 'req';
            
            if (!fn) {
                const err = new Error(`[${id}] no handler for "${env.method}"`);
                if (isCall) {
                    ship({ ns: NS, v: 1, kind: 'res', id: env.id, from: id, to: env.from, hops: 0, error: encodeErr(err) });
                } else {
                    onError(err);
                }
                return;
            }
            
            const ctl = new AbortController();
            if (isCall) inflight.set(env.id, ctl);
            
            // Handlers push ArrayBuffers here to move them instead of copying them.
            const transfer = [];
            
            try {
                const value = await fn(env.params, { signal: ctl.signal, from: env.from, transfer });
                if (isCall) {
                    ship({ ns: NS, v: 1, kind: 'res', id: env.id, from: id, to: env.from, hops: 0, value }, transfer);
                }
            } catch (e) {
                if (isCall) {
                    try {
                        ship({ ns: NS, v: 1, kind: 'res', id: env.id, from: id, to: env.from, hops: 0, error: encodeErr(e) });
                    } catch (unreachable) {
                        // the caller can't be reached any more, e.g. its link went down while this ran
                        onError(unreachable);
                    }
                } else {
                    onError(e);
                }
            } finally {
                inflight.delete(env.id);
            }
        }
        
        function settle(env) {
            const p = pending.get(env.id);
            if (!p) return; // already timed out or cancelled
            pending.delete(env.id);
            clearTimeout(p.timer);
            env.error ? p.reject(decodeErr(env.error)) : p.resolve(env.value);
        }
        
        return {
            id,
            
            /** Register a method. Handler gets (params, {signal, from, transfer}). */
            handle(method, fn) {
                console.debug("[RPC]", `Node with id "${id}" set a handle for method "${method}"`);
                handlers.set(method, fn);
                return this;
            },
            
            /** Attach a physical neighbour. */
            connect(peerId, link) {
                links.set(peerId, link);
                link.listen((env) => receive(env, link));
                // a link that can tell when its other end goes away takes itself down
                link.onClose?.(() => {
                    if (links.get(peerId) === link) this.disconnect(peerId);
                });
                return this;
            },

            /**
             * Tear down a neighbour link (removes its listener) and any routes through it. Calls sent
             * through it fail, as their replies could only have come back that way.
             */
            disconnect(peerId) {
                const link = links.get(peerId);
                if (!link) return this;
                link.stop?.();
                links.delete(peerId);
                for (const [dest, via] of routes) {
                    if (via === peerId) routes.delete(dest);
                }
                for (const [callId, p] of pending) {
                    if (p.via !== peerId) continue;
                    pending.delete(callId);
                    clearTimeout(p.timer);
                    p.reject(new Error(`[${id}] "${p.method}" -> ${p.to} failed: lost the connection to "${peerId}"`));
                }
                return this;
            },

            /** Reach `destId` by forwarding through neighbour `viaId`. */
            route(destId, viaId) {
                routes.set(destId, viaId);
                return this;
            },
            

            call(to, method, params, { transfer, signal, timeout = DEFAULT_TIMEOUT } = {}) {
                console.debug("[RPC]", `Node "${id}" called method "${method}" of Node "${to}"`);
                const callId = `${id}:${++seq}`;
                return new Promise((resolve, reject) => {
                    const timer = timeout
                    ? setTimeout(() => {
                        pending.delete(callId);
                        reject(new Error(`[${id}] "${method}" -> ${to} timed out after ${timeout}ms`));
                    }, timeout)
                    : null;
                    
                    pending.set(callId, { resolve, reject, timer, method, to, via: peerFor(to) });
                    
                    signal?.addEventListener('abort', () => {
                        const p = pending.get(callId);
                        if (!p) return;
                        pending.delete(callId);
                        clearTimeout(p.timer);
                        try {
                            ship({ ns: NS, v: 1, kind: 'cancel', id: callId, from: id, to, hops: 0 });
                        } catch { /* peer already gone */ }
                        reject(new DOMException('Aborted', 'AbortError'));
                    }, { once: true });
                    
                    try {
                        ship({ ns: NS, v: 1, kind: 'req', id: callId, method, params, from: id, to, hops: 0 }, transfer);
                    } catch (e) {
                        pending.delete(callId);
                        clearTimeout(timer);
                        reject(e);
                    }
                });
            },
            
            notify(to, method, params, { transfer } = {}) {
                ship({ ns: NS, v: 1, kind: 'nfy', method, params, from: id, to, hops: 0 }, transfer);
            },
            
            /** Resolves once neighbour `key` is connected. With a `timeout`, rejects if it isn't by then. */
            waitForLink(key, { timeout = 0, interval = 50 } = {}) {
                const deadline = timeout ? Date.now() + timeout : Infinity;
                return new Promise((resolve, reject) => {
                    const check = () => {
                        if (links.has(key)) {
                            resolve(links.get(key));
                        } else if (Date.now() >= deadline) {
                            reject(new Error(`[${id}] no link to "${key}" after ${timeout}ms`));
                        } else {
                            setTimeout(check, interval);
                        }
                    };
                    check();
                });
            },
            
            /**
             * Resolves once `key` is reached directly rather than through another node. With a
             * `timeout`, rejects if it isn't by then.
             */
            waitForDirect(key, { timeout = 0, interval = 50 } = {}) {
                const deadline = timeout ? Date.now() + timeout : Infinity;
                return new Promise((resolve, reject) => {
                    // checked straight away: it's usually direct already, e.g. for every page fetch
                    const check = () => {
                        if (routes.get(key) === key) {
                            resolve();
                        } else if (Date.now() >= deadline) {
                            reject(new Error(`[${id}] no direct route to "${key}" after ${timeout}ms`));
                        } else {
                            setTimeout(check, interval);
                        }
                    };
                    check();
                });
            }
        };
    }
    
    function workerLink(target) {
        let handler;
        return {
            send: (env, transfer) => target.postMessage(env, transfer ?? []),
            listen: (fn) => {
                handler = (e) => fn(e.data);
                target.addEventListener('message', handler);
            },
            stop: () => target.removeEventListener('message', handler),
        };
    }

    function portLink(port) {
        let handler;
        return {
            send: (env) => port.postMessage(env),
            listen: (fn) => {
                handler = fn;
                port.onMessage.addListener(handler);
            },
            // the other end went away, e.g. the background was stopped or the tab closed
            onClose: (fn) => port.onDisconnect.addListener(() => fn()),
            stop: () => {
                port.onMessage.removeListener(handler);
                try { port.disconnect(); } catch { /* already gone */ }
            },
        };
    }

    function messagePortLink(port) {
        port.start();
        let handler;
        return {
            send: (env, transfer) => port.postMessage(env, transfer ?? []),
            listen: (fn) => {
                handler = (e) => fn(e.data);
                port.addEventListener('message', handler);
            },
            stop: () => {
                port.removeEventListener('message', handler);
                port.close();
            },
        };
    }
    
    
    const RPC = { createNode, workerLink, portLink, messagePortLink };
    
    global.RPC = RPC;
    global.createNode = createNode;
    global.workerLink = workerLink;
    global.portLink = portLink;
    global.messagePortLink = messagePortLink;
    
})(typeof self !== 'undefined' ? self : this);
