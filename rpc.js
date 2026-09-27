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
        const pending = new Map();   // callId -> {resolve, reject, timer}
        const inflight = new Map();  // callId -> AbortController (server side)
        const links = new Map();     // peerId -> link
        const routes = new Map();    // destId -> peerId to forward through
        let seq = 0;
        
        const linkFor = (to) => links.get(routes.get(to) ?? to);
        
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
                    ship({ ns: NS, v: 1, kind: 'res', id: env.id, from: id, to: env.from, hops: 0, error: encodeErr(e) });
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
                return this;
            },

            /** Tear down a neighbour link (removes its listener) and any routes through it. */
            disconnect(peerId) {
                const link = links.get(peerId);
                if (!link) return this;
                link.stop?.();
                links.delete(peerId);
                for (const [dest, via] of routes) {
                    if (via === peerId) routes.delete(dest);
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
                    
                    pending.set(callId, { resolve, reject, timer });
                    
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
            
            waitForLink(key, intervalMs = 50) {
                return new Promise((resolve) => {
                    const check = () => {
                        if (links.has(key)) {
                            resolve(links.get(key));
                        } else {
                            setTimeout(check, intervalMs);
                        }
                    };
                    check();
                });
            },
            
            waitForDirect(id) {
                return new Promise(resolve => {
                    const check = setInterval(() => {
                        if (routes.get(id) === id) {
                            clearInterval(check);
                            resolve();
                        }
                    }, 50);
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

    function windowLink(targetWindow, targetOrigin, { accept = targetOrigin } = {}) {
        let handler;
        return {
            send: (env, transfer) => targetWindow.postMessage(env, targetOrigin, transfer ?? []),
            listen: (fn) => {
                handler = (e) => {
                    if (e.source !== targetWindow) return;
                    if (accept !== '*' && e.origin !== accept) return;
                    fn(e.data);
                };
                globalThis.addEventListener('message', handler);
            },
            stop: () => globalThis.removeEventListener('message', handler),
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
    
    
    const RPC = { createNode, workerLink, windowLink, portLink, messagePortLink };
    
    global.RPC = RPC;
    global.createNode = createNode;
    global.workerLink = workerLink;
    global.windowLink = windowLink;
    global.portLink = portLink;
    global.messagePortLink = messagePortLink;
    
})(typeof self !== 'undefined' ? self : this);
console.log("RPC lib loaded")