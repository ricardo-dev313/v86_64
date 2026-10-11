import { h, Bitmap } from "./lib.js";
import { dbg_assert, dbg_log } from "./log.js";
import { CPU } from "./cpu.js";

const STATE_VERSION = 6;
const STATE_MAGIC = 0x86768676|0;
const STATE_INDEX_MAGIC = 0;
const STATE_INDEX_VERSION = 1;
const STATE_INDEX_TOTAL_LEN = 2;
const STATE_INDEX_INFO_LEN = 3;
const STATE_INFO_BLOCK_START = 16;

const ZSTD_MAGIC = 0xFD2FB528;

/** @constructor */
function StateLoadError(msg)
{
    this.message = msg;
}
StateLoadError.prototype = new Error;

const CONSTRUCTOR_TABLE = {
    "Map": Map,
    "Uint8Array": Uint8Array,
    "Int8Array": Int8Array,
    "Uint16Array": Uint16Array,
    "Int16Array": Int16Array,
    "Uint32Array": Uint32Array,
    "Int32Array": Int32Array,
    "Float32Array": Float32Array,
    "Float64Array": Float64Array,
};

function save_object(obj, saved_buffers)
{
    if(typeof obj !== "object" || obj === null)
    {
        dbg_assert(typeof obj !== "function");
        return obj;
    }

    if(Array.isArray(obj))
    {
        return obj.map(x => save_object(x, saved_buffers));
    }

    if(obj instanceof Map)
    {
        return {
            "__state_type__": "Map",
            "args": Array.from(obj.entries()).map(([k, v]) => [
                save_object(k, saved_buffers),
                save_object(v, saved_buffers),
            ]),
        };
    }

    if(obj.constructor === Object)
    {
        console.log(obj);
        dbg_assert(obj.constructor !== Object, "Expected non-object");
    }

    if(obj.BYTES_PER_ELEMENT)
    {
        // Uint8Array, etc.
        var buffer = new Uint8Array(obj.buffer, obj.byteOffset, obj.length * obj.BYTES_PER_ELEMENT);

        const constructor = obj.constructor.name.replace("bound ", "");

        dbg_assert(CONSTRUCTOR_TABLE[constructor]);

        return {
            "__state_type__": constructor,
            "buffer_id": saved_buffers.push(buffer) - 1,
        };
    }

    if(DEBUG && !obj.get_state)
    {
        console.log("Object without get_state: ", obj);
    }

    var state = obj.get_state();
    var result = [];

    for(var i = 0; i < state.length; i++)
    {
        var value = state[i];

        dbg_assert(typeof value !== "function");

        result[i] = save_object(value, saved_buffers);
    }

    return result;
}

function restore_buffers(obj, buffers)
{
    if(typeof obj !== "object" || obj === null)
    {
        dbg_assert(typeof obj !== "function");
        return obj;
    }

    if(Array.isArray(obj))
    {
        for(let i = 0; i < obj.length; i++)
        {
            obj[i] = restore_buffers(obj[i], buffers);
        }

        return obj;
    }

    const type = obj["__state_type__"];
    dbg_assert(type !== undefined);

    const constructor = CONSTRUCTOR_TABLE[type];
    dbg_assert(constructor, "Unkown type: " + type);

    if(obj["args"] !== undefined) {
        return new constructor(obj["args"]);
    }

    const buffer = buffers[obj["buffer_id"]];
    return new constructor(buffer);
}

function read_state_header(state, check_length)
{
    const len = state.length;

    if(len < STATE_INFO_BLOCK_START)
    {
        throw new StateLoadError("Invalid length: " + len);
    }

    const header_block = new Int32Array(state.buffer, state.byteOffset, 4);

    if(header_block[STATE_INDEX_MAGIC] !== STATE_MAGIC)
    {
        throw new StateLoadError("Invalid header: " + h(header_block[STATE_INDEX_MAGIC] >>> 0));
    }

    if(header_block[STATE_INDEX_VERSION] !== STATE_VERSION)
    {
        throw new StateLoadError(
                "Version mismatch: dump=" + header_block[STATE_INDEX_VERSION] +
                " we=" + STATE_VERSION);
    }

    if(check_length && header_block[STATE_INDEX_TOTAL_LEN] !== len)
    {
        throw new StateLoadError(
                "Length doesn't match header: " +
                "real=" + len + " header=" + header_block[STATE_INDEX_TOTAL_LEN]);
    }

    return header_block[STATE_INDEX_INFO_LEN];
}

function read_info_block(info_block_buffer)
{
    const info_block = new TextDecoder().decode(info_block_buffer);
    return JSON.parse(info_block);
}

/* @param {CPU} cpu */
export function save_state(cpu)
{
    var saved_buffers = [];
    var state = save_object(cpu, saved_buffers);

    var buffer_infos = [];
    var total_buffer_size = 0;

    for(var i = 0; i < saved_buffers.length; i++)
    {
        var len = saved_buffers[i].byteLength;

        buffer_infos[i] = {
            offset: total_buffer_size,
            length: len,
        };

        total_buffer_size += len;

        // align
        total_buffer_size = total_buffer_size + 3 & ~3;
    }

    var info_object = JSON.stringify({
        "buffer_infos": buffer_infos,
        "state": state,
    });
    var info_block = new TextEncoder().encode(info_object);

    var buffer_block_start = STATE_INFO_BLOCK_START + info_block.length;
    buffer_block_start = buffer_block_start + 3 & ~3;
    var total_size = buffer_block_start + total_buffer_size;

    //console.log("State: json_size=" + Math.ceil(buffer_block_start / 1024 / 1024) + "MB " +
    //               "buffer_size=" + Math.ceil(total_buffer_size / 1024 / 1024) + "MB");

    var result = new ArrayBuffer(total_size);

    var header_block = new Int32Array(
        result,
        0,
        STATE_INFO_BLOCK_START / 4
    );
    new Uint8Array(result, STATE_INFO_BLOCK_START, info_block.length).set(info_block);
    var buffer_block = new Uint8Array(
        result,
        buffer_block_start
    );

    header_block[STATE_INDEX_MAGIC] = STATE_MAGIC;
    header_block[STATE_INDEX_VERSION] = STATE_VERSION;
    header_block[STATE_INDEX_TOTAL_LEN] = total_size;
    header_block[STATE_INDEX_INFO_LEN] = info_block.length;

    for(var i = 0; i < saved_buffers.length; i++)
    {
        var buffer = saved_buffers[i];
        dbg_assert(buffer.constructor === Uint8Array);
        buffer_block.set(buffer, buffer_infos[i].offset);
    }

    dbg_log("State: json size " + (info_block.byteLength >> 10) + "k");
    dbg_log("State: Total buffers size " + (buffer_block.byteLength >> 10) + "k");

    return result;
}

/* @param {CPU} cpu */
export function restore_state(cpu, state)
{
    state = new Uint8Array(state);

    if(new Uint32Array(state.buffer, 0, 1)[0] === ZSTD_MAGIC)
    {
        const ctx = cpu.zstd_create_ctx(state.length);

        new Uint8Array(cpu.wasm_memory.buffer, cpu.zstd_get_src_ptr(ctx) >>> 0, state.length).set(state);

        let ptr = cpu.zstd_read(ctx, 16);
        const header_block = new Uint8Array(cpu.wasm_memory.buffer, ptr >>> 0, 16);
        const info_block_len = read_state_header(header_block, false);
        cpu.zstd_read_free(ptr, 16);

        ptr = cpu.zstd_read(ctx, info_block_len);
        const info_block_buffer = new Uint8Array(cpu.wasm_memory.buffer, ptr >>> 0, info_block_len);
        const info_block_obj = read_info_block(info_block_buffer);
        cpu.zstd_read_free(ptr, info_block_len);

        let state_object = info_block_obj["state"];
        const buffer_infos = info_block_obj["buffer_infos"];
        const buffers = [];

        let position = STATE_INFO_BLOCK_START + info_block_len;

        for(const buffer_info of buffer_infos)
        {
            const front_padding = (position + 3 & ~3) - position;
            const CHUNK_SIZE = 1 * 1024 * 1024;

            if(buffer_info.length > CHUNK_SIZE)
            {
                const ptr = cpu.zstd_read(ctx, front_padding) >>> 0;
                cpu.zstd_read_free(ptr, front_padding);

                const buffer = new Uint8Array(buffer_info.length);
                buffers.push(buffer.buffer);

                let have = 0;
                while(have < buffer_info.length)
                {
                    const remaining = buffer_info.length - have;
                    dbg_assert(remaining >= 0);
                    const to_read = Math.min(remaining, CHUNK_SIZE);

                    const ptr = cpu.zstd_read(ctx, to_read);
                    buffer.set(new Uint8Array(cpu.wasm_memory.buffer, ptr >>> 0, to_read), have);
                    cpu.zstd_read_free(ptr, to_read);

                    have += to_read;
                }
            }
            else
            {
                const ptr = cpu.zstd_read(ctx, front_padding + buffer_info.length);
                const offset = (ptr >>> 0) + front_padding;
                buffers.push(cpu.wasm_memory.buffer.slice(offset, offset + buffer_info.length));
                cpu.zstd_read_free(ptr, front_padding + buffer_info.length);
            }

            position += front_padding + buffer_info.length;
        }

        state_object = restore_buffers(state_object, buffers);
        cpu.set_state(state_object);

        cpu.zstd_free_ctx(ctx);
    }
    else
    {
        const info_block_len = read_state_header(state, true);

        if(info_block_len < 0 || info_block_len + 12 >= state.length)
        {
            throw new StateLoadError("Invalid info block length: " + info_block_len);
        }

        const info_block_buffer = state.subarray(STATE_INFO_BLOCK_START, STATE_INFO_BLOCK_START + info_block_len);
        const info_block_obj = read_info_block(info_block_buffer);
        let state_object = info_block_obj["state"];
        const buffer_infos = info_block_obj["buffer_infos"];
        let buffer_block_start = STATE_INFO_BLOCK_START + info_block_len;
        buffer_block_start = buffer_block_start + 3 & ~3;

        const buffers = buffer_infos.map(buffer_info => {
            const offset = buffer_block_start + buffer_info.offset;
            return state.buffer.slice(offset, offset + buffer_info.length);
        });

        state_object = restore_buffers(state_object, buffers);
        cpu.set_state(state_object);
    }
}

/**
 * Restore a state that arrives in chunks (zstd-compressed or not), such as the body of a
 * fetch, without ever holding the whole state: the chunks are decompressed through two fixed
 * buffers and the pages of guest memory are written to their place as they come out. Pages
 * that are zero in the state are left alone when they are zero already, so that the host
 * doesn't commit them. The emulator must not be running.
 *
 * States saved before the page bitmap was stored ahead of the pages still load, with the
 * packed memory held in one buffer.
 *
 * @param {CPU} cpu
 * @param {!Object} chunks An async iterable of Uint8Array (a ReadableStream, a node stream)
 * @param {function(number)=} on_progress Called with the number of bytes consumed so far
 */
export async function restore_state_stream(cpu, chunks, on_progress)
{
    const iterator = chunks[Symbol.asyncIterator] ? chunks[Symbol.asyncIterator]() : null;
    const reader = iterator ? null : chunks["getReader"]();

    let chunk = new Uint8Array(0);
    let chunk_pos = 0;
    let consumed = 0;

    async function next_chunk()
    {
        for(;;)
        {
            const result = iterator ? await iterator.next() : await reader.read();
            if(result.done)
            {
                return false;
            }
            if(result.value.length)
            {
                chunk = result.value;
                chunk_pos = 0;
                return true;
            }
        }
    }

    if(!await next_chunk() || chunk.length < 4)
    {
        throw new StateLoadError("Invalid length: " + chunk.length);
    }

    const compressed = (chunk[0] | chunk[1] << 8 | chunk[2] << 16 | chunk[3] << 24) >>> 0 === ZSTD_MAGIC;
    const stream = compressed ? cpu.zstd_stream_create() : 0;
    const stream_buffer_size = compressed ? cpu.zstd_stream_buffer_size() : 0;

    // decompressed bytes that haven't been handed out yet: out[out_pos..out_end]
    let out = chunk;
    let out_pos = 0;
    let out_end = compressed ? 0 : chunk.length;
    // offset in the decompressed state
    let position = 0;

    if(!compressed)
    {
        chunk_pos = chunk.length;
        consumed = chunk.length;
    }

    async function refill()
    {
        if(!compressed)
        {
            if(!await next_chunk())
            {
                return false;
            }
            out = chunk;
            out_pos = 0;
            out_end = chunk.length;
            consumed += chunk.length;
            on_progress && on_progress(consumed);
            return true;
        }

        for(;;)
        {
            const produced = cpu.zstd_stream_decompress(stream);
            if(produced < 0)
            {
                throw new StateLoadError("Invalid zstd stream");
            }
            if(produced > 0)
            {
                out = new Uint8Array(cpu.wasm_memory.buffer, cpu.zstd_stream_dst_ptr(stream) >>> 0, produced);
                out_pos = 0;
                out_end = produced;
                return true;
            }

            dbg_assert(cpu.zstd_stream_input_left(stream) === 0);
            if(chunk_pos === chunk.length && !await next_chunk())
            {
                return false;
            }
            const length = Math.min(stream_buffer_size, chunk.length - chunk_pos);
            new Uint8Array(cpu.wasm_memory.buffer, cpu.zstd_stream_src_ptr(stream) >>> 0, length)
                .set(chunk.subarray(chunk_pos, chunk_pos + length));
            cpu.zstd_stream_set_input(stream, length);
            chunk_pos += length;
            consumed += length;
            on_progress && on_progress(consumed);
        }
    }

    // get_target is called again after each wait: a view of the wasm memory doesn't survive
    // the memory growing. Without a target the bytes are skipped.
    async function read(get_target, offset, length)
    {
        while(length)
        {
            if(out_pos === out_end && !await refill())
            {
                throw new StateLoadError("Unexpected end of state at " + position);
            }
            const n = Math.min(length, out_end - out_pos);
            if(get_target)
            {
                get_target().set(out.subarray(out_pos, out_pos + n), offset);
            }
            out_pos += n;
            offset += n;
            length -= n;
            position += n;
        }
    }

    async function read_buffer(length)
    {
        const buffer = new Uint8Array(length);
        await read(() => buffer, 0, length);
        return buffer;
    }

    try
    {
        const info_block_len = read_state_header(await read_buffer(STATE_INFO_BLOCK_START), false);
        const info_block_obj = read_info_block(await read_buffer(info_block_len));
        let state_object = info_block_obj["state"];
        const buffer_infos = info_block_obj["buffer_infos"];

        // CPU.prototype.get_state: 76 is the bitmap of non-zero pages, 77 the pages
        const bitmap_id = state_object[76] ? state_object[76]["buffer_id"] : -1;
        const memory_id = state_object[77]["buffer_id"];
        const place_pages = bitmap_id >= 0 && bitmap_id < memory_id;
        const buffers = [];

        for(let i = 0; i < buffer_infos.length; i++)
        {
            await read(null, 0, (position + 3 & ~3) - position);

            if(i === memory_id && place_pages)
            {
                if(state_object[0] !== cpu.memory_size[0])
                {
                    throw new StateLoadError(
                        "Memory size mismatch: state=" + state_object[0] + " we=" + cpu.memory_size[0]);
                }

                const bitmap = new Bitmap(buffers[bitmap_id]);
                const page_count = cpu.memory_size[0] / 0x1000;

                for(let page = 0; page < page_count;)
                {
                    if(bitmap.get(page))
                    {
                        let end = page + 1;
                        while(end < page_count && bitmap.get(end))
                        {
                            end++;
                        }
                        await read(() => cpu.mem8, page * 0x1000, (end - page) * 0x1000);
                        page = end;
                    }
                    else
                    {
                        cpu.zero_page_if_needed(page);
                        page++;
                    }
                }

                buffers.push(null);
                state_object[77] = null;
            }
            else
            {
                buffers.push((await read_buffer(buffer_infos[i].length)).buffer);
            }
        }

        state_object = restore_buffers(state_object, buffers);
        cpu.set_state(state_object);
    }
    finally
    {
        if(compressed)
        {
            cpu.zstd_stream_free(stream);
        }
    }
}
