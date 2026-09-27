console.debug("streaming_worker.js")
let streaming_worker;

async function spawn_worker() {
    streaming_worker = new Worker("/libs/pyodide-http/pyodide_http/streaming_worker.js");
    await new Promise(resolve => {
        streaming_worker.onmessage = resolve
    });
    return streaming_worker;
}