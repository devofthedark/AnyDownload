// An in-memory stand-in for the part of the Origin Private File System (OPFS) API this extension
// uses. Firefox has no OPFS in private windows (navigator.storage.getDirectory() throws a
// SecurityError), so worker.js keeps downloads here instead. It behaves like OPFS, down to its
// DOMException names and file locks, so dl.py and the merger work on either without knowing which.
(function (global) {
    'use strict';

    // Files are written into fixed-size blocks, so a write anywhere (e.g. a muxer going back to
    // patch a header) is just a copy into the right blocks, and the file never has to be regrown.
    const BLOCK_SIZE = 1 << 20;

    const fail = (name, message) => new DOMException(message, name);

    function allocateBlock() {
        try {
            return new Uint8Array(BLOCK_SIZE);
        } catch (e) {
            if (!(e instanceof RangeError)) throw e;
            // dl.py turns this into ENOSPC, so yt-dlp reports running out of space
            throw fail('QuotaExceededError',
                'Not enough memory for this download. Private windows keep downloads in memory, not on disk.');
        }
    }

    // like OPFS: no empty names, no "." or "..", and no path separators
    function checkName(name) {
        if (typeof name !== 'string' || name === '' || name === '.' || name === '..' || /[/\\]/.test(name)) {
            throw new TypeError(`"${name}" is not a valid name`);
        }
        return name;
    }

    function checkOffset(at) {
        if (!Number.isSafeInteger(at) || at < 0) throw new TypeError(`${at} is not a valid offset`);
        return at;
    }

    function bytesOf(buffer) {
        if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
        if (ArrayBuffer.isView(buffer)) return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        throw new TypeError('expected an ArrayBuffer or a view of one');
    }

    // The bytes of a file while it's being written. Bytes past `size` in the last block are always
    // zero, and blocks never written are holes, so anything between the data and `size` reads as zeros.
    class Blocks {
        constructor() {
            this.blocks = [];
            this.size = 0;
        }

        read(view, at) {
            const n = Math.max(0, Math.min(view.byteLength, this.size - at));
            for (let done = 0; done < n;) {
                const pos = at + done;
                const index = Math.floor(pos / BLOCK_SIZE), offset = pos % BLOCK_SIZE;
                const len = Math.min(BLOCK_SIZE - offset, n - done);
                const block = this.blocks[index];
                if (block) view.set(block.subarray(offset, offset + len), done);
                else view.fill(0, done, done + len);
                done += len;
            }
            return n;
        }

        write(bytes, at) {
            for (let done = 0; done < bytes.byteLength;) {
                const pos = at + done;
                const index = Math.floor(pos / BLOCK_SIZE), offset = pos % BLOCK_SIZE;
                const len = Math.min(BLOCK_SIZE - offset, bytes.byteLength - done);
                const block = this.blocks[index] ??= allocateBlock();
                block.set(bytes.subarray(done, done + len), offset);
                done += len;
            }
            this.size = Math.max(this.size, at + bytes.byteLength);
            return bytes.byteLength;
        }

        truncate(size) {
            if (size < this.size) {
                const kept = Math.ceil(size / BLOCK_SIZE);
                if (this.blocks.length > kept) this.blocks.length = kept;
                // keep the bytes past the end zero, as growing the file again has to read them as zeros
                if (size % BLOCK_SIZE) this.blocks[kept - 1]?.fill(0, size % BLOCK_SIZE);
            }
            this.size = size;
        }

        // Hands the data over to a Blob. Each block becomes its own small Blob and is dropped right
        // away, so the data is never held twice over; joining Blobs references them, not copies them.
        toBlob() {
            const parts = [];
            for (let index = 0; index * BLOCK_SIZE < this.size; index++) {
                const len = Math.min(BLOCK_SIZE, this.size - index * BLOCK_SIZE);
                const block = this.blocks[index];
                parts.push(new Blob([block ? block.subarray(0, len) : new Uint8Array(len)]));
                this.blocks[index] = undefined;
            }
            this.blocks = [];
            return new Blob(parts);
        }

        static async fromBlob(blob) {
            const blocks = new Blocks();
            for (let at = 0; at < blob.size; at += BLOCK_SIZE) {
                blocks.write(new Uint8Array(await blob.slice(at, at + BLOCK_SIZE).arrayBuffer()), at);
            }
            return blocks;
        }
    }

    class DirNode {
        constructor() {
            this.entries = new Map(); // name -> DirNode | FileNode
        }

        locked() {
            for (const entry of this.entries.values()) {
                if (entry.locked()) return true;
            }
            return false;
        }
    }

    // A file's data is either Blocks, while it's being written, or a Blob once something has read
    // it with getFile(). That's the Blob the merger reads and the panel saves, so neither copies it.
    class FileNode {
        constructor() {
            this.blocks = new Blocks();
            this.blob = null;
            this.lastModified = Date.now();
            // as in OPFS: a sync access handle locks the file for itself, writable streams share it
            this.syncHandle = false;
            this.writers = 0;
        }

        locked() {
            return this.syncHandle || this.writers > 0;
        }

        freeze() {
            if (!this.blob) {
                this.blob = this.blocks.toBlob();
                this.blocks = null;
            }
            return this.blob;
        }

        // back to Blocks, to be written to again
        async thaw() {
            if (this.blob) {
                this.blocks = await Blocks.fromBlob(this.blob);
                this.blob = null;
            }
        }
    }

    // Like OPFS's, a handle points at a path rather than at an entry, so it finds whatever is there
    // now: after a remove it gets NotFoundError, and after a re-create it gets the new entry.
    class MemoryHandle {
        #root;
        #path;

        constructor(root, path) {
            this.#root = root;
            this.#path = path;
        }

        get name() {
            return this.#path.length ? this.#path[this.#path.length - 1] : '';
        }

        _entry() {
            let node = this.#root;
            for (const name of this.#path) {
                const next = node instanceof DirNode ? node.entries.get(name) : undefined;
                if (!next) throw fail('NotFoundError', `"${this.#path.join('/')}" could not be found`);
                node = next;
            }
            const kind = node instanceof DirNode ? 'directory' : 'file';
            if (kind !== this.kind) throw fail('TypeMismatchError', `"${this.#path.join('/')}" is a ${kind}`);
            return node;
        }

        _parent() {
            return new MemoryDirectoryHandle(this.#root, this.#path.slice(0, -1))._entry();
        }

        _child(name) {
            return [this.#root, [...this.#path, name]];
        }

        _rename(name) {
            this.#path = [...this.#path.slice(0, -1), name];
        }

        async isSameEntry(other) {
            return other instanceof MemoryHandle && other.kind === this.kind
                && other.#root === this.#root && other.#path.join('/') === this.#path.join('/');
        }
    }

    class MemoryDirectoryHandle extends MemoryHandle {
        get kind() {
            return 'directory';
        }

        async getDirectoryHandle(name, { create = false } = {}) {
            return this.#open(name, create, DirNode, MemoryDirectoryHandle);
        }

        async getFileHandle(name, { create = false } = {}) {
            return this.#open(name, create, FileNode, MemoryFileHandle);
        }

        #open(name, create, Node, Handle) {
            checkName(name);
            const dir = this._entry();
            const entry = dir.entries.get(name);
            if (entry && !(entry instanceof Node)) {
                throw fail('TypeMismatchError', `"${name}" is a ${entry instanceof DirNode ? 'directory' : 'file'}`);
            }
            if (!entry) {
                if (!create) throw fail('NotFoundError', `"${name}" could not be found`);
                dir.entries.set(name, new Node());
            }
            return new Handle(...this._child(name));
        }

        async removeEntry(name, { recursive = false } = {}) {
            checkName(name);
            const dir = this._entry();
            const entry = dir.entries.get(name);
            if (!entry) throw fail('NotFoundError', `"${name}" could not be found`);
            if (entry instanceof DirNode && entry.entries.size && !recursive) {
                throw fail('InvalidModificationError', `"${name}" is not empty`);
            }
            if (entry.locked()) throw fail('NoModificationAllowedError', `"${name}" is in use`);
            dir.entries.delete(name);
        }

        async *entries() {
            // a snapshot, so removing entries while iterating is fine
            for (const [name, entry] of [...this._entry().entries]) {
                const Handle = entry instanceof DirNode ? MemoryDirectoryHandle : MemoryFileHandle;
                yield [name, new Handle(...this._child(name))];
            }
        }

        async *keys() {
            for await (const [name] of this.entries()) yield name;
        }

        async *values() {
            for await (const [, handle] of this.entries()) yield handle;
        }

        [Symbol.asyncIterator]() {
            return this.entries();
        }
    }

    class MemoryFileHandle extends MemoryHandle {
        get kind() {
            return 'file';
        }

        async getFile() {
            const node = this._entry();
            if (node.syncHandle) throw fail('NoModificationAllowedError', `"${this.name}" is in use`);
            return new File([node.freeze()], this.name, { lastModified: node.lastModified });
        }

        async createSyncAccessHandle() {
            const node = this._entry();
            if (node.locked()) throw fail('NoModificationAllowedError', `"${this.name}" is in use`);
            // locked before the await below, so nothing else can open or remove it meanwhile
            node.syncHandle = true;
            try {
                await node.thaw();
            } catch (e) {
                node.syncHandle = false;
                throw e;
            }
            return new MemorySyncAccessHandle(node);
        }

        // Like OPFS's, the stream writes to a copy that replaces the file only when it's closed.
        async createWritable({ keepExistingData = false } = {}) {
            const node = this._entry();
            if (node.syncHandle) throw fail('NoModificationAllowedError', `"${this.name}" is in use`);
            node.writers++;
            let data;
            try {
                data = keepExistingData ? await Blocks.fromBlob(node.freeze()) : new Blocks();
            } catch (e) {
                node.writers--;
                throw e;
            }
            let position = 0;
            let done = false;
            const release = () => {
                if (!done) node.writers--;
                done = true;
            };
            const write = async (chunk, at = position) => {
                const pos = checkOffset(at);
                const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk)
                    : chunk instanceof Blob ? new Uint8Array(await chunk.arrayBuffer())
                    : bytesOf(chunk);
                position = pos + data.write(bytes, pos);
            };
            return new WritableStream({
                async write(chunk) {
                    try {
                        if (chunk?.type === 'write') return await write(chunk.data, chunk.position);
                        if (chunk?.type === 'seek') {
                            position = checkOffset(chunk.position);
                            return;
                        }
                        if (chunk?.type === 'truncate') {
                            data.truncate(checkOffset(chunk.size));
                            position = Math.min(position, chunk.size);
                            return;
                        }
                        return await write(chunk);
                    } catch (e) {
                        // a failed write errors the stream, and then neither close() nor abort() gets here
                        release();
                        throw e;
                    }
                },
                close() {
                    release();
                    node.blocks = data;
                    node.blob = null;
                    node.lastModified = Date.now();
                },
                abort() {
                    release();
                },
            });
        }

        async move(newName) {
            if (typeof newName !== 'string') throw new TypeError('only renaming within the directory is supported');
            checkName(newName);
            const node = this._entry();
            if (newName === this.name) return;
            if (node.locked()) throw fail('NoModificationAllowedError', `"${this.name}" is in use`);
            const dir = this._parent();
            const existing = dir.entries.get(newName);
            if (existing instanceof DirNode) throw fail('InvalidModificationError', `"${newName}" is a directory`);
            if (existing?.locked()) throw fail('NoModificationAllowedError', `"${newName}" is in use`);
            dir.entries.delete(this.name);
            dir.entries.set(newName, node);
            this._rename(newName);
        }
    }

    // Synchronous, like OPFS's FileSystemSyncAccessHandle, which dl.py calls without awaiting
    class MemorySyncAccessHandle {
        #node;
        #position = 0;
        #closed = false;

        constructor(node) {
            this.#node = node;
        }

        #open() {
            if (this.#closed) throw fail('InvalidStateError', 'the access handle is closed');
            return this.#node;
        }

        read(buffer, { at } = {}) {
            const node = this.#open();
            const pos = at === undefined ? this.#position : checkOffset(at);
            const n = node.blocks.read(bytesOf(buffer), pos);
            this.#position = pos + n;
            return n;
        }

        write(buffer, { at } = {}) {
            const node = this.#open();
            const pos = at === undefined ? this.#position : checkOffset(at);
            const n = node.blocks.write(bytesOf(buffer), pos);
            node.lastModified = Date.now();
            this.#position = pos + n;
            return n;
        }

        getSize() {
            return this.#open().blocks.size;
        }

        truncate(size) {
            const node = this.#open();
            node.blocks.truncate(checkOffset(size));
            node.lastModified = Date.now();
            this.#position = Math.min(this.#position, size);
        }

        flush() {
            this.#open();
        }

        close() {
            if (this.#closed) return;
            this.#closed = true;
            this.#node.syncHandle = false;
        }
    }

    // A new, empty root: what navigator.storage.getDirectory() returns
    global.createMemoryRoot = () => new MemoryDirectoryHandle(new DirNode(), []);
})(globalThis);
